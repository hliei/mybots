# Persistent host and local CLI

The host owns owner identities/role grants, Agent identity and workspace, messaging
destinations, destination-to-Agent wiring, container configuration and persistent
sessions in `data/host.db`. The CLI connects to `data/cli.sock`; it opens no Agent
runtime and reads no model credentials. The production host runs the existing
isolated Pi runner through `DockerDriver` and `OneCliGateway`.

## Start and configure

Use Node.js 24.21.0. From the checkout, `bash mybots.sh` is the install path.
It generates `host.json`, writes `.env`, and starts one background service for
this checkout. Do not hand-edit model, gateway, container, or token fields.
Do not start a second host for the same install root.

```sh
bash mybots.sh
npm run mbt
```

Without a service, `npm run build && npm start` runs the compiled host in the
foreground. `npm run dev` is the development entry. Both default `--root` to the
current directory. The host accepts `--config FILE` to select another JSON file;
CLI only selects the installation root. `--help` requires no configuration or
service. Missing `host.json` fails and tells the operator to run setup. Invalid
configuration fails before opening the host.

`npm link --workspaces=false` exposes `mbt` from the root package's `bin/mbt`
launcher. It resolves the linked checkout and invokes the CLI source using
`.tools/node/bin/node` when installed, otherwise Node on `PATH`. Run `mbt start`
from any directory to open that installation's Web UI. It authenticates a local
status read before opening the browser; when needed it starts the installed
launchd/systemd job or WSL start script and waits up to thirty seconds for readiness.
Existing running work is not restarted. It does not rebuild, regenerate settings,
install dependencies or create model input. First browser pairing remains required.

Use `mbt start --root PATH` for another installation, or `npm run mbt -- start`
without a global link. Startup requires a configured fixed loopback Web port and
an installed service; errors explain missing setup or identify the Host error log.
If no browser can open, the ready Host's URL remains available in terminal output.
An installation using `MYBOTS_INSTALL_ID` keeps that same override for startup.

Run `mbt exit` to unload the installation's launchd job, stop its systemd unit,
or signal the Host owned by its WSL start script. The command waits up to thirty
seconds for Host shutdown and normal session-container cleanup. It retains saved
Bot, chat and work data, and leaves the shared OneCLI gateway and its database
running. An unresolved Host ownership record reports unconfirmed cleanup. Shutdown
does not record a user cancellation or invent a work outcome; existing Host recovery
handles unfinished work on the next start.

Both commands serialize service control with a kernel-released SQLite transaction
in `data/service-control.lock`, separate from `host.db`. No coordinator process
remains after the command exits. This prevents overlapping starts from launching
the installed WSL script twice and orders an exit after an in-progress start.
Use `--root PATH` to stop another installation or `npm run mbt -- exit` without
a global link. The same `MYBOTS_INSTALL_ID` override applies to exit.

`mbt` without a subcommand remains terminal chat and connects to an already running
Host; its default root is the caller's directory. Use `--root` from elsewhere.
Typing `exit` within terminal chat only disconnects the terminal.
Neither path opens an independent Agent execution runtime.

`owners` lists the single owner's namespaced platform identities; the local
example uses `["cli:local"]`. Exactly one identity must be a `cli:` identity for
the terminal channel. Add the Telegram identity (`telegram:<user-id>`) when
configuring a Telegram private chat.
`agent` bootstraps the first Bot's ID, name, shared folder, instructions and explicit
model configuration only when the store is first initialized. Later startup values
do not overwrite the persisted identity or settings. Optional `agent.resources.skills` selects directory IDs under
`groups/<folder>/skills/`; `agent.resources.tools` selects Pi built-ins (`read`,
`write`, `edit`, `bash`, `grep`, `find`, `ls`) and the configured web tools
(`web_search`, `fetch_content`). Omitted Skills select none; omitted
tools select `read`, `write`, `edit`, `bash`; an empty tool list disables built-ins.
Selecting a web tool requires matching `agent.web` configuration. The execution
harness is Pi; the model backend is specified separately by `model.provider` and
`model.id`. The central store uses schema version 7 for host routing, resource
selection, delivery attempts, lifecycle records, web configuration, Bot/chat
admissions and durable chat work outcomes. Earlier schema versions upgrade
additively. The central store saves the model
selector as `provider/id` plus its endpoint and token limits. Endpoints must use
HTTPS without URL credentials. Host configuration and gateway management material
are outside runner mounts.

