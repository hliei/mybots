# Development

## Tooling status

The host, Agent runner and shared mailbox npm workspace use a root lockfile.
`package.json` scripts and tool configuration files are authoritative for command
details and scope. See
[README](../../README.md) for installation and startup instructions.

## Technical baseline

- Use TypeScript with Node.js 24.21.0. The host is the root npm package; the
  Agent runner is `container/agent-runner`, an npm workspace with its own SDK
  dependencies and compilation boundary. Its production container uses Bun 1.4.0;
  Node remains the offline SDK-development and host runtime. `src/mailbox` is a
  shared npm workspace with explicit `/node` and `/bun` entries using static
  native SQLite imports. Its root entry has no SQLite runtime import. The runner
  pins `@types/bun` and enables Bun types in its own TypeScript project; the host
  uses Node types and excludes the Bun entry from its compilation. Install all
  packages from the root.
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
- Keep host source in `src/` and runner source in `container/agent-runner/src/`.
  Type-check source, tests, and TypeScript configuration files; compile host
  source into `dist/` and runner source into `container/agent-runner/dist/`.
- Ignore dependencies, build output, coverage output, local credentials, and
  runtime data. Keep source, tests, configuration, and the lockfile in Git.

## Code conventions

- Keep agent execution, terminal interaction, and message-platform handling in
  separate modules. The CLI is a client of the persistent host; the bot still embeds its existing runtime.
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

## Command contract

| Script | Required behavior |
| --- | --- |
| `dev:host` | Run the persistent host from TypeScript source. |
| `dev:cli` | Run the interactive CLI from TypeScript source. |
| `dev:bot` | Run the bot server from TypeScript source. |
| `typecheck` | Check host source, tests, configuration and runner source without emitting files. |
| `check` | Check formatting, lint, and types without modifying files; do not run tests or build. |
| `format` | Apply formatting fixes. |
| `test` | Run all ordinary offline tests once and exit. |
| `test:watch` | Watch files and rerun ordinary offline tests. |
| `build` | Compile host and runner source into their separate `dist/` directories. |
| `start:host` | Run the built persistent host with Node.js. |
| `start:cli` | Run the built CLI with Node.js. |
| `start:bot` | Run the built bot server with Node.js. |
| `verify` | Run `check`, ordinary tests, build, and an offline startup smoke check for each entry point. |

Development commands run source without building or watching; restart manually
after code changes. Start commands use the existing build; they do not build
automatically. Startup smoke checks must exit without live credentials and cover
executable entry points, not only imports.
The offline startup checks also execute the compiled Pi provider against a local
streaming model service through `scripts/pi-session-demo.mjs`. `npm run demo:pi`
builds and runs this demonstration separately. It exercises SDK-owned tools and
explicit conversation reopening without credentials or container infrastructure.

The startup checks also run the compiled host/CLI mailbox fixture demonstration
for persistent affinity, reconnect and host restart, plus missing-host/settings
failures. Run `npm run demo:host` for visible evidence. It does not require Docker
or model credentials.

Introduce a separate live-test script when live-service checks are implemented;
keep it outside `test`, `test:watch`, and `verify`.

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
execution. These checks need Docker and `openssl`, but no real account credentials.
See [container runtime](../container-runtime.md) for fixed mounts, gateway
configuration, cleanup and accepted completion behavior.
