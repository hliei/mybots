# Mybots

A personal assistant with one persistent host, isolated Agent session containers,
and a shared Agent workspace. CLI, owner-only Telegram private chats and the local
WebSocket interface use separate persistent conversations with the same Agent.
Pi owns model/tool execution, Skills, conversation history and compaction.

## Install and start

Use Node.js 24.21.0 and npm from the repository root:

```sh
npm ci
npm run prepare
mkdir -p workspace
cp examples/host/host.json workspace/host.json
mkdir -p workspace/groups/personal
cp examples/host/groups/personal/AGENTS.md workspace/groups/personal/AGENTS.md
```

Before sending input, build the runner image and configure Docker and the
credential gateway as described in [container execution](docs/container-runtime.md).
The runner uses Bun 1.4.0. The gateway owns real model/search credentials; the
host owns the Telegram token. The example contains no credentials.

```sh
docker build -t mybots-agent:mailbox -f container/Dockerfile .
npm run dev:host -- --root ./workspace
# In another terminal:
npm run dev:cli -- --root ./workspace
```

The installation root defaults to the current directory. `--help` starts no
services. `dev:host` starts the CLI socket and configured Telegram/WebSocket
channels. `dev:bot` is another command for that same host; run one host command
per installation root. A second host refuses the owned state directory. The CLI
requires the host and never opens an independent execution runtime.

For compiled programs:

```sh
npm run build
npm run start:host -- --root ./workspace
# In another terminal:
npm run start:cli -- --root ./workspace
```

`start:bot` starts the same host as `start:host`. Development commands run source
once; restart manually after changes. Start commands use the existing build.
Missing runtime, image, gateway or mount prerequisites fail execution explicitly.

## Configure the assistant

[Configuration](docs/configuration.md) describes `host.json`, owner identities,
Agent settings, resource selection and channel wiring. The default example enables
CLI and loopback WebSocket. [The Telegram example](examples/host/host-telegram.json)
adds an owner-only private chat: replace its numeric owner/chat identity and set
`MYBOTS_TELEGRAM_BOT_TOKEN` in the host environment before starting.

Place shared instructions and saved materials under `groups/<folder>/`. Select
Skills from `groups/<folder>/skills/<id>/SKILL.md` through `agent.resources.skills`.
The repository's development Skills are not assistant resources. `/reset` starts
a fresh Pi conversation for that destination, preserving shared working files
and other conversations. Other slash input is ordinary Agent text.

The example WebSocket endpoint is `ws://127.0.0.1:8787/ws`. Send:

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
npm run verify
```

`check` runs formatting/lint and host/runner types without modifying files.
`verify` also runs all ordinary offline tests, builds both packages and exercises
compiled entry points plus controlled Pi and host/CLI demonstrations. It requires
no live credentials or Docker. `npm run demo:pi` and `npm run demo:host` show those
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

## Source layout

- `src/index.ts`, `src/server.ts`: the host and its bot command wrapper.
- `src/host.ts`, `src/reconcile-session.ts`: routing, delivery and bounded recovery.
- `src/db/`: central entities and schema migrations.
- `src/channels/`: CLI, Telegram and WebSocket host adapters and Bot API transport.
- `src/drivers/`, `src/container-runner.ts`: isolated execution and session material.
- `src/gateway-providers/`: host-side credential gateway integration.
- `src/mailbox/`: shared directional mailbox package with Node and Bun entries.
- `src/cli.ts`, `src/cli/`: terminal host client.
- `container/agent-runner/src/`: mailbox loop, Pi provider and Pi web tools.

## Project rules

- [Development](docs/agents/development.md)
- [Testing](docs/agents/testing.md)
- [Git workflow](docs/agents/git-workflow.md)
- [Agent instructions](AGENTS.md)