Each `destinations` entry names a messaging group with `id`, `channelType`,
`platformId` and `instance`. It is wired to the personal Agent with shared session
mode, no threads and owner-only sender authorization. The `cliDestinationId` must
select a `cli` destination with platform ID `local`. Additional configured
messaging destinations can use the same Agent workspace and different sessions
through their host-side channel adapters.

### Web search and content fetching

`web_search` and `fetch_content` are Pi custom tools that run inside the session
container. Select them through `agent.resources.tools` and configure the matching
operation in `agent.web`:

```json
{
  "agent": {
    "resources": { "tools": ["read", "web_search", "fetch_content"] },
    "web": {
      "search": { "provider": "brave", "endpoint": "https://api.search.brave.com/res/v1/web/search" },
      "fetch": true
    }
  }
}
```

`agent.web.search` explicitly selects `brave` or `serpapi` and one complete
HTTP(S) endpoint; the tool does not discover providers or fall back after a
failure. `agent.web.fetch` enables content fetching without a provider selector.
Omitted operations disable their tool, and selecting a web tool without its
matching configuration fails validation before startup. The search endpoint is
non-secret: it is copied into immutable runner context, while the real provider
credential stays gateway-owned. The runner sends a placeholder token, and the
OneCLI connection bound to the endpoint's hostname injects the scoped credential.
Other model, search or channel endpoints acquire no blanket secret access.

