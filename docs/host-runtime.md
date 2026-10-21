# Persistent host and local CLI

The host owns owner identities/role grants, Agent identity and workspace, messaging
destinations, destination-to-Agent wiring, container configuration and durable
Thread/Task/Run/Attempt records in `data/host.db`. The CLI connects to `data/cli.sock`; it opens no Agent
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
`groups/<folder>/skills/` and imports/pins those sources once at initial bootstrap.
Later source edits and startup-file changes cannot replace those revisions; use
the owner Skill panel to import and activate updates. `agent.resources.tools` selects Pi built-ins (`read`,
`write`, `edit`, `bash`, `grep`, `find`, `ls`) and the configured web tools
(`web_search`, `fetch_content`). Omitted Skills select none; omitted
tools select `read`, `write`, `edit`, `bash`; an empty tool list disables built-ins.
Selecting a web tool requires matching `agent.web` configuration. The execution
harness is Pi; the model backend is specified separately by `model.provider` and
`model.id`. The central store uses schema version 24 for host routing, Bot configuration,
availability, Threads, original messages, Tasks, Runs, Attempts and stable input admissions.
An older store containing sessions requires fresh runtime records; see the
[replacement instructions](../README.md#persistence-and-reliability). The central store saves the model
selector as `provider/id` plus its endpoint and token limits. Endpoints must use
HTTPS without URL credentials. Host configuration and gateway management material
are outside runner mounts.

Each `destinations` entry names a messaging group with `id`, `channelType`,
`platformId` and `instance`. It is wired to the personal Agent with shared session
mode, no threads and owner-only sender authorization. The `cliDestinationId` must
select a `cli` destination with platform ID `local`. Additional configured
messaging destinations route into the same Bot Thread through common admission.
Their per-input reply addresses remain independent.

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
updates, callbacks, topic messages, non-private chats, unknown senders and
unconfigured chats, and advances the polling offset past every returned update.
Ordinary Telegram text does not enter a Thread or answer a question. Pairing is
the only private message that changes Host state, and that code is not Agent input.

Pending owner questions and action approvals create notices for the requesting
Bot. Known completion and terminal failure notify for Routine occurrences and
root Runs that entered durable collaboration waiting. Successful children and
source-handled child failures contribute counts to the root report without
separate final alerts. Uncertain outcomes require owner attention in the producing
Bot's topic. Child attention notices retain source-chain links to their owned
parent work. Immediate chat replies and tool progress remain in the client.

Notices include a concise summary, Bot/Task/Run/request identity and a local
client locator. Occurrence notices also identify the Routine, and explicit retries
identify the previous Run. The client displays each notice's eligibility and
independent delivery progress with topic repair and manual resend. The generic
resend operation is `POST /api/bots/:botId/notices/:noticeId/resend`, with a stable
`requestId`. The question-specific resend route remains available.

Private topic mode comes
from `getMe` `has_topics_enabled`, including for a question that is already
pending when the owner chat is attached. The Host keeps that Bot's private-chat
topic, the notice's eligibility, attempt count, retry time and delivery outcome
apart from the Run. It sends at most three times, waiting five
seconds and then thirty, or longer when Telegram states `retry_after`. Restart
does not revive an exhausted notice. The owner can repair a deleted topic or
unavailable topic mode from the client and resend a failed notice. Acceptance by
Telegram is not a read receipt and does not promise that only one copy arrived.
A delivery failure does not change the Run outcome. An unsent notice is
suppressed once a decision request is resolved, expires or is cancelled; unsent
uncertainty notices are suppressed after explicit retry or closure. Logical Bot
deletion retains topic mappings and accepted notice history, and a same-name
replacement receives its own identity and topic. Polling
retries a failed long poll and stops with the host, aborting in-flight requests.

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

Each Bot owns one direct Thread. An ordinary send atomically appends to its latest
eligible conversational Run or creates a new Task/Run. New task always creates
independent work; explicit Task input retains that target. Terminal work is not
implicitly retried. A stable request ID fixes the input association even when a
response is lost or completion races admission.

Internal executor sessions use Run IDs. Directional mailboxes and SDK state live
at `data/sessions/<bot_id>/<run_id>/`; shared workspace files remain at
`groups/<folder>/`. Task attachments live at
`data/task-attachments/<bot_id>/<task_id>/`, under the uploaded file name, and are mounted read-only at
`/workspace/group/.task-attachments` only for Runs of that Task. They are not
copied into another Task, another Bot, or the model prompt. The owner can save
one attachment into a relative path in that Bot's workspace; that copy is then
available to the Bot's other Tasks. The reserved workspace path
`.task-attachments` is not a shared save destination. A workspace listing returns at most 1000 regular files, and a workspace-save request must stay within 64 KiB. One actual Attempt per Bot holds an execution slot from
admission until that Attempt ends. Unconfirmed stop keeps the slot. A durable
wait releases it only after every recorded tool call has a result and no tool is
still current; an idle container is not execution. Excess runnable work stays in
a durable queue. When both classes are waiting, interactive and background work
alternate, and a Bot that has executed less recently is admitted first, so
neither a class nor one Bot can starve the others. New and resumed work does not
preempt an active Attempt. The Host runs at most four Attempts at once unless
`admission.activeExecutionLimit` sets another integer from 1 to 64. Lowering the
limit does not stop Attempts that already started. Other Bots progress inside
the remaining slots.

New Runs capture a background boundary and source-message identity. Mybots selects
at most 200 recent original candidates before the source and up to seven reference
groups, plus the current input. References are labelled quoted data. The runner
uses a conservative UTF-8 byte token bound including system/tools and output
reserve: remove older references before live inputs or steering. Required input
that cannot fit fails visibly. Pi owns subsequent Run compaction.

Active additions use SDK steering at a model boundary without interrupting tools.
Input IDs are recorded in the SDK ledger; mailbox recording evidence follows
SDK persistence, never memory queue insertion. Later Attempts reopen the same
Run ledger, recovering a saved final answer without repeating known tools.
Incomplete tool evidence fails visibly. A closing query leaves unconsumed additions
pending in the same Run. An acknowledged output gap holds the affected Run as
uncertain; unrelated work may proceed once execution has stopped.

Delivery remains independent of execution, sequential within each Run and
independent across Runs. Per-input channel/platform routing remains authoritative.
Acknowledgements continue to be mirrored while delivery is held.

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
failures return 1. `/reset` captures a chat background boundary for later
conversational Runs and confirms that boundary on the terminal. It does not
cancel existing Runs or replace their ledgers. Other slash input remains
ordinary Agent text.

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

`GET /api/bot-summaries` returns authenticated `{ bots }` for navigation, including
stable identity, availability, creation and activity timestamps, a latest ordinary
chat message (`id`, `role`, plain-text `excerpt` of at most 200 characters, and
`createdAt`), plus `working` and `attention` booleans. Empty Threads return a null
message and use Bot creation time for activity. Rows sort by activity descending,
then Bot ID ascending. Routine/delegation output, selection and configuration
saves do not advance chat activity. Active/stopping Runs mark working; pending or
expired questions, pending or expired action approvals and uncertain/held Runs mark attention.
This query reads SQLite originals without opening SDK sessions. Schema version 28
adds read indexes for these lookups and retains existing records and file paths.

The sidebar filters names locally and separates disabled Bots and retained deleted
identities. Row right-click and ellipsis menus expose inspection and applicable
lifecycle actions. Logical deletion requires a retention disclosure and confirmation.
An unconfirmed lifecycle response retains its exact Bot, operation and request ID
with an explicit retry control, including after reload and logical deletion.

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
Bot's saved and effective configuration. Creation does not start a session or container.

`POST /api/bots/<id>/settings` changes that Bot's role, approved model and tools:

```json
{
  "requestId": "edit-researcher-1",
  "instructions": "Cite sources before answering.",
  "model": { "provider": "deepseek", "id": "deepseek-chat" },
  "tools": ["read"]
}
```

The first save returns 201 and `{ requestId, bot, replayed: false }`. The Bot
exposes `savedVersion`, `effectiveVersion` and the effective role, model and
tools. An identical retry returns 200 with `replayed: true`, including after
Host restart. A reused request ID with different settings returns 409. Unknown
fields, including per-Task or per-Run overrides, endpoints and credentials,
return 400. Installation startup still does not overwrite a saved version.

Saving establishes a finite cutoff. The open Attempt and steering admitted
before that save finish under the Attempt's configuration version. Input
admitted afterward stays on the same Task and Run and is not delivered until
the next Attempt. Further input or another save does not extend the cutoff.
The next Attempt, including continuation of the same Run, replaces the stopped
session's immutable context, reopens that Run's SDK ledger and records the
latest saved version. An incompatible model or history continuation fails
visibly and leaves the ledger and original history in place.

### Direct Thread and Task/Run outcomes

Selecting a Bot opens its single Thread. The client offers ordinary send,
independent New task and explicit input targets for active/queued chat Tasks.
It retains unconfirmed request payloads before sending and offers recovery after
response loss or reload. The old `/api/sessions` operations return 404.

| HTTP operation | Request / response |
| --- | --- |
| `GET /api/bots/<id>/thread` | `{ thread, tasks, messages }` with original message IDs and linked Run IDs. |
| `POST /api/bots/<id>/thread/messages` | `{ requestId, text }`; 202 with `{ requestId, botId, threadId, taskId, runId, messageId, replayed }`. |
| `POST /api/bots/<id>/thread/tasks` | Same payload/response; always creates independent work. |
| `POST /api/bots/<id>/tasks/<taskId>/inputs` | Same payload/response; appends only to that Bot's eligible Task. |
| `POST /api/bots/<id>/runs/<runId>/stop` | `{ requestId }`; 202 acknowledges a stop. The Run stays `stopping` until termination is confirmed. |
| `POST /api/bots/<id>/tasks/<taskId>/stop` | Same payload; stops that Task's unfinished Run. |
| `POST /api/bots/<id>/runs/<runId>/retry` | `{ requestId }`; confirms stop, preserves the old outcome, and admits a linked Run under the same Task. |
| `POST /api/bots/<id>/runs/<runId>/close` | `{ requestId }`; resolves an uncertain Run without creating another Run. |

Messages allow 32,000 characters within a 256 KiB JSON limit. Unknown fields,
including configuration overrides, return 400. A reused request ID with changed
payload or target returns 409; unknown Bot or foreign Task returns 404. A terminal
Task rejects new targeted additions, while a retry of an already accepted request
returns its original association. Ordinary Thread sends remain usable after
prior completion, failure or stopped uncertain work.

Each Task exposes origin and Runs. Runs expose state (`queued`, `active`,
`stopping`, `succeeded`, `failed`, `uncertain`, `closed`), source message,
captured background boundary, prior Run link, stop error, held Routine flag,
late evidence, input identities, durable recording timestamps, final outcomes
and Attempts. Each Attempt exposes fenced incarnation, the effective configuration
version it started with, start and confirmed end. Outcomes correlate to final
mailbox evidence, never queue acceptance or partial text. `stopping` remains
until the executor's stop completes; a failed stop keeps that Bot's serial slot
and reports `stopError`. Confirmed stop with an acknowledged input and no final
output becomes `uncertain` and `held`. `held` records that a later Routine
occurrence must not start. One-shot definitions admit only one occurrence Task. Unrelated Tasks of the same Bot may then run. Ordinary Thread
sends do not retry or close that hold. Explicit retry confirms stop, keeps the
original outcome, and creates one linked Run. Explicit close records the same
uncertain outcome as `closed` without a new Run. Output that arrives after a
closed or uncertain Run is late evidence and does not revive it. A saved Bot
configuration applies on the next Attempt, including continuation of the same
Run, after the finite cutoff described above. Complete original history, lexical
retrieval and live execution previews are described below.

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
instance and input uses the same Thread/Task/Run admission as CLI.

### Original history and Run evidence

`GET /api/bots/:botId/thread/history` returns up to five original messages,
source IDs/sequences/roles/times/Run IDs, linked Run states and outcome-message
anchors, coverage and cursors. Without an anchor, pages are newest first;
`beforeSeq` continues older pages. `query` performs case-insensitive NFKC-normalized
substring conjunction over whitespace-separated terms, including Chinese phrases.
It is local lexical matching, with no semantic ranking or embedding service.

`messageId` authorizes an original anchor. `direction=around|older|newer` reads
actual same-Thread neighbors; `textOffset` reads only that anchor's next excerpt.
Read pages use 2,000 Unicode code points per message and search uses 800.
Complete history JSON is bounded to 10,000 UTF-8 bytes, including escaping;
`truncated` and `nextTextOffset` identify shortened text. Follow text offsets to
recover full originals and sequence/anchor cursors to cover the requested range.
An exhausted query/page does not prove absence outside its range or keywords.

`GET /api/bots/:botId/runs/:runId/history` returns up to five stable `records`
with `nextAfter` pagination. `after` continues the record list; `recordId` and
`textOffset` continue one long record. `kind=inputs|attempts|records` selects
admitted input originals, Attempt identities/configuration/timing, or SDK-recorded
input/assistant/tool-call/tool-result evidence. The same 2,000-character and
10,000-byte bounds apply. The Thread snapshot contains bounded previews of the
latest five messages and the first five inputs/Attempts per Run; inspect these
paged endpoints for complete evidence. Run summaries label truncated replies.

The runner projects stable SDK entry/block identities after recording, omitting
historical seed references, hidden reasoning, system prompts and provider-only
payloads. Original tool calls/results remain separate from Thread conversation
and survive SDK compaction. Reads never execute or mutably reopen an SDK session.

Production `search_history`, `read_history`, `create_routine`, `manage_routine`, `ask_question`, `publish_progress`, `publish_result`
and `read_operation` tools use the same correlated directional mailbox requests.
The Host derives Bot/Task/Run/Attempt scope from the owned execution mailbox and
its open Attempt, and checks the actual executor incarnation. Payload identity
fields, privilege grants, Bot administration and cross-Bot administration are
rejected. Progress and a selected result keep their request identity:
repeating that identity, or calling `read_operation` after a timeout, returns the
stored record and does not publish another copy. A late or cancelled request
cannot change the Run outcome or make cancelled work active again. Progress and
selected results are not searchable conversation text and are not the Run outcome.

Search is bounded by the Run's captured background boundary and excludes
its source message and all later messages; anchor reading may include later
corrections in the same authorized range. Unknown/cross-Bot anchors and stale
executors cannot widen that scope. Historical text is untrusted reference data,
not instructions or approval. Outcome anchors use the same original-reading
boundary.

## Persistent owner questions

The Agent's `ask_question` tool accepts a stable `requestId`, required question
text (up to 2,000 characters), and an optional explicit timestamp `deadline`.
The Host derives Bot, Task, Run and Attempt from the fenced execution and saves
its question in `data/host.db`. `read_operation` with that request ID retrieves
the same question after a timeout. Questions appear in the Task's Run card in
the Web client, with separate answer controls.

`POST /api/bots/:botId/runs/:runId/questions/:questionId/answer` accepts
`{ requestId, text }` under the same credential and Host/Origin checks as other
owner operations. Its durable identity recovers a lost response; a different
answer request cannot settle a resolved question again. Ordinary Thread text
and targeted Task additions do not answer a question. Additions to waiting
Tasks retain their Run and wait for its continuation.

The runner ends the SDK query after the entire current tool batch has recorded
its results. Only complete tool evidence plus confirmed executor termination
allows the Host to end the Attempt and release Bot/global capacity. Waiting
spends no Run budget. Unanswered required questions prevent success. Waiting
survives browser disconnection and Host restart indefinitely by default; an
explicit deadline marks a question expired and leaves the Run waiting for owner
attention. The owner can stop that Run before explicitly retrying it.

After all required questions are answered, the same Run joins the fair queue.
Its next Attempt records current Bot configuration, reopens its SDK ledger and
supplies correlated answers through the SDK's normal input path with current
Memory. Recorded inputs and known tools are not deliberately replayed. Stop
cancels unresolved questions and fences late answers; a repeated answer receipt
never revives stopped work. These records do not remove the documented crash
windows or establish exactly-once tool effects.

## Bounded nested delegation

The owner sets each source-to-target direction to deny, ask-each-time, or allow. The default is
deny, including when no row exists. A Bot cannot grant itself, and a runner
operation cannot change the policy. Ask-each-time requires an exact local action approval.
`POST /api/bots/:sourceBotId/collaboration/:targetBotId` accepts
`{ requestId, mode }` where mode is `deny`, `ask-each-time`, or `allow`. The Web page saves that
direction for the selected Bot. The opposite direction stays independent.

`delegate` accepts a stable `requestId`, the target Bot ID, selected text of
up to 32,000 characters, and an optional `files` list of at most 16 Task
attachments or delivered artifacts from the delegating Task. The Host copies
that text into a new Task and Run owned by the target Bot. Selected bytes are
copied into the receiving Task's attachment directory with the source Bot, Task,
Run, and delegation. The child does not receive the source workspace, source
Host paths, source chat, unrelated files, or a source mount. Same-Bot workspace
saving remains a separate operation and does not cross Bots. A denied request is
stored on the parent Run and returned again for the same selected text and files;
it does not create a child. Ask-each-time keeps the file selection on the exact
approval and copies those bytes only when that approval creates the child. A
later change to the source, including a same-length rewrite, leaves the approval
stale and copies nothing. The
delegation records the source Bot, target Bot, parent Task, parent Run,
originating Run, and child Task/Run. A specialist may delegate to a reviewer, with a maximum of two
edges from the originating Run. Each edge checks its own directed permission;
requests to any ancestor Bot and requests beyond that depth fail explicitly.
Returning a child result does not require the reverse direction or add an edge.

At most eight delegations, including descendants, are admitted per originating
Run. This counts completed, failed and cancelled children as well as unfinished
ones; denied requests do not create children or consume that count. Pending
approval proposals do not consume an admission. Executing an approved proposal
rechecks ancestry, depth and the current total before creating its child; an
outdated proposal becomes visibly stale without exceeding the bound. The stored
admissions survive Host restart, steering and Attempt replacement. Each child Run
has its own active budget. An explicit child retry keeps the same Task and
originating chain, receives a fresh Run budget, and preserves the previous
outcome. It is permitted only while every owning ancestor still accepts work;
old Run evidence cannot overwrite the new Run's delegation result.

After the current tool batch has complete results, the runner ends the Attempt.
The Host records the dependency wait, stops that executor, and releases active
capacity and Run budget. The same parent Run becomes runnable when every owned
child is succeeded, failed, or cancelled. The next Attempt uses the effective Bot
configuration and current Memory, reopens the parent ledger, and receives the
correlated child outcome. A child failure or denial does not by itself succeed or
fail the parent. An uncertain child holds every waiting ancestor for owner
handling. The client identifies that hold and retains the child Task links.
Closing or successfully retrying the uncertain child lets the chain settle
without restarting a cancelled ancestor. A pending question also keeps it waiting. Ordinary Thread chat is not added to a child Task; an
owner addition has to target that Task and does not settle the parent dependency.

Stopping the parent immediately blocks new descendant admissions. It confirms
stop of unfinished owned children at each level before settling the ancestors,
retains completed effects and unrelated work of the target Bot, and keeps a late child result from
starting the parent again. These records do not establish exactly-once effects.

## Exact delegation action approvals

Under ask-each-time policy, `delegate` persists its selected text, target Bot,
source Task/Run/Attempt, and optional explicit ISO 8601 `deadline`. It creates no
child until the owner approves. The Run card shows the operation, concrete inputs,
request identity, source links, deadline and decision. Approve action and Deny
action are separate local controls; Thread text, targeted additions and runner
operations cannot authorize them. `read_operation` with the original request ID
retrieves the durable delegation and its approval after an unconfirmed response.

`POST /api/bots/:botId/runs/:runId/approvals/:approvalId/decision` accepts
`{ requestId, decision, operation, targetBotId, text, deadline }`. Decision is
`approve` or `deny`; operation is `delegate`; the target, text and deadline must
match the stored card exactly, including `null` for an indefinite wait. Approval
request bodies allow up to 256 KiB so the delegation's 32,000-character limit also
works for multibyte text and JSON escapes. A reused
operation identity cannot change its inputs. Use a new request and owner decision
for changed inputs. The local client's credential and Host/Origin checks apply.
Repeated decision receipts are idempotent; other late or conflicting decisions
fail without another child. The browser saves an unconfirmed decision so reload
can retry its original identity.

Approval and execution are distinct durable states. After the complete tool batch
has ended the source Attempt, the Host rechecks the waiting Run, unchanged inputs,
current approval and current directed permission. Creating the child Task/Run and
marking the approval executed share one SQLite transaction. A crash before this
commit leaves no admitted child; a crash after it retains that child identity.
This covers Host admission, not exactly-once child tool effects. Unknown child
outcomes remain visible and hold the source for owner handling rather than
repeating the operation. All settled child results continue the same source Run.

Waiting has no default deadline and survives browser and Host restart without
consuming active capacity or budget. An explicit deadline expires a pending or
approved but unexecuted request without creating a child, leaving its Run needing
attention. Stopping the Run cancels its unresolved approvals and fences late
decisions. Changing the direction to deny permanently invalidates pending and
approved but unexecuted requests; restoring permission requires a new request and
decision. The same transaction records revocation on unfinished admitted delegations
and marks their owned child Runs and descendants stopping. The Host requests
executor termination immediately, without waiting for runner configuration cutover.
The client retains the revoked direction and shows stopping until termination is
confirmed. Failed termination retains the target Bot's serial capacity; a repeated
permission request or Host restart continues the persisted stop. A confirmed stop
releases unrelated Tasks even when affected outcomes remain uncertain. Correlated
source results identify revocation and retain uncertainty for owner handling.
Restoring permission cannot retry revoked child work; a new delegation is required.
Already completed effects, delivered artifacts and other directions remain intact.
Late child evidence remains inspectable and cannot revive cancelled Runs. Owner denial returns correlated source
evidence and suppresses identical automatic requests within that source Run.

This approval governs the controlled Host delegation action. It does not intercept
arbitrary effects of otherwise permitted shell, file or network tools.

## Local WebSocket interface

Connect to the configured path with the same credential and Host/Origin checks.
A WebSocket destination enters its Bot's Thread through the same admission. This existing input protocol remains available to authenticated
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

Authenticated `execution` WebSocket envelopes carry `botId`, `threadId`,
`taskId`, `runId` and a bounded `snapshot` (`id`, executor `incarnation`, `text`,
Unicode `textOffset`, current `tool`). The runner publishes accumulated previews,
so a missed frame does not require concatenating subsequent fragments. A preview
is progress only; the persisted Run outcome establishes completion. The browser
repairs missed frames and reloads from HTTP snapshots, including after Host
restart. Preview text can be shorter than the complete recorded originals.

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
`threadDetail`, `sendThread`, `observe`, `attachChannel` and `stop` are the host boundary. The driver accepts
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
Bot API polling for one Telegram instance and attach independent notice delivery;
`dispatch` ignores ordinary text, topic messages and callbacks. `runHost` starts the Telegram channel when `telegram`
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
with one retained Thread and independent Run contexts. `verify` includes the same
bounded demonstration and executable help/configuration-failure checks. Host
integration tests use real central/session SQLite and the same driver boundary.
`tests/host-telegram.test.ts` drives the channel with a controlled Bot API:
ignored text, topic messages and callbacks, offset advance, cancellation,
restart, token containment and entry-point wiring. `tests/question-notices.test.ts`
drives decision, outcome and uncertainty notices through that HTTP boundary. No test contacts Telegram
or uses a real token. These checks do not
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
Use the selected Bot's **Local Skills** panel to import an absolute directory on
this Host. The authenticated `POST /api/bots/:botId/skills` operation accepts
`{ "id": "brief", "path": "/absolute/local/brief" }`; `GET` on the same route
returns inspectable revisions and base64-encoded file bytes. A Skill directory
contains `SKILL.md` with Pi-native `name` and `description` frontmatter, plus any
supporting files. Import rejects links, special files, excessive nesting, more
than 256 files or 4 MiB. Binary supporting files retain their bytes.

Imports create Bot-owned, content-addressed snapshots in
`data/skills/<botId>/`. Reusing a source for another Bot requires an explicit
import for that Bot. Editing the source, including an Agent's proposed files in
its workspace, cannot change an imported revision. Import alone does not activate
content or change tools or privileges.

Inspect the files, select one revision per Skill ID in Bot configuration, and
save. The settings API accepts `skills: [{ "id": "brief", "revision": "<sha256>" }]`;
`skills: []` disables all Skills. Omitting the field preserves the selection.
Saved and effective settings show the exact revisions. A save uses the existing
finite steering cutoff: the old Attempt finishes under its captured version,
and the next Attempt reopens the same Run with the saved revisions.

Before launching a stopped Run, the Host copies selected snapshots into
`data/protected-skills/<botId>/<runId>/`. Docker mounts this directory read-only
at `/session/skills`, outside the writable workspace and with no writable source
alias. Pi loads these selected resources on Run creation/reopening. Invalid or
missing selected resources fail execution before model traffic. Proposed files
remain ordinary working material until the owner imports and activates them.

Long conversations use Pi's default automatic compaction and SDK-owned history.
Reopening the explicit `pi:` continuation restores the retained summary and
messages. The Host selects quoted original Thread references for new Runs; within-Run
context and compaction remain SDK-owned. Conversation messages are not copied
into shared files. Persist working materials
explicitly when they should be accessible from another session.

## Long-term memory

Each Bot's workspace holds readable Markdown at `memory/index.md`,
`memory/definition.md`, and `memory/topics/<id>.md`. The Bot maintains those
files with its ordinary read, write, and edit tools. No separate approval is
required. Another Bot's workspace is not mounted, so its memory is not supplied.

Execution loads at most 16,000 characters from the index and 16,000 from the
definition, states the omitted count, and names topic files without copying
their text. The next turn reads the files again. If they differ from the memory
last supplied to that Run, the prompt says the current text supersedes older
recollections. Deleting a file stops that load. The Run ledger and earlier
transcript stay. This does not guarantee forgetting, and a later save can record
a fact again.

`GET /api/bots/:botId/memory` returns the files. `PUT` and `DELETE` on
`/memory/index`, `/memory/definition`, and `/memory/topics/:id` send
`{ "content": "...", "version": "<sha256>" }`. `version` is the hash from the
read, or `null` when creating a missing file. A mismatch returns 409 with the
observed file so the client can reread it. The UI shows that observed text and
does not overwrite the draft until the owner loads it. These checks do not lock
the workspace; an Agent write can still land between the read and the save.
Delayed reads and status refreshes also preserve unsaved editor drafts.

The browser section **Long-term memory** edits and deletes the same files. Its
wording states that deletion is not history erasure or guaranteed forgetting.

## Run execution budgets and idle resources

Each Run has a sixty-minute cumulative active-execution budget. The Host starts
accounting with each Attempt and checkpoints spent milliseconds in SQLite.
Steering keeps the same budget; configuration replacement and later Attempts
continue its accumulated time. Queue time, completed durable waits and stopped
Host intervals do not spend execution time. A surviving executor adopted after
Host loss continues its open accounting interval. When no executor survives,
recovery retains the last durable checkpoint and excludes the unobserved interval;
a hard crash can lose the fraction between the last checkpoint and termination.
Explicit owner retry creates a linked new Run with a fresh budget.

Exhaustion persists its time, enters `stopping` and uses the same confirmed-stop
path as an owner stop. A possible live executor retains Bot/global capacity.
Confirmed termination releases capacity while retaining original results, working
files and uncertain-outcome holds. Thread API reads expose `budget.limitMs`,
`budget.activeMs` and `budget.exhaustedAt`; the Web client displays active minutes
and the exhaustion reason. These limits have no Task/Run overrides.

The Host immediately stops completed Run containers rather than retaining an
idle cache. This keeps retained idle containers at zero, within the maximum of
four and the five-minute idle lifetime. Complete durable waits also stop their
executor before releasing capacity. A failed stop retains the reservation and
reports unconfirmed termination; it is not counted as an idle cached container.

## Delivered artifacts

`publish_result` accepts a summary and optional `files`, an array of up to sixteen
Bot-workspace-relative paths. The Host rejects absolute, escaping, attachment-mount
and symbolic-link paths and applies `files.maxBytes` (25 MiB by default) to each
file. It copies the chosen bytes outside the workspace and commits their metadata
with the selected result. These results remain separate from the Run outcome.

Thread details include each result's Bot, Task, Run, the delegation that owns
the producing Run when the result came from delegated work, and that delegation's
originating Run,
and artifact IDs, relative names and byte sizes. The browser shows the summary
and download links. Authenticated
`GET /api/bots/:botId/runs/:runId/artifacts/:artifactId` returns the saved bytes as
an attachment and rejects a different Bot or Run. No Host storage path is exposed.
Workspace replacement and Host restart do not change a delivered version.


## Routines

The selected Bot's Web page creates one-shot or cron Routines. One-shot creation uses work instructions,
an absolute ISO 8601 instant with offset, and a supported IANA timezone. The
resolved UTC instant, timezone, next occurrence and source are visible before
execution. An unresolved phrase or invalid calendar date is rejected. An instant
already in the past is due immediately; timezone is retained as the resolution
and display context and never shifts that instant.

Authenticated `GET /api/bots/:botId/routines` lists definitions and occurrence
Task links, including each occurrence's admitted due time. The list also returns the
current Bot timezone. `POST` accepts `requestId`, `text`, `runAt`, `timezone`, and optional
`selectedMessageIds` (up to seven authorized originals). Reusing the owner
request with different instructions or schedule returns a conflict. A lost
response can be recovered with the same saved request, including after browser
reload. The Agent's `create_routine` tool resolves natural-language intent into
these explicit fields, reports the resolved schedule and creates work only for
its own Bot. The Host derives creation-source Task/Run/Attempt from the fenced
execution. `read_operation` retrieves that Run's creation request after an
unconfirmed timeout; reissuing it does not create a second Routine. Independent
Routine creation survives source cancellation.

The Host checks persisted due definitions on startup and its reconciliation
pass (every sixty seconds by default). Consuming the one-shot due time, saving
the admitted definition, creating its distinct Task/Run and enqueueing background
work share one SQLite transaction. An existing overdue definition therefore
admits one occurrence after restart. The definition remains inspectable after
success, failure, cancellation or uncertainty; no second automatic occurrence
is generated. Each Task retains the one-unfinished-Run constraint through
queueing, waits, stopping and uncertainty.

Occurrence execution uses the existing fair admission, one-Attempt-per-Bot,
global limit, cumulative active budget and confirmed-stop rules. Its fresh
Run-local SDK ledger receives Bot identity, workspace/current Memory and explicit
selected inputs, without implicit direct-chat or previous-occurrence context.
Occurrence bodies stay in Task/Run evidence; the Thread presents linked work
summaries separately from chat originals. Explicitly selected earlier occurrence
originals remain accessible to that Run's history tools, including paginated
reading, while default Thread history excludes them. Ordinary Thread input selects chat
work; explicit Task additions target the occurrence through the same durable
queued/active/waiting input path and never edit the Routine. Known failures are
retained, and acknowledged unknown effects are held for inspection rather than
automatically replayed. Pausing a Routine blocks later automatic starts and lets
the current occurrence finish. Resume selects the next future cron slot and does
not replay slots missed while paused. An overdue paused one-shot runs once on
resume. Run now admits one occurrence with the current definition while paused
and does not enable recurrence. It is refused while that Routine has unfinished
work. Editing text or schedule changes only occurrences admitted afterward;
queued and active Tasks keep the definition captured at admission. Bot settings
still change at the next Attempt boundary. Stopping one occurrence does not
pause or delete its Routine.

`POST /api/bots/:botId/routines/:routineId` edits with `requestId`, `text`, and
either `cron` or `runAt` plus `timezone`. `POST .../pause`, `.../resume`,
`.../run` and `.../delete` take `{ requestId }`. Run returns 202; the others
return 200. A reused request does not apply the command again. A different payload for
that request returns 409. Logical deletion sets `deletedAt`, stops queued, active,
waiting and stopping owned Runs, leaves uncertain Runs held, clears future starts,
and keeps the definition, occurrence links and results in the list. Further edit, pause, resume and run requests are rejected.
The same operations are available to the owning Bot as `manage_routine`. The
Host derives the Bot from the fenced execution and rejects forged identity and
cross-Bot administration. `read_operation` returns a recorded lifecycle command
by its request id.

Cron creation replaces `runAt`/`timezone` with `cron`; supplying both schedules or
an override timezone is rejected. The Web form offers hourly, daily at 09:00,
weekdays at 09:00, and custom cron. Every occurrence creates a separate Task/Run
and captures the definition and due time admitted, including the resolved timezone.
`runAt` on a cron definition is its first resolved instant; `nextOccurrence` is
its currently armed future slot, or null while an occurrence is unfinished.
Each occurrence link leads to its own results. Failure and cancellation preserve
the definition and re-arm it after confirmed stop. Queued, active, waiting,
stopping, uncertain and retried work all share the same Routine exclusion;
retrying an older occurrence conflicts while a newer occurrence is unfinished.

The Host arms the next cron slot strictly after its current clock when the prior
occurrence is known terminal and its execution reservation has been released.
Slots missed while unfinished never accumulate. Restart admits one already
armed overdue occurrence, regardless of how many slots passed. It does not
replay each historical slot, nor silently replay an uncertain occurrence.

`POST /api/bots/:botId/timezone` accepts `requestId` and `timezone`, validates a
supported IANA zone and saves the Host scheduling setting independently of
runner configuration. The fallback is Asia/Shanghai. Saving recomputes armed
future cron slots immediately; an unfinished occurrence remains held and uses
the new zone only when it ends. Admitted definitions/inputs, one-shot instants,
SDK context and configuration versions stay fixed. Retries of the same timezone
request do not recalculate the schedule again. This operation is owner-only and
uses the same credential/Host/Origin checks as other management operations.

### Cron parser and daylight saving

The Host pins `cron-parser` 5.10.2. Expressions have five fields (minute, hour,
day of month, month, weekday), with implicit second zero. Numeric values,
wildcards, ranges, lists, steps, names and the parser's day selectors use its
standard non-strict semantics: restricting both day of month and weekday matches
either. Seconds fields, `@` macros, `?` and randomized `H` are rejected. Invalid
or impossible calendars fail creation. There are no interval or other schedule
types. Parsing always uses an explicit clock instant and the Bot timezone.

DST follows the pinned parser, without an extra wall-clock deduplication layer.
For `30 2 * * *` in America/New_York, the March 8, 2026 gap resolves to 03:30 EDT
(07:30Z); the next day returns to 02:30 EDT (06:30Z). For `30 1 * * *`, calculating
before the November 1 fold selects the first 01:30 (05:30Z). Recalculating at
05:30Z or 05:40Z skips to November 2 at 06:30Z. Recalculating during the second
fold, such as November 1 at 06:10Z, can select the second 01:30 (06:30Z).
Consequently a long occurrence that finishes inside that second fold can be
followed by the repeated local slot; it still cannot overlap or build a backlog.
Timezone database rules come from the runtime's Intl support and the parser's
Luxon dependency. Controlled-clock public tests lock these concrete cases.
