# Persistent host and local CLI

The host owns owner identities/role grants, Agent identity and workspace, messaging
destinations, destination-to-Agent wiring, container configuration and persistent
sessions in `data/host.db`. The CLI connects to `data/cli.sock`; it opens no Agent
runtime and reads no model credentials. The production host runs the existing
isolated Pi runner through `DockerDriver` and `OneCliGateway`.

## Start and configure

Use Node.js 24.21.0. Copy the credential-free example into an ignored local root:

```sh
mkdir -p workspace
cp examples/host/host.json workspace/host.json
npm run dev -- --root ./workspace
# In another terminal:
npm run mbt -- --root ./workspace
```

For the built host run `npm run build`, then `npm start -- --root
./workspace`. The CLI continues to use source through `npm run mbt -- --root
./workspace`. Both commands default
to the current directory. The host accepts `--config FILE` to select another JSON
file; CLI only selects the installation root. `--help` requires no configuration
or service. Missing/invalid configuration fails before opening the host.

`npm link --workspaces=false` exposes `mbt` from the root package's `bin/mbt`
launcher. It resolves the linked checkout and invokes the same CLI source with
Node.js; no build is needed for the client. Run `mbt --root /path/to/workspace`
from any directory, or use the installation root as the current directory. The
launcher preserves that directory and never starts the host automatically.

`owners` lists the single owner's namespaced platform identities; the local
example uses `["cli:local"]`. Exactly one identity must be a `cli:` identity for
the terminal channel. Add the Telegram identity (`telegram:<user-id>`) when
configuring a Telegram private chat.
`agent` selects the Agent's ID, name, shared folder, instructions and explicit
model configuration. Optional `agent.resources.skills` selects directory IDs under
`groups/<folder>/skills/`; `agent.resources.tools` selects Pi built-ins (`read`,
`write`, `edit`, `bash`, `grep`, `find`, `ls`) and the configured web tools
(`web_search`, `fetch_content`). Omitted Skills select none; omitted
tools select `read`, `write`, `edit`, `bash`; an empty tool list disables built-ins.
Selecting a web tool requires matching `agent.web` configuration. The execution
harness is Pi; the model backend is specified separately by `model.provider` and
`model.id`. The central store uses schema version 5 for host routing, resource
selection, delivery attempts, lifecycle records and web configuration. Existing
schema versions 2 through 4 upgrade additively. The central store saves the model
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

A Telegram private chat is one more destination. Its `platformId` is the chat
ID, which for a private chat equals the owner's Telegram user ID. Configure the
corresponding `telegram:<user-id>` owner identity, the destination and the
host-side polling settings:

```json
{
  "owners": ["cli:local", "telegram:42"],
  "destinations": [
    { "id": "terminal", "channelType": "cli", "platformId": "local", "instance": "cli" },
    { "id": "owner-chat", "channelType": "telegram", "platformId": "42", "instance": "telegram" }
  ],
  "telegram": { "instance": "telegram", "botTokenEnv": "MYBOTS_TELEGRAM_BOT_TOKEN" }
}
```

`telegram.instance` selects the messaging-group instance served by one polling
channel; every `telegram` destination must use it. Each Telegram destination's
`platformId` must match a configured `telegram:<user-id>` owner, so only the
owner's private chat is admitted. `telegram.botTokenEnv` names the host
environment variable holding the Bot API token; the token is read from the
environment at startup, is used only by the host's Bot API client and never
enters runner mounts, instructions, mailbox records or diagnostics. A configured
Telegram destination with a missing token, a mismatched instance or an owner
that is not configured fails startup before any service starts.

The channel normalizes raw updates at the Bot API boundary, ignores non-text
updates, non-private chats, unknown senders and unconfigured chats, and advances
the polling offset past every returned update. Accepted input follows the same
host/mailbox/runner path as CLI and replies to its own chat, split at Telegram's
4096-code-point limit. Telegram and CLI share the Agent workspace but keep
separate persistent conversations. Polling retries a failed long poll and stops
with the host, aborting in-flight requests and awaiting dispatches.

`container.image` and `container.network` select an existing runner image and
internal Docker network. `gateway.url` is the host's OneCLI management endpoint;
`gateway.proxyHost` is the proxy-only hostname visible on the isolated runner
network. Optional `MYBOTS_ONECLI_API_KEY` and `MYBOTS_ONECLI_PROJECT_ID` are host-only
management settings. Put real model credentials and scoped policies in OneCLI,
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

## Local WebSocket interface

The optional `websocket` section starts an owner-local control and observation
interface for configured `websocket` destinations:

```json
"websocket": { "host": "127.0.0.1", "port": 8787, "path": "/ws" }
```

`host` must be a loopback address; this is not an Internet-facing endpoint. The
interface is owner-local by machine rather than by operating-system account: any
local process that can reach the loopback port is trusted as the configured
owner, matching the retained local WebSocket capability. Account isolation stays
with the CLI's mode-0600 socket. Omit
the section to run the host without it. Every configured `websocket` destination
must share one channel instance; the interface serves them all and resolves input
through the same central messaging-destination, Agent and session records as CLI.
A WebSocket destination therefore shares the Agent workspace and keeps its own
persistent conversation.

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

`Host.start({ root, configuration, driver })`, `accept`, `sessions`, `inspect`,
`reset({ destinationId, userId })`, `observe`, `attachChannel` and `stop` are the host boundary. The driver accepts
session material and an abort signal and returns an awaited stop/exit handle.
`CliChannel.listen` and `close` in `src/cli/socket-server.ts` own the local listener
and its connected sockets. The independent `src/cli/client.ts` parses CLI arguments
and starts `src/cli/chat.ts` for terminal prompts, input and reply display.
`src/cli/socket-client.ts` owns connection, newline-delimited JSON framing,
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

`src/index.ts` is the sole host startup entry point. It composes the CLI socket
service and configured Telegram and WebSocket channels. Use `dev` or
`start` once per installation root; `src/cli/client.ts` remains the independent
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
