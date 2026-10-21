# Mybots

A personal assistant with one persistent Host, independent Bots and one direct
Thread per Bot. Requested work has durable Task/Run/Attempt identities. Containers
execute one Attempt per Bot at a time; different Bots can progress concurrently.
Mybots selects bounded Thread originals for each new Run. Pi owns that Run's
model/tool execution, Skills, recording, reopening and compaction.

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

To expose the daily startup and terminal commands, link this installed checkout once:

```sh
npm link --workspaces=false
mbt start
mbt exit
```

`npm link --workspaces=false` is optional. The service step does not install `mbt` onto `PATH`.

Ensure npm's global bin directory is on `PATH`. The executable launcher resolves
its real location through npm symlinks and uses the installation's `.tools/node`
when available, otherwise Node on `PATH`. `mbt start` works from any directory:
it opens the configured local Web UI, starting the installed background service
and waiting for its authenticated API when needed. Repeated starts reuse the
running Host without restarting work. The command prints the URL if a browser
cannot open. Docker and the configured gateway must be running; missing setup or
startup failure is reported with the next step or log path.

Run `mbt exit` when finished. It stops the installed Host service, waits for
session execution and container cleanup, and leaves no Mybots Host running in
the background. Saved Bot, chat and work data stay available for the next start.
The shared OneCLI gateway and database stay running. Cleanup failures are reported
instead of claiming a successful exit. Concurrent starts and exits are serialized
per installation.

`npm run mbt -- start` and `npm run mbt -- exit` run the same commands without a global link.
`mbt` without a subcommand keeps interactive terminal chat, with `--root`
defaulting to the caller's current directory. All modes accept `--root PATH`;
`mbt start` and `mbt exit` default to the linked installation. Typing `exit` inside
terminal chat only disconnects that terminal. No mode starts an independent
Agent execution runtime. `mbt start` does not rebuild or replace an installation;
use the setup steps after updating code.
Missing runtime, image, gateway or mount prerequisites fail execution explicitly.

## Configure the assistant

[Configuration](docs/configuration.md) describes `host.json`, owner identities,
Agent settings, resource selection and channel wiring. The default example enables
CLI and loopback WebSocket. [The Telegram example](examples/host/host-telegram.json)
shows an already paired owner. The setup wizard writes `TELEGRAM_BOT_TOKEN` to `.env` after Telegram accepts the token. The host reads that name itself. Pairing stores the single `telegram:<user-id>` owner in `data/host.db`.

Place shared instructions and saved materials under `groups/<folder>/`. Select
Skills from `groups/<folder>/skills/<id>/SKILL.md` through `agent.resources.skills`.
The repository's development Skills are not assistant resources. Reset chat
background from the Thread page or with `/reset`. That captures a boundary for
later conversational Runs. Existing Runs, Thread history, workspace files and
memory stay. Other slash input is ordinary Agent text.

Open `http://127.0.0.1:8787/` on the Host computer to create and select Bots and
use the Bot's direct Thread. Send ordinary chat, choose New task for independent
work, or select an active/queued Task as the input target. Reset chat background
while other Runs continue, and choose earlier messages for the next Run. Inspect Task/Run identity,
queue state, Attempts and final outcomes. The Host prints the URL at startup. Copy the locally
generated `data/client-credential` into the pairing form once; the browser keeps
an HttpOnly connection cookie for later visits. Each new Bot has its own role,
approved model, tools and workspace; settings persist across Host restart. The
page refreshes status while visible. The Host must stay running, and desktop localhost is not
reachable from a phone. See [local client access](docs/host-runtime.md#local-client-access).

The selected Bot page creates one-shot Routines from an absolute instant with offset
and an IANA timezone, or recurring Routines from common cron choices or a custom
five-field expression. Cron inherits the Bot timezone, defaulting to Asia/Shanghai. Resolved schedule and occurrence Task links
remain inspectable after disconnect or Host restart. Each due occurrence has an
independent Run context; choose its Task in Input target to add instructions.
Bots can resolve a natural-language schedule through their scoped `create_routine`
tool and can pause, resume, run, edit or logically delete their own Routines with
`manage_routine`. See [Routines](docs/host-runtime.md#routines).

The Thread includes local original-history search and paginated reading. Inspect
Run evidence to page through complete inputs, Attempts and recorded model/tool
activity. Live text is a bounded progress preview; reload/reconnect repairs it
from persisted state. Historical originals remain readable after SDK compaction.
See [original history](docs/host-runtime.md#original-history-and-run-evidence)
for limits, cursor semantics and execution-scoped Agent tools.

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

The Host stores Bot configuration, Threads, original messages, Tasks, Runs, Attempts
and input admissions in `data/host.db` (schema 11), including the durable execution
queue. Each Run has directional mailboxes
and an independent SDK ledger under `data/sessions/<bot_id>/<run_id>/`; shared Bot
files live under `groups/<folder>/`. Immutable runner context is mounted read-only.
A saved `pi:` continuation selects only that Run's SDK history.

Inputs retain one Task/Run association across response loss, retries and restart.
SDK steering queues alone do not establish consumption; recording evidence is
persisted after the SDK records the input. A new Attempt reopens that Run's ledger.
Known tool results are retained. Unfinished crash/stuck recovery remains bounded
and may repeat effects; acknowledged work without final evidence is uncertain.
Final reply persistence and platform delivery remain separate, with finite delivery
attempts and possible duplicate delivery. See [Host execution](docs/host-runtime.md#conversations-and-delivery).

This execution model requires fresh runtime records when updating an installation
with the earlier multi-session model. Stop the installed Host and confirm its
containers have stopped, then remove `data/host.db` and `data/sessions/` before
starting the updated build and runner image. The Host refuses an older store
containing sessions. Keep deployment configuration, `.env`, `data/client-credential`,
gateway credentials and `groups/` outside this replacement. There is no backup,
import or old-session continuation step. A fresh store bootstraps the configured
Bot; new-model state and settings survive subsequent ordinary restarts.

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

The [Multi-Bot controlled acceptance record](docs/multi-bot-acceptance.md) maps
functional and failure coverage and documents the reproducible built-client
Researcher/Writer journey, Host restarts, immutable report download and
independent topic delivery. It keeps offline, real-SDK, actual-container and
actual-service evidence separate.

The [Multi-Bot actual-service procedure](docs/multi-bot-service-acceptance.md)
defines the separate owner-participating macOS/provider/Telegram journey and
records its current deployment prerequisites and unverified gates.

CI runs `npm run verify` and isolated Git workflow tests on Node.js 24.21.0.

## Commands

| Purpose | Command | Entry |
| --- | --- | --- |
| Development host | `npm run dev` | `packages/host/src/index.ts` |
| Built host | `npm start` | `packages/host/dist/index.js` |
| Daily Web startup | `mbt start` or `npm run mbt -- start` | `packages/host/src/cli/start.ts` |
| Stop Host and session containers | `mbt exit` or `npm run mbt -- exit` | `packages/host/src/cli/start.ts` |
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
- `packages/host/src/web/`: client asset serving, local pairing, Bot/Thread operations and HTTP reads.
- `packages/client/src/`: browser Bot management, Thread chat, paginated originals and Run outcomes using the public Host API.
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