`fetch_content` requests public pages directly from the container with bounded
time and response handling and uses Readability/Turndown extraction, matching the
delivered search/fetch argument and result contracts. See
[ADR 0003](adr/0003-web-search-and-content-fetching.md) for the tool contracts and
[container execution](container-runtime.md#agent-resources-and-reset-controls)
for the runner boundary.

### Telegram private chat

A Telegram private chat is enabled by a `telegram` section. Setup writes
`{ "instance": "telegram" }` and `TELEGRAM_BOT_TOKEN` only after the token
matches BotFather's format and `getMe` succeeds. The running host then pairs one
private chat: the wizard prints a one-time 6-digit code, and a private message
that is only those digits registers `telegram:<user-id>` and destination
`owner-chat` in `data/host.db`. The reply is `Pairing success!`. That record
survives restart. Regenerating `host.json` does not remove it.

```json
{
  "telegram": { "instance": "telegram" }
}
```

`telegram.instance` selects the messaging-group instance served by one polling
channel. The token is read from `TELEGRAM_BOT_TOKEN` in the install `.env` at
startup, is used only by the host's Bot API client, and never enters runner
mounts, instructions, mailbox records, or diagnostics. Enabled Telegram without
the token fails startup. Before pairing, unknown private chats, groups, and
other updates create no Agent work. A wrong code invalidates the attempt.

The channel normalizes raw updates at the Bot API boundary, ignores non-text
updates, non-private chats, unknown senders and unconfigured chats, and advances
the polling offset past every returned update. Accepted input follows the same
host/mailbox/runner path as CLI and replies to its own chat, split at Telegram's
4096-code-point limit. Telegram and CLI share the Agent workspace but keep
separate persistent conversations. Polling retries a failed long poll and stops
with the host, aborting in-flight requests and awaiting dispatches.

`container.image` and `container.network` select an existing runner image and
internal Docker network. `gateway.url` is the host's OneCLI management endpoint;
`gateway.proxyHost` is the local OneCLI container alias visible on the isolated runner
network. `ONECLI_URL`, `ONECLI_API_KEY`, and optional `ONECLI_PROJECT_ID` are
host-only management settings in `.env`. Put real model credentials in OneCLI,
not the JSON file. See [container execution](container-runtime.md) for gateway
provisioning, mounts and network requirements. Dependencies are checked when a
session starts; a driver failure is observable and leaves accepted input saved.

Configuration is loaded at host startup and persisted to host entities. Existing
destination IDs retain their channel/platform/instance meaning. Session context
is immutable once provisioned: changing model/instructions for an existing
session requires stopped execution and explicitly replacing its context. Configured
resource selection follows the same rule. Shared instruction and Skill files are
loaded on each new query at an idle boundary; existing queued follow-ups retain
the active query's resource snapshot.

## Conversations and delivery

Concurrent first inputs for an Agent/destination resolve to one saved session
through a central transaction and a unique active-session index. The host writes
the input mailbox before waking the driver. A reconnected terminal or fresh host
uses that saved session. The runner opens the exact provider-qualified Pi
continuation from its outbound mailbox; the host builds no model context.

Session-private mailboxes and Pi state live beneath
`data/sessions/<agent_group_id>/<session_id>/`. Shared materials live under
`groups/<folder>/`. Different destinations share that workspace while retaining
separate conversations. Host shutdown stops its running session containers;
restarting and sending a new input recreates execution for the same session.

Inputs within a session become ordered follow-ups during execution, with a
separate result for each input. Other sessions execute independently against the
shared writable workspace without a workspace-wide lock. Outbound delivery is
sequential within each session and progresses independently across sessions;
a held execution or delivery cannot block another session's reply. Processing
acknowledgements continue to be mirrored while delivery is held.

The host mirrors terminal processing acknowledgements into inbound status and
independently delivers persisted outbound rows to their original destination.
`Host.inspect(sessionId)` reports input, output, continuation and delivery state,
including each reply's attempt count and last in-flight error.
An output with a missing input correlation or changed reply address is rejected.
Completion does not imply output persistence or delivery.

Each platform-delivery failure records a `delivery_attempts` row in
`data/host.db`, keyed by the outbound message, so counts survive a host restart
and are not per-process memory. A message gets at most three attempts (including
the first); a successful send clears its attempt row and records terminal
`delivered` state in the session's `inbound.db`. A third failed attempt records
terminal `failed` state and clears the row, so an exhausted message is never
presented as sent and is not retried by a later host instance. Attempts are
independent of processing completion, and a failing destination only affects its
own messages: later replies in the same session and other sessions keep
delivering. The host does not block a whole session on an exhausted reply and
keeps no chunk-count projection. An in-flight failure records the channel error
message (bounded to 200 characters) for inspection; `Host.inspect` exposes the
attempt count, last attempt time and last error until the reply reaches terminal
state. A destination whose channel is not attached yet
stays pending—no attempt is counted—and becomes eligible once its channel is
available, including after restart. Delivery is still not exactly-once: when the
platform accepts a send but the host stops before recording durable
acknowledgement, a later instance can send the same reply again. Accepted loss
windows are described in [ADR 0008](adr/0008-mailbox-completion-and-recovery.md).

The CLI wire format is one JSON line each way: input `{"text":"hello"}` and
reply `{"text":"answer"}`. The data directory is mode 0700 and socket is mode
0600. Only one chat client is active: a new client claims the slot on its first
valid input, sends the previous client `[superseded by a newer client]` and closes
it. Merely connecting does not replace the active terminal. Disconnecting does
not cancel host Agent work. With no active terminal, CLI delivery is a no-op;
the outbound row remains persisted but is marked delivered. Reconnecting sees
subsequent replies, without guaranteed replay of disconnected output.

Blank terminal lines are ignored. `quit`, `exit`, `q` and EOF disconnect with
status 0; Ctrl+C disconnects with 130. Startup, host-disconnect and terminal
failures return 1. `/reset` queues an owner-authorized conversation reset. It waits
for the active query (including SDK compaction and cleanup), then creates and saves
a fresh Pi conversation for the same routed host session. Later inputs cannot
cross that FIFO boundary. The reset returns `Conversation reset.` through the
ordinary reply/delivery path and makes no model request. Previous private logs,
other sessions, mailbox records and shared working files are preserved; the saved
continuation selects only the new conversation on reconnect or host restart.
Other slash input remains ordinary Agent text.

## Interrupted-execution recovery

The host owns `data/host.lock` with a recorded instance identity and process ID.
A short host-local SQLite write transaction serializes lock inspection and owner
publication, including concurrent attempts to take over an abandoned lock.
A second host refuses a lock whose recorded process is still alive. When an
abnormal exit leaves the lock behind, the next host adopts the data directory,
marks the abandoned instance stopped, and reconciles persisted state rather than
assuming its own in-memory view is complete.

Startup reconciliation reads every persisted Agent session and the runtime state
the driver actually observes. It takes a fenced claim on each session and then
either adopts a container the runtime still reports as running for that session,
or recovers what that session left unfinished.
If runtime observation or adoption fails, startup fails without recovering claims
from a container that may still be running. Restore runtime access before retrying.
Each claim carries an incarnation; a superseded host or container handle whose
late exit or cleanup arrives after a
newer incarnation owns the session cannot change its status, deliver into it, or
clean it up.

The host mirrors terminal processing acknowledgements into inbound status and
reschedules an abandoned `processing` claim for unfinished work. The recovery
baseline allows the initial attempt and up to five retries with waits of five,
ten, twenty, forty and eighty seconds; exhausted work reaches an explicit failed
state and reports a host failure event. A container that exits before claiming
its input is bounded by the same schedule, so a crash loop reaches the failed
state instead of restarting forever. Completed input is never redelivered,
including an early-acknowledged follow-up, and an ordinary provider failure keeps
its separate terminal failure path rather than becoming a crash claim.

A running container is replaced when it shows no progress: its heartbeat file is
older than the absolute ceiling, or it claimed input and then went silent past
the claim tolerance. A tool's declared timeout widens both the ceiling and the
claim tolerance while that tool is active. Replacing a container stops it and
recovers its unfinished claims under the same bounded policy; the host waits for
that stop before touching runner-owned claims, so a stopped incarnation cannot
overwrite the recovered state. Failed stops retain the existing handle and claims
and report a failure; new input cannot start another container while replacement
is pending. Retrying unfinished
input can repeat an already-performed tool effect; the host does not provide
exactly-once execution or delivery, and the accepted crash loss windows remain.

Reconciliation runs periodically and on demand through `Host.reconcile()`. Offline
tests use a controlled clock so backoff and stall timing are deterministic.

## Local client access

The optional `websocket` section enables one loopback HTTP/WebSocket listener in
the persistent Host. It serves the built client, public Bot/status API and existing
live-event interface on the same origin:

```json
"websocket": { "host": "127.0.0.1", "port": 8787, "path": "/ws" }
```

Build with `npm run build`, start with `npm start`, and open the printed local
client URL (the example uses `http://127.0.0.1:8787/`). The Host generates a
256-bit connection credential in `data/client-credential` with mode 0600. Copy it
into the pairing form on the Host computer. The file is installation state,
outside Agent mounts; it is retained across Host restarts and never embedded in
client assets, URLs or startup logs. Protect it as a local owner credential.

`POST /api/pair` accepts `Authorization: Bearer <credential>` and sets a host-only
HttpOnly, SameSite=Strict cookie with a one-year lifetime. Pairing is idempotent:
it sets the same connection credential, without creating domain work or records.
The cookie is used over loopback HTTP. Clearing browser cookies requires pairing
again; stopping the Host, deleting its credential file and restarting generates
a new credential and invalidates old browser/native connections.

`GET /api/status` returns `{ bots, sessions }` from the Host store and session
mailboxes. Bot records expose `id` and `name`. Sessions expose `id`, `botId`,
`destinationId`, lifecycle `status`, `containerStatus`, `lastActive`, and `inputs`
counts (`pending`, `processing`, `acknowledged`, `failed`). A running container can
be idle, and a mailbox acknowledgement does not establish a successful work
outcome. Reads do not open SDK conversations or admit execution.

`GET /api/bot-options` returns installation-approved `{ provider, id }` model
selectors and available tool names. `GET /api/bots` returns `{ bots }` with each
Bot's `id`, `name`, `workspace` (relative to the installation root), `instructions`,
`model` selector and `tools`. Endpoints and credentials are not public settings.

`POST /api/bots` accepts this creation payload:

```json
{
  "requestId": "create-researcher-1",
  "name": "Researcher",
  "instructions": "Investigate sources and retain useful notes.",
  "model": { "provider": "deepseek", "id": "deepseek-chat" },
  "tools": ["read", "write"]
}
```

A new admission returns 201 and `{ requestId, bot, replayed: false }`. Retrying
identical settings with the same request ID returns 200 and the same Bot with
`replayed: true`, including after Host restart. Reusing an admitted ID for changed
settings returns 409. Invalid settings return 400 with `{ error }`; requests over
64 KiB return 413. Workspace/storage failures return 503; retry with the original
ID. The identity, initial settings and request record commit together only after
an exclusive real workspace directory is available. Generated folders never adopt
another Bot's materials, including Bots with equal display names.

The client stores an unconfirmed creation payload before sending, so reload and
retry retain its request identity. It remembers the selected Bot and shows that
Bot's initial settings. Creation does not start a session or container. Runtime
configuration editing is a subsequent capability.

### Selected chat sessions and work outcomes

Select a Bot, create and name chat sessions, then select a session before sending
messages. The client remembers the selected session per Bot. Same-Bot chats share
working files while Pi retains separate conversations; different Bots have
separate workspaces. Creation and renaming do not start execution.

| HTTP operation | Request / response |
| --- | --- |
| `POST /api/sessions` | `{ requestId, botId, name }`; 201 with `{ requestId, session, replayed }`, or 200 for a replay. |
| `GET /api/sessions?botId=<id>` | `{ sessions }` for that Bot's explicitly created chats. |
| `POST /api/sessions/<id>/name` | `{ requestId, name }`; 200 with the admitted session. |
| `POST /api/sessions/<id>/messages` | `{ requestId, text }`; 202 with `{ requestId, botId, sessionId, workId, messageId, replayed }`. |
| `GET /api/sessions/<id>` | `{ session, works }` with persisted input/result links and work outcomes. |

Names allow 120 characters; messages allow 32,000 characters, within the 64 KiB
JSON request limit. These operations reject unknown fields, including execution
configuration overrides. Reusing an ID for a different chat operation or payload
returns 409. Unknown Bot/chat identities return 404; invalid JSON or fields return
400. The client saves unconfirmed create/name/message requests before sending and
provides a retry button after a lost response or reload. Retry the original
request identity after 503 or an unconfirmed transport result.

Initial input in an idle chat starts a work item. FIFO follow-ups admitted before
its terminal outcome join the same work, including while earlier turns finish.
An input after terminal completion starts distinct work. Each session executes
sequentially; separate sessions and Bots can progress concurrently. Global/per-Bot
admission limits are a subsequent capability.

Work records expose `id`, `botId`, `sessionId`, `state`, `outcome`, timestamps,
and admitted `messages`. Each message includes its stable `id`, input `text`, and
correlated final `outcome` with `messageId`, `resultId`, `reply`, `kind` and time.
A successful work outcome identifies the last input/result; a failed work outcome
identifies the first failed input/result, retaining each later reply separately. Bounded recovery exhaustion has a failure reason without a
runner `resultId`. States distinguish `queued`, `active`, `succeeded`, `failed`,
and `uncertain`; unresolved work has no terminal outcome. Result delivery remains
independent of work success.

The Host reconciles correlated final mailbox output into durable outcomes. Early
acknowledgements and partial model text do not establish success. If execution is
lost after acknowledgement without final evidence, the work becomes `uncertain`;
pending follow-ups stay held and ordinary replacement input returns 409. Other
sessions remain usable. The client retains available per-message evidence and
shows the unresolved work. Owner resolution/stop controls, full SDK history and
streaming are subsequent capabilities. This view shows admitted chat inputs and
final outcomes; it does not claim complete tool or SDK conversation history.

Admission commits before mailbox publication. Restart or retry publishes missing
inputs using their existing identity, reconciles saved replies, and preserves
terminal outcomes and uncertainty. This does not close the runner's accepted
acknowledgement/output crash windows or promise exactly-once tool effects.

All private HTTP routes and WebSocket upgrades require the credential, either
as a Bearer header or the paired cookie. An explicit invalid Authorization header
cannot fall back to a cookie. Static client assets alone are public. Every request,
including assets and upgrades, validates Host against loopback names and the actual
bound port. A supplied Origin must exactly match that HTTP origin; cross-site
fetches are rejected and CORS access is not enabled. Native clients may omit
Origin. Invalid credentials yield 401 and invalid Host/Origin yields 403 before
reads, operations or upgrades. There is no unprotected alternate WebSocket listener.

`host` must be `127.0.0.1`, `localhost` or `::1`; remote/public serving is not
supported. The Host computer must remain available. A locator received on a phone
does not provide access to the desktop's localhost. Omit `websocket` to disable
the combined listener. Without WebSocket destinations it still provides Bot creation,
status and observation. When destinations are configured, they share one channel
instance and input resolves through the same central Agent/session records as CLI.

## Local WebSocket interface

Connect to the configured path with the same credential and Host/Origin checks.
A WebSocket destination shares its Bot workspace and keeps a separate persistent
conversation. This existing input protocol remains available to authenticated
native clients; the Web page uses the HTTP management and status routes.

A client sends one JSON text frame per input:

```json
{ "type": "input", "destination": "desktop", "content": "hello" }
```

`destination` must name a configured `websocket` destination. Invalid JSON, a
wrong frame type, missing or blank destination/content, and an unconfigured
destination produce an `error` frame on that connection and create no host work.
An `error` frame is `{"type":"error","message"}`; it is connection-scoped and
carries no correlation identifier, so a client that pipelines frames should not
rely on matching one error to one submission. Accepted input is ordinary persisted
mailbox input; no parallel local routing store is created.

Every connected client observes live host envelopes: `inbound` for accepted input
(`session_id`, `message_id`, `destination`, `channel_type`, `platform_id`,
`thread_id`, `content`, `timestamp`), `outbound` for a not-yet-delivered output
(`message_id`, `in_reply_to`, `kind`, routing and `timestamp`), and `failure` for
host failures. Observation is live and passive: it reports another channel's
outbound row before that channel acknowledges delivery and never marks that row
delivered or changes its reply destination. A WebSocket destination's own output
is sent by the WebSocket sender, not the observation path. Each outbound row is
observed at most once per host process; delivered events are not replayed to a
reconnecting client, and a fresh host does not broadcast rows that already
existed at startup.

A slow or failed peer is bounded by the configured send timeout, is dropped, and
does not delay other clients, observation or session execution. With no connected
client, WebSocket delivery is a no-op: the outbound row remains persisted and is
marked delivered without guaranteed replay, matching CLI. `WebSocketChannel.listen`
and `close` own the listener and its clients; the host entry point closes the
interface before stopping the host.

## Public lifecycle and verification

`Host.start({ root, configuration, driver })`, `accept`, `sessions`, `clientStatus`, `inspect`,
`reset({ destinationId, userId })`, `observe`, `attachChannel` and `stop` are the host boundary. The driver accepts
session material and an abort signal and returns an awaited stop/exit handle.
`CliChannel.listen` and `close` in `packages/host/src/cli/socket-server.ts` own the local listener
and its connected sockets. The independent `packages/host/src/cli/client.ts` parses CLI arguments
and starts `packages/host/src/cli/chat.ts` for terminal prompts, input and reply display.
`packages/host/src/cli/socket-client.ts` owns connection, newline-delimited JSON framing,
text send/receive and awaited socket closure. The terminal handles close results
without accessing the underlying socket. The connection stays open for interactive
chat; EOF, quit or Ctrl+C disconnect it while host-side Agent work continues.
`WebSocketChannel.listen` and `close` own the owner-local WebSocket listener, its
clients and their bounded frames. `TelegramChannel.listen`, `start` and `stop` own
host delivery and Bot API polling for one Telegram instance; `dispatch` routes a
single normalized update. `runHost` starts the Telegram channel when `telegram`
settings are present. Importing these modules starts no services. Observers cannot
prevent persistence;
channels must settle delivery on shutdown cancellation.

`SIGINT`/`SIGTERM` closes the production CLI listener, aborts polling and delivery,
stops session resources and closes the central store. Host shutdown has a default
10-second bound and reports a failure if a driver ignores cancellation. Exclusive
`data/host.lock` prevents two hosts from owning the same state and records the
owning instance and process. Clean shutdown removes it. If an abnormal termination
leaves it behind, the next host refuses the lock while the recorded process is
alive and otherwise adopts the persisted state and reconciles it; see
[interrupted-execution recovery](#interrupted-execution-recovery).
Shutdown awaits each session's in-flight delivery as well as execution cleanup.
A delivery that settles after cancellation is not marked successfully delivered.

`npm run demo:host` builds and runs compiled host/CLI modules with the controlled
mailbox driver fixture. It shows an input/reply, CLI reconnect and host restart
with one saved session and its exact continuation. `verify` includes the same
bounded demonstration and executable help/configuration-failure checks. Host
integration tests use real central/session SQLite and the same driver boundary.
`tests/host-telegram.test.ts` drives the channel with a controlled Bot API: owner
routing, unknown-sender and unsupported-input rejection, chat splitting, offset
advance, cancellation, restart affinity, token containment and entry-point
wiring. No test contacts Telegram or uses a real token. These checks do not
establish Docker, gateway, CA or live provider behavior. The
opt-in infrastructure suite and actual-service acceptance remain separate.

`packages/host/src/index.ts` is the sole host startup entry point. It composes the CLI socket
service and configured Telegram and WebSocket channels. Use `dev` or
`start` once per installation root; `packages/host/src/cli/client.ts` remains the independent
socket-client entry point.

## Shared instructions and Skills

Put Agent instructions in `groups/<folder>/AGENTS.md`. Only that exact file is
loaded; ancestor project instructions and host engineering Skills are excluded.
The host's optional `agent.instructions` is appended through Pi's resource loader.
Create each selected Skill as `groups/<folder>/skills/<id>/SKILL.md`, with Pi-native
frontmatter (`name`, `description`) and its instructions. For example:

```markdown
---
name: brief
description: Produce a concise answer from saved working materials
---
Read the relevant shared materials, then answer concisely.
```

Select it in host configuration with
`"resources": { "skills": ["brief"], "tools": ["read", "write", "edit", "bash"] }`.
Selected Skill IDs must be unique path-safe names; tools must be unique supported
built-in or configured web-tool names. Selected Skill and instruction paths must be real workspace
paths. Missing selected Skills fail the exchange before model traffic. Resource
selection is not filesystem confinement: the actual container mounts protect
host credentials and other session logs. Agent sessions deliberately share the
writable working directory.

Long conversations use Pi's default automatic compaction and SDK-owned history.
Reopening the explicit `pi:` continuation restores the retained summary and
messages. The host does not estimate tokens, reconstruct active context from its
mailbox or copy conversation messages into shared files. Persist working materials
explicitly when they should be accessible from another session.
