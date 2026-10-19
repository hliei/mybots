# Development

## Tooling status

The host, Agent runner, shared mailbox and browser client npm workspaces use a root lockfile.
`package.json` scripts and tool configuration files are authoritative for command
details and scope. See
[README](../../README.md) for installation and startup instructions.

## Technical baseline

- Use TypeScript with Node.js 24.21.0. The root npm package owns repository
  tooling and commands. `packages/host`, `packages/agent-runner` and
  `packages/mailbox` are independent workspaces installed from the root lockfile.
  `packages/client` contains the browser-only status UI and compiles with DOM types.
  Host dependencies belong to the host package; Pi SDK and web-tool dependencies
  belong to the runner. The production runner uses Bun 1.4.0; Node remains the
  offline SDK-development and host runtime.
- The mailbox root export has no SQLite runtime import. Its `/node` and `/bun`
  entries statically import their respective native SQLite drivers. Host source
  uses only the root and Node entries through `@mybots/mailbox` package imports.
  Mailbox and runner type checking enable pinned Bun types in their own projects;
  the host project uses Node types. See
  [mailbox resolution](../container-runtime.md#mailbox-package-resolution).
- Use npm and commit `package-lock.json` with dependency changes.
- Pin the supported Node.js baseline and direct dependency versions during
  tooling setup. Keep local development and CI on the same baseline.
- Use ESM, strict TypeScript checking, and explicit type-only imports.
- Use `.ts` extensions for relative TypeScript imports. Configure `tsc` to
  rewrite those extensions to `.js` in build output, and verify Node.js can
  execute the result.
- Use Node.js native type stripping for development and keep TypeScript syntax
  erasable. Use `tsc` for type checking and compilation, Vitest for tests, and
  Biome for formatting and linting.
- Keep host source in `packages/host/src/` and runner source in `packages/agent-runner/src/`.
  Type-check source, tests, and TypeScript configuration files; compile host
  source into `packages/host/dist/`, runner source into
  `packages/agent-runner/dist/`, mailbox source into `packages/mailbox/dist/`, and client assets into
  `packages/client/dist/`.
- Ignore dependencies, build output, coverage output, local credentials, and
  runtime data. Keep source, tests, configuration, and the lockfile in Git.

## Code conventions

- Keep agent execution, terminal interaction, and message-platform handling in
  separate modules. The CLI is a client of the persistent host and the owner-local
  WebSocket interface is a host channel. `packages/host/src/index.ts` is the sole host startup
  entry point and composes all three channel services. The independent CLI entry
  is `packages/host/src/cli/client.ts`: it parses arguments and starts `chat.ts` for terminal
  interaction. `socket-client.ts` owns the CLI socket protocol; `socket-server.ts`
  owns the host-side CLI listener. All four modules live under `packages/host/src/cli/`.
  The Telegram Bot API boundary in `packages/host/src/channels/telegram-api.ts` serves the
  owner-only private-chat channel, which routes accepted input through the common
  host path and keeps the token host-side.
- Keep platform SDK details at the platform boundary and model SDK details at
  the model boundary. Core behavior must be testable without live credentials.
- Prefer explicit types at module boundaries. Use `unknown` for unvalidated
  external input; narrow or validate it before use. Use `any` only when required
  by an external API, with a local explanation.
- Check installed dependency types and documentation before using an API.
- Keep changes within the requested behavior. Add abstractions when an actual
  use requires them; keep unrelated cleanup separate.
- Keep process startup at entry points so importing a module for testing does
  not open connections or start background workers.
- Give long-running resources an explicit cleanup path. Define cancellation,
  message ordering, and failure behavior when introducing asynchronous work.

Active Run queries accept durable steering at permitted SDK boundaries. Queue
insertion alone is not consumption; SDK recording precedes mailbox evidence.
Query shutdown closes admission and awaits polling/SDK cleanup. One actual
Attempt per Bot holds capacity until confirmed stop; other Bots may progress.
Execution and per-Run delivery progress independently. See
[container execution](../container-runtime.md) for event and failure mapping.

## Command contract

| Script | Required behavior |
| --- | --- |
| `dev` | Run the persistent host from TypeScript source. |
| `mbt` | Run the source CLI through `bin/mbt`: interactive socket chat by default, or installed-service Web startup with `start`. |
| `typecheck` | Check all four workspaces, root tests and configuration without emitting files. |
| `check` | Check formatting, lint, and types without modifying files; do not run tests or build. |
| `format` | Apply formatting fixes. |
| `test` | Run all ordinary offline tests once and exit. |
| `test:watch` | Watch files and rerun ordinary offline tests. |
| `build` | Clean generated output, then compile all four workspaces into their separate `dist/` directories. |
| `start` | Run the built persistent host with Node.js. |
| `verify` | Run `check`, ordinary tests, build, an offline startup smoke check for each entry point, and the built-client browser journey. |

`dev` selects the mailbox `mybots-source` export condition and runs host source
without building or watching; restart manually after
changes. `start` uses the existing host build without rebuilding. `mbt` runs the
CLI source with Node.js native TypeScript support. The root package's executable
`bin/mbt` exposes that same source client after `npm link --workspaces=false`,
resolving npm symlinks while preserving the caller's current directory and preferring
`.tools/node/bin/node`. `mbt start` uses the linked installation as its default root,
starts its existing service without restarting a healthy Host, waits for an
authenticated local API response, then opens the configured Web UI. Only startup
loads Host configuration and its mailbox validation dependency; terminal chat,
help and exit remain usable without workspace build output. Terminal chat
keeps its caller-directory default. `mbt exit` uses the same installation default,
stops its service and waits for session-container cleanup, retaining saved data and
the shared gateway. Start and exit share a kernel-released lock in
`data/service-control.lock`; they never lock the Host's domain database. Startup
smoke checks must exit without live credentials and cover executable entry points,
not only imports.
The offline startup checks also execute the compiled Pi provider against a local
streaming model service through `scripts/pi-session-demo.mjs`. `npm run demo:pi`
builds mailbox and runner, then runs this demonstration separately. It exercises SDK-owned tools and
explicit conversation reopening without credentials or container infrastructure.

The startup checks also run the compiled host/CLI mailbox fixture demonstration
for persistent affinity, reconnect and host restart, plus missing-host/settings
failures. Run `npm run demo:host` for visible evidence. It does not require Docker
or model credentials.

The retired embedded-runtime live harness and `test:live` command are removed.
Actual-service checks use the manual opt-in
[macOS acceptance procedure](../macos-service-acceptance.md), outside `test`,
`test:watch`, and `verify`. The procedure does not establish a live pass until
its deployment evidence is recorded.

## Validation and completion

1. Define the expected behavior and use the workflow in
   [Testing](testing.md) for application changes.
2. During development, run affected test files and type checking. After code
   changes, run `check` and fix reported problems.
3. Before delivering application or tooling changes, run `verify`. For tooling
   setup, also exercise development startup and test watching. Use the same
   verification script in CI; `.github/workflows/ci.yml` also runs
   `bash tests/workflow.sh` in isolated temporary repositories.
4. For documentation-only changes, check content, relative links, and agreement
   with the actual tooling state. Follow
   [Git workflow](git-workflow.md#validation-and-delivery) for other checks.
5. Report behavior changes and validation results. If tooling or a required
   external service is unavailable, state which checks remain unverified.

Update affected documentation and tests with the behavior they describe.
Delivery is complete when applicable checks pass and no required validation is
left unexplained. A passing test run does not replace type checking or running
the compiled program.

## Container execution

`container/Dockerfile` pins Node 24.21.0 for reproducible npm installation and
Bun 1.4.0 for the production runner. The image includes only runner dependencies,
runner source and shared mailbox code. Build with `docker build -t
mybots-agent:mailbox -f container/Dockerfile .`. Run the separate opt-in
`npm run test:infrastructure` for mounted SQLite, proxy/TLS and controlled Pi
execution, including a scoped web-search gateway target. These checks need Docker
and `openssl`, but no real account credentials.
See [container runtime](../container-runtime.md) for fixed mounts, gateway
configuration, cleanup and accepted completion behavior.

## Host lifecycle recovery

The host claims each session with a fenced incarnation recorded in
`session_claims` and registers its own live instance in `host_instances`.
Startup reconciliation reads persisted sessions and the runtime containers the
driver observes, adopting a running container or replacing abandoned execution.
An abandoned `processing` claim is retried with waits of 5, 10, 20, 40 and 80
seconds and then reaches an explicit failed state; completed input is never
redelivered. The same schedule bounds input a container never claimed, so a
crash before processing cannot restart forever. A running container with a stale
heartbeat, or one that claimed input and then went silent, is stopped and its
unfinished work recovered under the same policy. `Host.reconcile()` runs this pass on demand and the host also
runs it periodically. Retrying unfinished input can repeat tool effects;
exactly-once execution and delivery are not provided. See
[host runtime](../host-runtime.md#interrupted-execution-recovery).

## Agent resources and context

The host persists `agent.resources` (selected Skill IDs and SDK built-in or
configured web tool names) and optional `agent.web` provider/endpoint selection
separately from model configuration. Provisioning copies only that
non-secret selection into immutable runner context. The runner loads the shared
workspace's `AGENTS.md` and selected `skills/<id>/SKILL.md` with Pi's resource
loader when opening a query. Default personal/ancestor resource discovery,
extensions, prompt templates, themes and file-backed SDK settings stay disabled.
Selecting `web_search` or `fetch_content` registers the matching Pi custom tool
inside the container; the real search credential stays gateway-owned and is
injected only for the configured endpoint's hostname.
Shared instruction/Skill file changes take effect on the next query, after the
current query and SDK cleanup finish; queued follow-ups retain their query's
resources. Changing the configured selection requires stopped execution and
explicit replacement of immutable context, as with model configuration.

Pi owns Run-local automatic compaction, summaries and reopening. The Host selects
bounded original Thread references for each new Run. Legacy `/reset` is rejected;
prospective Thread background reset is delivered separately without replacing
existing Run ledgers.
