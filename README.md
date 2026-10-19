# Mybots

A personal assistant with one persistent host, isolated Agent session containers,
and a shared Agent workspace. CLI, owner-only Telegram private chats and the local
WebSocket interface use separate persistent conversations with the same Agent.
Pi owns model/tool execution, Skills, conversation history and compaction.

## Install and start

The git checkout is the install root. From that directory:

```sh
bash mybots.sh
```

The script checks memory, platform, and Docker, then installs Node.js 24.21.0 when the current `node` is not that version, installs dependencies, and runs the setup wizard. The wizard builds the runner image, prepares OneCLI, asks for the model API key, writes `.env` and a generated `host.json`, installs a background service, and can pair one Telegram private chat.

Node.js downloads show progress and retry up to two times on transfer failure.
Extraction starts only after the download succeeds.

`.env` holds operator settings and the Telegram bot token. Model and search API keys are registered in OneCLI and are not written to `.env`. See [configuration](docs/configuration.md) for the variable names. `.env.example` lists the names with empty values.

The same second half, after Node.js 24.21.0 is on `PATH`:

```sh
npm ci
npm run setup:auto
```

Rerun one wizard step with `npm run setup -- --step container|gateway|provider-auth|service|pair-telegram|verify`. `MYBOTS_SKIP` is a comma-separated list of those names for unattended runs.

Without a service, the compiled host still starts in the foreground:

```sh
npm run build && npm start
```

`npm run dev` is the development entry, not the documented default start. The CLI connects to the host that is already running:

```sh
npm run mbt
```

Changing `.env` applies after restarting the launchd job, systemd unit, or `start-mybots.sh`. The service runs `node packages/host/dist/index.js` with the checkout as its working directory and appends `logs/mybots.log` and `logs/mybots.error.log`.

The installation root defaults to the current directory. `--help` starts no
services. `dev` starts the CLI socket and configured Telegram/WebSocket
channels through `packages/host/src/index.ts`, the sole host startup entry point. Run one host
per installation root. A second host refuses the owned state directory. The CLI
requires the host and never opens an independent execution runtime.

For the compiled host started by hand, `npm start` uses the existing build.
`npm run mbt` always runs the CLI TypeScript source
with Node.js, including when the host runs from its build.

To expose the same CLI as a shell command, link this installed checkout:

```sh
npm link --workspaces=false
mbt
```

`npm link --workspaces=false` is optional. The service step does not install `mbt` onto `PATH`.

Ensure npm's global bin directory is on `PATH`. The executable launcher resolves
its real location through npm symlinks and preserves the caller's working
directory: `mbt` defaults `--root` to that directory. It connects to the existing
host and never starts a host or Agent runtime.
Missing runtime, image, gateway or mount prerequisites fail execution explicitly.

## Configure the assistant

[Configuration](docs/configuration.md) describes `host.json`, owner identities,
Agent settings, resource selection and channel wiring. The default example enables
CLI and loopback WebSocket. [The Telegram example](examples/host/host-telegram.json)
shows an already paired owner. The setup wizard writes `TELEGRAM_BOT_TOKEN` to `.env` after Telegram accepts the token. The host reads that name itself. Pairing stores the single `telegram:<user-id>` owner in `data/host.db`.

Place shared instructions and saved materials under `groups/<folder>/`. Select
Skills from `groups/<folder>/skills/<id>/SKILL.md` through `agent.resources.skills`.
The repository's development Skills are not assistant resources. `/reset` starts
a fresh Pi conversation for that destination, preserving shared working files
and other conversations. Other slash input is ordinary Agent text.

Open `http://127.0.0.1:8787/` on the Host computer to create and select Bots and
inspect session execution status. The Host prints the URL at startup. Copy the locally
generated `data/client-credential` into the pairing form once; the browser keeps
an HttpOnly connection cookie for later visits. Each new Bot has its own role,
approved model, tools and workspace; settings persist across Host restart. The
page refreshes status while visible. The Host must stay running, and desktop localhost is not
reachable from a phone. See [local client access](docs/host-runtime.md#local-client-access).

The example WebSocket endpoint is `ws://127.0.0.1:8787/ws`. Native clients must
supply `Authorization: Bearer <credential>` during the upgrade. Browser clients
use the paired cookie and a matching Origin. Send:

```json
{ "type": "input", "destination": "desktop", "content": "hello" }
```

Connected clients observe live host events across channels. An observer does not
acknowledge another channel's replies. Reconnecting CLI/WebSocket clients observe
new output without a guaranteed historical replay. See [host runtime](docs/host-runtime.md)
for protocol, owner-local access, delivery and recovery details.

## Persistence and reliability

The host stores routing and lifecycle state in `data/host.db`. Each conversation
has directional mailboxes and SDK-owned history under
`data/sessions/<agent_group_id>/<session_id>/`; shared Agent files live separately
under `groups/<folder>/`. Immutable host-owned runner context is mounted read-only.
A saved `pi:` continuation explicitly selects the session's SDK history.

Execution completion and delivery are separate. Follow-ups admitted to an active
Pi query are acknowledged early; a hard crash can lose queued work or a final
reply between completion and output persistence. Unfinished crash/stuck work has
bounded retries and may repeat tool effects. Persisted replies have independent
finite delivery attempts; a platform acceptance before acknowledgement can
produce duplicates. See [completion and recovery](docs/adr/0008-mailbox-completion-and-recovery.md).

This setup starts fresh and has no import path for the retired embedded runtime's
YAML configuration or conversation files. Historical decisions remain in
[ADRs](docs/adr/0006-sdk-managed-agent-execution.md).

## Verify

```sh
npm run check
npm test
npm test -- tests/host-channels.test.ts
npm run test:watch
npx playwright install chromium
npm run verify
npm run test:browser
```

`check` runs formatting/lint and all workspace types without modifying files.
`verify` also runs all ordinary offline tests, builds all four workspaces, exercises
compiled entry points plus controlled Pi and host/CLI demonstrations, and runs
the Chromium client journey against a built Host. Install Chromium once with the
command above; Linux may also need `npx playwright install --with-deps chromium`.
`test:browser` builds and runs that browser journey separately. Execution is
controlled through the existing session driver with real Host persistence;
no live credentials or Docker are required. `npm run demo:pi` and `npm run demo:host` show those
demonstrations separately.

With Docker Desktop and `openssl`, run the separate controlled-infrastructure pass:

```sh
npm run test:infrastructure
```

It checks the actual production runner, mounted SQLite, scoped gateway credentials,
proxy/TLS and continuation against controlled services. It uses synthetic keys.
Actual DeepSeek/Telegram acceptance is a separate, explicitly selected operation;
see [runtime acceptance](docs/runtime-acceptance.md). Offline and infrastructure
results do not establish a real-service deployment.

CI runs `npm run verify` and isolated Git workflow tests on Node.js 24.21.0.

## Commands

| Purpose | Command | Entry |
| --- | --- | --- |
| Development host | `npm run dev` | `packages/host/src/index.ts` |
| Built host | `npm start` | `packages/host/dist/index.js` |
| Interactive CLI | `npm run mbt -- [arguments]` | `packages/host/src/cli/client.ts` |
| Linked CLI | `mbt [arguments]` | `bin/mbt` to the same source CLI |

The root package owns unified commands and repository tools; `packages/host`,
`packages/agent-runner`, `packages/mailbox` and `packages/client` own their dependencies and
separate build output. One root lockfile covers all workspaces. Source host startup
selects the mailbox source export; built startup uses its compiled export. See
[package resolution](docs/container-runtime.md#mailbox-package-resolution).

## Source layout

- `packages/host/src/index.ts`: host startup, composing the CLI socket, Telegram and WebSocket services.
- `packages/host/src/host.ts`, `packages/host/src/reconcile-session.ts`: routing, delivery and bounded recovery.
- `packages/host/src/db/`: central entities and schema migrations.
- `packages/host/src/channels/`: Telegram and WebSocket host adapters and Bot API transport.
- `packages/host/src/web/`: client asset serving, local pairing, Bot creation and HTTP reads.
- `packages/client/src/`: browser Bot management and status page using the public Host API.
- `packages/host/src/drivers/`, `packages/host/src/container-runner.ts`: isolated execution and session material.
- `packages/host/src/gateway-providers/`: host-side credential gateway integration.
- `packages/mailbox/src/`: shared directional mailbox package with Node and Bun entries.
- `packages/host/src/cli/client.ts`: independent CLI entry and argument parsing.
- `packages/host/src/cli/chat.ts`: interactive terminal input, prompts and reply display.
- `packages/host/src/cli/socket-client.ts`: socket connection, text framing and awaited closure.
- `packages/host/src/cli/socket-server.ts`: host-side CLI listener, input routing and delivery.
- `packages/agent-runner/src/`: mailbox loop, Pi provider and Pi web tools.

## Project rules

- [Development](docs/agents/development.md)
- [Testing](docs/agents/testing.md)
- [Git workflow](docs/agents/git-workflow.md)
- [Agent instructions](AGENTS.md)
