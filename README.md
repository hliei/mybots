# mybots

A persistent owner-local host routes CLI conversations to isolated Pi Agent
sessions. The host saves destination/session affinity in SQLite, and every
terminal reconnect continues the same conversation. Agent sessions share their
Agent's workspace while keeping separate Pi conversation files.

The bot entry point still embeds its existing runtime for Telegram and WebSocket
while those adapters are being moved to the host. Its configuration and storage
are separate from the new host/CLI path.

## Setup

Use Node.js 24.21.0, pinned in `.nvmrc`, and npm. With nvm installed:

```sh
nvm install
nvm use
npm ci --ignore-scripts
npm run prepare
```

If Node.js 24 is not installed, npm can run a command with a temporary runtime:

```sh
npm exec --yes --package=node@24.21.0 -- npm ci --ignore-scripts
npm exec --yes --package=node@24.21.0 -- npm run prepare
npm exec --yes --package=node@24.21.0 -- npm run verify
```

Direct dependencies use exact versions. Commit `package-lock.json`
with dependency changes. To install or update dependencies locally, use
`npm install --ignore-scripts` and review the resulting changes. Run
`npm run prepare` afterward to install or refresh the Husky Git hooks.

## Development

```sh
npm run dev:host -- --root ./workspace
# In another terminal:
npm run dev:cli -- --root ./workspace
npm run dev:bot -- --workspace ./workspace
```

These commands run TypeScript source directly using Node.js native type
stripping. Restart the command manually after changing code. Pass `-- --help`
to print help without loading configuration or contacting a service.

## Offline Pi session demonstration

```sh
npm run demo:pi
```

This builds the Agent runner workspace and executes the real Pi SDK against a
local controlled streaming model service. It writes a note in a temporary Agent
workspace, returns a final reply, then creates a new SDK session object to reopen
the saved conversation and its tool result. It cleans up its service and temporary
state. No account key, paid request or Docker installation is needed.

The provider supports one prompt per query, initialization with a `pi:`
continuation, intermediate activity/text/tool progress, a final result and awaited
abort/disposal. Pass a session-local directory separately from the shared working
directory; continuation selects its exact SDK file and never a recent log.
Use `data/sessions/<agent_group_id>/<session_id>/pi/` for session state and
`groups/<folder>/` for shared materials. SDK built-in tools use the working
directory; filesystem confinement will come from the container boundary.

This slice establishes SDK execution and persistence. CLI routing now uses the persistent host; bot routing still uses
the embedded runtime until its channel integration is delivered. SDK resource
selection, multi-input queries, host/channel integration and live DeepSeek
acceptance are subsequent work.

## Isolated mailbox and gateway check

```sh
npm run test:infrastructure
```

This opt-in check requires Docker and `openssl`. It builds the production Bun
runner, starts disposable OneCLI and controlled streaming services, verifies a
workspace tool round and persisted mailbox reply, then recreates the container
to reopen the same Pi conversation. It uses generated fixture credentials and
makes no paid requests. Ordinary verification remains offline and excludes this
suite. See [container execution](docs/container-runtime.md) for configuration,
mount ownership, completion semantics and cleanup.

## Persistent host and CLI

```sh
mkdir -p workspace
cp examples/host/host.json workspace/host.json
npm run dev:host -- --root ./workspace
# In another terminal:
npm run dev:cli -- --root ./workspace
```

Configure the existing runner image, isolated Docker network and OneCLI gateway
in `host.json`; real model credentials remain gateway-owned. The terminal connects
to the owner-only `data/cli.sock`. Enter one message per line; `quit`, `exit`, `q`,
EOF or Ctrl+C disconnect the client while Agent work stays on the host. A newer
client replaces the old terminal on its first valid message. CLI reconnect and
host restart reuse the saved conversation. Disconnected replies remain in the
mailbox without guaranteed terminal replay.

See [persistent host](docs/host-runtime.md) for configuration, public interfaces,
SQLite entities, conversation ownership, failure and cleanup behavior. Run
`npm run demo:host` for a controlled compiled input/reply/reconnect/restart demo;
its mailbox driver fixture requires no Docker or model credentials.

## Embedded bot runtime

The following configuration, commands, tools and JSONL/event-runtime contracts
apply to the remaining embedded bot runtime and its programmatic APIs. They do
not configure the persistent host or CLI, whose state is described above.

Workspace settings preserve `llm`, `default_agent`, `agents_path`, `skills_path`,
and `history_path`. Relative paths resolve against the Workspace. Optional
`web_search` enables search; `fetch_content: {}` enables content fetching. The legacy
`websearch` and `webread` settings fail startup with migration instructions,
including when new settings are also present.

Workspace configuration overlays `config.user.yaml` with `config.runtime.yaml`.
Mappings merge recursively; runtime scalars, lists and nulls replace user values.
The complete candidate and the default/loaded Agent definitions are validated
before publication. Invalid reloads retain the last valid settings.
Model settings, web tools and Agent instructions change on the next turn,
including manual compaction, while an in-flight turn keeps its original settings.
Context and original reasoning survive these changes. `default_agent` affects
new sessions only; Skill instructions are read when loaded.

Every configured directory, API host/port/enablement and channel settings
(including Telegram token/allowlist) require restart. The Agent continues to
report its active resource settings. The configuration store exposes the latest
valid settings separately from active settings and lists changes requiring
restart. Both configuration files are watched at their parent directory, so
atomic-save replacement is observed. Embedded runtime shutdown closes its watcher and drains
queued configuration work. See [Configuration](docs/configuration.md) for fields,
validation, runtime updates and ownership.

Agent definitions default to `.agents/bots/<id>/AGENT.md` (configured by `agents_path`); frontmatter preserves
`name`, `description`, `llm`, and `allow_skills`. The Markdown body supplies the
system instructions. Agent `llm` fields override matching Workspace fields.

The supported provider is `deepseek`. Model settings use `provider`, `model`,
`api_key`, `api_base`, `temperature`, `max_tokens`, and the boolean `thinking`.
The model defaults to `deepseek-flash`, the endpoint to `https://api.deepseek.com`,
temperature to `0.7`, max tokens to `2048`, and thinking to `true`. The API key is
required. Set `llm.thinking: false` in Workspace or Agent settings to explicitly
disable thinking. DeepSeek ignores temperature while thinking is enabled.
Assistant messages retain full `reasoning_content` in session context; the bot sends the final text only.

Each model request attempt has a 60-second timeout. The SDK retries connection
and timeout failures and HTTP 408, 409, 429, and 5xx responses at most twice,
following server retry hints and its backoff policy. This applies to conversation
and compaction requests; total request time can exceed 60 seconds. Retries keep
the same context, reasoning, tools, and settings without rerunning completed
tools. Ctrl+C interrupts an active request or retry wait. Permanent errors and
invalid successful replies end the turn without a whole-turn retry.

Provider failures after retry exhaustion print an error and allow another
message. Inputs that fail before a model response do not enter session context.
Completed tool-call/result groups
are retained if a later model request fails or is cancelled; local changes
already made by tools remain in place. The shared Agent interface rejects
overlapping `chat()` calls in the same session; the event runtime queues turns sequentially.
Automatic context compaction and manual `/compact` are available.

Final answers are durably committed as one assistant log record with completion
metadata (turn ID, stable reply ID, payload and destination). Pending replies and
confirmed chunk counts are recovered from that log; files under
`event_path/pending/<sessionId>/<replyId>.json` are repairable projections.
Progress and acknowledgement records never enter model context or message counts.
Invalid completion metadata raises a session error; incomplete trailing records
and legacy assistant messages do not create pending replies. Optional runtime transports provide ordered, recoverable delivery with finite
retries; the bot entry point supplies a Telegram transport and the local
WebSocket interface explicitly sends and acknowledges WebSocket replies.

### Slash commands

The embedded command registry recognizes `/help` (alias `/?`), `/session`, `/skills`, and `/context` as
inspection commands; `/compact` requests manual compaction. Command names are case-insensitive. Successful inspection commands
neither call the model nor append conversation-history messages. Any other slash
input, including a lone `/`, is sent to the model as ordinary chat.

| Command | Behavior |
| --- | --- |
| `/help`, `/?` | List the available commands and descriptions. |
| `/session` | Show the current session ID, Agent name and ID, creation time, and in-memory active-message count without creating or switching sessions. |
| `/skills` | List each discovered Skill ID and description, or `No skills configured.` when none are valid. |
| `/skills <id>` | Show one Skill's name, description, and instruction body, or ``✗ Skill `<id>` not found.`` for an unknown ID. |
| `/context` | Show active-message count (excluding the system prompt), estimated tokens, model context window, output reserve, and effective compaction threshold. |
| `/compact` | Summarize older active context and retain recent complete turns. Report success, insufficient content or budget, failure, cancellation, or an unusable summary. |

Inspecting a Skill only reads it to render text. It does not register the `skill`
tool, load the instructions into active context, or change `allow_skills`, and it
works whether or not the Agent enables Skills.

### Context compaction

`/compact` replaces older active context with a user summary followed by the
original recent messages. It uses a separate model request without tools and
adds no artificial assistant acknowledgement. The summary request includes
visible text, tool names and arguments, and at most 2,000 characters per tool
result, with a truncation marker. It excludes original reasoning; retained
assistant messages keep their complete `reasoning_content`.

Budget reporting prefers valid provider input-plus-output usage and estimates
messages appended since that response. Without valid usage, it estimates UTF-8
JSON bytes divided by three plus framing overhead, including system instructions,
reasoning, tool arguments, and tool definitions. These are estimates, not exact
tokenizer counts. The output reserve is the larger of 16,384 and `max_tokens`;
the effective threshold is the context window minus that reserve, floored at zero.

The provider's published 1M context window is used for `deepseek-flash`,
`deepseek-v4-pro`, and the Flash aliases `deepseek-v4-flash` and
`deepseek-v4-flash-vision-exp` (verified October 12, 2026). Other model names use a
128,000-token fallback. Set the optional positive integer `llm.context_window`
in Workspace or Agent settings for another model or endpoint's actual limit.
This setting controls budgeting and is not sent to the API.

The retained tail targets at least 20,000 estimated tokens. Manual compaction
extends backward to a user-turn boundary, retaining whole turns even when one
turn exceeds the tail target. Automatic compaction first tries the same boundary;
when a long turn prevents progress or its retained tail exceeds the input budget,
it can cut before an assistant message while preserving every retained tool call
and all its results. The removed prefix is summarized with instructions to carry
forward the continuing user objective and completed work.
Too little older content causes no summary request. The separate summary request
must fit the model window with the output reserve. Blank, truncated, tool-calling,
or non-reducing summaries are rejected. Failure and cancellation keep active
context intact. Chat and compaction cannot mutate the same Agent concurrently.

A successful compaction clears usage from the old context; the next chat request
uses the rebuilt context. Original JSONL messages remain intact. The log appends
a compaction record with the exact summary and a stable retention boundary only
after summary and budget validation; active context changes only after persistence
succeeds. Commands and compaction records are excluded from message-only history.
Repeated manual and automatic compaction
update the previous summary with only newly removed content, without rereading
raw history.

Before each chat request, including every tool-round continuation, the Agent
checks the estimated input against the effective threshold. Requests at or below
the threshold proceed normally; requests above it require compaction. The rebuilt
request must fit the budget before the summary is committed. If summarization
fails, is cancelled, has no usable removable prefix, or leaves an oversized tail,
the chat stops with an error and preserves committed context and usage. Raw
history still records the attempted user input and any completed tool work.
The embedded runtime reports the error and accepts further input. Oversized
individual messages or tool exchanges may require smaller inputs or outputs.
There is no automatic retry after a provider context-overflow error.

### Local tools

The Agent can use these tools while answering a request:

| Tool | Arguments | Behavior |
| --- | --- | --- |
| `read` | `path` | Read the complete text file. |
| `write` | `path`, `content` | Create or overwrite a file; parent directories must exist. |
| `edit` | `path`, `old_text`, `new_text` | Replace every literal match; missing text reports an error without writing. |
| `bash` | `command` | Execute through the operating system's default shell and return stdout/stderr. |

Relative tool paths and shell commands use the process working directory, which
may differ from the selected Workspace. Multiple calls in one response execute
in order; each result retains the corresponding call ID. Tool errors return to
the model so it can continue. Complete reasoning from earlier assistant messages
is carried forward in tool requests. The bot sends the final model reply.

For example, give an embedded Agent a working directory and ask:
"Read notes.txt, replace every TODO with DONE, and show the updated content."
Embedded file writes and commands use the host process's permissions; isolated session tools use the container workspace.

Shell output separates stdout and stderr with an extra newline when both exist;
a nonzero exit returns its output, and no output returns
`Command completed with no output`. Commands have a 60-second timeout. Ctrl+C
cancels a running command and waits for termination; on POSIX systems the shell
and descendants in its process group receive SIGTERM, then SIGKILL after a
one-second grace period if needed. POSIX process cleanup is tested; Windows
process-tree termination has not been verified.

### Web search

Add the following to your Workspace's `config.user.yaml` to enable `web_search`:

```yaml
web_search:
  provider: brave
  api_key: YOUR_BRAVE_SEARCH_API_KEY
```

For SerpApi Google search, use:

```yaml
web_search:
  provider: serpapi
  api_key: YOUR_SERPAPI_API_KEY
```

`provider` must explicitly select `brave` or `serpapi`, and `api_key` must be a
nonempty string. Omit `web_search` or set it to `null` to leave the tool disabled.
Credentials come only from the Workspace configuration, with no environment-variable fallback. Keep keys in
your ignored local Workspace.

Search accepts exactly one of a nonempty `query` or one through five `queries`,
plus optional `numResults` (default 5, range 1–20), `recencyFilter` (`day`, `week`,
`month`, `year`), and a string-array `domainFilter`. Invalid arguments fail before
requests. Workspace configuration selects Brave or SerpApi Google search.

Brave uses `q`, `count`, and native `freshness` values (`pd`, `pw`, `pm`, `py`),
with `X-Subscription-Token` authentication. SerpApi uses `engine=google`, `q`,
`api_key`, and native `tbs` date filters (`qdr:d`, `qdr:w`, `qdr:m`, `qdr:y`).
SerpApi's Google endpoint no longer supports the `num` parameter; result bounds
are enforced locally. Default endpoints are
`https://api.search.brave.com/res/v1/web/search` and `https://serpapi.com/search`.
An optional `web_search.api_base` overrides the complete HTTP(S) endpoint.

Domains use `site:` query operators and are also enforced against source URLs,
including subdomains. A leading `-` excludes a domain; exclusions win over
inclusions. Filtering preserves source ranking. `numResults` is an upper bound;
there are no additional requests to fill a short result list.

Single queries and batches return the same JSON envelope in the tool message:

```json
{"queries":[{"query":"example","provider":"brave","results":[{"title":"Example","url":"https://example.com/","snippet":"Example text"}],"error":null}]}
```

The `queries` array retains input order and query text. Empty results succeed.
HTTP failures, malformed provider payloads, timeouts, oversized bodies, and
transport failures produce item errors with an empty results array; other items
still complete. At most three queries run concurrently. Each request has a
30-second deadline covering response-body consumption and a 5 MiB limit enforced
while reading the decoded response body. Cancellation aborts active requests,
prevents queued queries from starting, and follows the Agent cancellation path.
There are no retries, provider fallback, pagination, source-body fetching,
additional summaries, background jobs, or storage IDs.

Ordinary embedded Agent tests use local endpoints and fixture credentials. They
do not establish live provider acceptance. The delivered contract is recorded in
[ADR 0003](docs/adr/0003-web-search-and-content-fetching.md).

### Content fetching

Enable direct HTTP content fetching in `config.user.yaml`:

```yaml
fetch_content: {}
```

The mapping must be empty and has no provider selector. Omit the setting or use
`null` to disable the tool. Provide exactly one of a string `url` or one through
five `urls`, with optional nonnegative integer `offset` (default 0) and integer
`limit` (default 10,000, range 1–20,000). URLs must use HTTP(S).

Fetching follows redirects and supports HTML, Markdown, and plain text based on
the response Content-Type. HTML uses Readability to extract main content and
Turndown to convert it to Markdown; a cleaned body is the sole fallback when
main-content extraction yields no text. Empty HTML extraction is an error.
Scripts, styles, templates, noscript, hidden attributes, ARIA-hidden elements,
and inline hidden styles are removed. Relative links and image sources resolve
against the document base at the final URL. External resources and JavaScript
are not executed. JavaScript-only pages may yield shell text or an extraction
error. Markdown and plain-text responses retain their decoded text directly.
No browser installation is needed for this tool or its ordinary tests.

Single inputs and batches return the same JSON envelope in the tool message:

```json
{
  "urls": [{
    "url": "https://example.com/article",
    "finalUrl": "https://example.com/article",
    "title": "Article",
    "content": "Readable text",
    "error": null,
    "totalChars": 13,
    "nextOffset": null
  }]
}
```

Results preserve input order and the requested URL. A missing title is an empty
string. Each failed item has empty title/content, zero totalChars, null
nextOffset, and a nonempty error; finalUrl is null until a final response is
established. HTTP, unsupported-format, size, timeout, and extraction failures
leave successful batch items intact.

Pagination counts Unicode code points, preserving emoji and other non-BMP
characters. `nextOffset` points after the returned chunk when more text remains.
At or beyond the end, content is empty and nextOffset is null, retaining the
full totalChars. Every continuation fetches and extracts again, so changing
pages can produce inconsistent chunks. There is no cache, snapshot, or storage ID.
For example, `{"url":"https://example.com/article","limit":2000}` reads the
first chunk; if its `nextOffset` is 2000, continue with
`{"url":"https://example.com/article","offset":2000,"limit":2000}`.
Stop when `nextOffset` is null. The maximum content output per five-URL call is
100,000 Unicode characters, or 50,000 at the default limit, plus metadata; JSON
escaping can increase the serialized size.

At most three items execute concurrently. Each request has a 30-second deadline
including body consumption and a streamed 5 MiB decoded response-body limit.
Requests are not retried. Ctrl+C cancels active requests and prevents queued
items from starting; readers and request timers are released on completion.

### Skills

A Skill is a named set of instructions in a directory under `skills_path`
(`.agents/skills` by default) that contains a `SKILL.md` file.

Both Agent definitions and Skills live under the Workspace's `.agents/` directory.
Set `agents_path: bots` and `skills_path: skills` explicitly to use the old layout.

```text
.agents/
├── bots/
│   └── helper/
│       └── AGENT.md
└── skills/
    └── concise-summary/
        └── SKILL.md
```

`SKILL.md` starts with YAML frontmatter containing `name` and `description`,
followed by the instructions:

```markdown
---
name: Concise summary
description: Summarize long text as a short bullet list
---

When the user asks for a summary, read the requested text in full and return at
most five bullets, most important first.
```

Set `allow_skills: true` in the Agent frontmatter to let that Agent use Skills.
When it is enabled and at least one directory has a valid `SKILL.md`, the Agent
adds a `skill` tool. The tool description lists each Skill's frontmatter name and
description, and its `skill_name` argument accepts a Skill directory name (the
Skill ID). Loading a Skill returns its instruction body without the frontmatter
and supplies it to the model as the tool result, so the model can follow the
instructions for the current task.

Directories without `SKILL.md`, and files missing a string `name` or
`description`, are skipped without an error. Extra frontmatter fields are
ignored and the instruction body may be empty. When the Agent sets
`allow_skills: false`, the skills location is missing, or no valid Skill exists,
the Agent registers no `skill` tool. Requesting an ID that is not among the
discovered Skills returns
`Error: Skill '<id>' not found. It may have been removed or is unavailable.`
Skills load only when the model requests them. `/skills` and `/skills <id>`
inspect discovered Skills through the embedded command registry without loading them into context; see
[Slash commands](#slash-commands).

### Conversation history

New embedded Agent sessions are recorded under `history_path`
(the Workspace default is `.history`):

- `index.jsonl` holds one record per session with `id`, `agent_id`, `title`,
  `message_count`, `created_at`, and `updated_at`. The first user message supplies
  the title, truncated to 50 Unicode code points plus `...`. Sessions list most recently
  updated first.
- `sessions/<session_id>.jsonl` appends one record per message with `timestamp`,
  `role`, `content`, `tool_calls`, and `tool_call_id`, plus `reasoning_content` on
  assistant messages that have it. New logs start with session metadata, and new
  messages and compaction/state records receive stable `id` fields. Compaction
  records contain `type: "compaction"`, `summary`, and `firstKeptEntryId`.
  Message counts exclude metadata, compaction, and state records.

User input is saved before requesting a model response, including failed or
cancelled turns. Assistant responses are saved before tool execution, and tool
results are saved as they arrive. Active context retains completed tool groups;
failed inputs remain in saved history even when excluded from active context.
Conversation history preserves original reasoning content and never fabricates
reasoning a record lacks. Records without reasoning content remain readable.
There is no history-listing or resume command.

Programmatic callers can resume a session with
`Agent.open({ workspace, sessionId })`. Recovery loads that session's Agent and
reconstructs active context from the latest valid saved summary, retained original
messages, and later messages without requesting another summary. Failed attempted
inputs remain in recovered context.

Legacy logs are recognized through valid index metadata and message records;
their recovery IDs use physical line numbers, including malformed and blank lines,
without rewriting the file. New logs can be recognized by their own metadata and
restore a missing index entry. Recovery diagnostics are available through
`agent.recoveryDiagnostics`. Invalid JSON/messages are skipped, and invalid
compactions fall back to an earlier valid compaction or complete recognized
message history. Invalid optional token statistics do not discard a valid summary.
The compaction's own ID explicitly marks an empty retained prefix. Boundaries
must otherwise resolve uniquely to an earlier message without splitting a tool
exchange. Nonempty unrecognizable files fail and remain preserved. Unterminated
fragments remain intact; later appends start after a newline separator.

Recovery appends unknown-outcome tool results for unresolved calls and a
`turn_interrupted` state record before accepting another turn. Original call IDs,
reasoning, arguments, saved results, and message extensions are preserved. Repeated
recovery adds no duplicate repairs and never executes tools or restarts a saved
request. Each repair identifies its original assistant entry so active context
places it within that tool exchange, even if later turns were already saved.
Repair metadata is excluded from model messages. Writes to the same history
directory are serialized within the process.

### Event runtime

`EventRuntime.open({ workspace, agent, delivery? })` explicitly starts a runtime and its
configuration watcher. Importing runtime modules opens no resources. The bot
entry point embeds this runtime. The bot entry point runs the
configured Telegram channel and local WebSocket interface in one runtime.

The shared facade provides:

- `openSession({ agent?, sessionId? })`: create a fresh session, or recover an
  existing session without starting model work. Reopening a running session uses
  its existing Agent. Conflicting Agent selection fails.
- `submit(event)`: validate and queue an `InboundEvent`, returning that turn's
  `OutboundEvent` or a `CancelledTurn` result. Queues execute independently per
  session. Explicit events require an already opened session and must agree
  with its saved source and configured binding. External events into legacy
  sessions without source metadata require a matching configured binding.
- `submit({ source, content, agent_id? })`: route a Telegram or WebSocket input
  through a durable source-to-session binding. Sources use the serialized
  encodings below; channel adapters add the namespace to their input identity.
  First inputs create a session and save its binding in `config.runtime.yaml`
  before queueing a turn. Concurrent first inputs reuse one session. WebSocket
  inputs may select an Agent explicitly; otherwise new bindings use the default
  Agent. Existing bindings retain their Agent and reject conflicting selection.
  Invalid sources, missing Agents, unusable sessions and conflicting source
  ownership fail without replacing history.
- `subscribe(handler)`: observe inbound and outbound events, with an unsubscribe
  callback. Each handler receives its own event copy and the shutdown signal;
  its callbacks run sequentially per session. Slow callbacks do not block Agent
  execution, other observers, or other sessions. Failures are recorded in
  `subscriberFailures` and leave generated replies pending.
- `getPendingReplies(sessionId)` and `acknowledgeReply(sessionId, replyId)`:
  inspect committed deliveries and acknowledge a successful send. Recovered deliveries can
  be inspected without opening an Agent or starting a model request.
- `stop({ graceMs? })`: reject new sessions/input/subscriptions, allow a finite
  grace period (default 1,000 ms), abort remaining requests, retry waits and
  subscribers, and await all owned tasks before closing the watcher. Subscribers
  must respond to the supplied signal and await their own resource cleanup.
  Unsubscribing does not detach an already running task from runtime shutdown.
  Calling stop again with `graceMs: 0` escalates an ongoing graceful shutdown.

Events preserve `type` (`InboundEvent` or `OutboundEvent`), `session_id`, `source`,
`content` and numeric Unix-seconds `timestamp`. Inbound events include a
nonnegative integer `retry_count`; this field never triggers a whole-turn retry.
Inbound sources use `platform-cli:cli-user`, `platform-telegram:<userId>:<chatId>`
or `platform-ws:<userId>`. Outbound events use the session's
`agent:<agentId>` source and `error: null` on success or an error string on failure.
Generated answers add `reply_id`, linking the event to the durable completion
record and its pending destination. Command results and turn errors are ephemeral
outbound observations with no `reply_id`; they create no generated pending reply.
Waiting inputs are never persisted. A queued input keeps its resolved session
and reply destination when configuration bindings change. Default Agent changes
apply only to new bindings. Restarted runtimes reuse saved bindings and rebuild
context from the session log, including saved compaction summaries, without
replaying unfinished tools. New runtime sessions record their source in the log
metadata and index; histories without that field remain readable and acquire no
retroactive replies.

`delivery: { transports, ownedPlatforms?, random?, wait? }` enables generated-reply delivery.
Each transport supplies `platform` (`telegram` or `ws`), a positive integer
`limit` in Unicode code points, and `send(chunk, signal)`. Chunks carry `sessionId`,
`replyId`, `destination` and `content`; the adapter resolves recipient details.
Use Telegram's 4,096-code-point limit; each adapter's limit must remain stable
across recovery. The optional random source and cancellation-aware wait function
allow controlled clocks in offline tests. Sends must settle after their transport
work is cleaned up when the signal aborts.

Delivery recovers saved pending replies at startup and preserves completion order
per session. Paragraph splitting falls back to code-point splitting for oversized
paragraphs. Every confirmed chunk is persisted before sending the next; the final
acknowledgement follows all chunks. Five attempts use 5-second, 25-second,
2-minute and 10-minute waits with uniform integer jitter within plus or minus
20 percent. Missing adapters and exhaustion persist failure details and pause
only that session's delivery until restart. `deliveryFailures` reports failures;
Agent execution and other sessions continue. A platform acceptance before local
progress persistence can duplicate that chunk on retry or restart. Terminal
replies retain their original destination. Without `delivery` the facade
keeps replies pending for explicit senders. Setting `ownedPlatforms` limits the
worker to those platforms; other replies remain pending without recording a
missing-adapter failure. The bot worker owns only Telegram replies; the WebSocket
interface handles WebSocket replies.

### Local WebSocket interface

`api.enabled: true` serves the local WebSocket interface at `/ws` on
`api.host:api.port` (default `127.0.0.1:8000`). It starts independently of
Telegram and requires no external service; `api` settings require restart.
`npm run dev:bot -- --workspace ./workspace` starts the listener in that
process, and importing the module opens no listener.

A client sends a JSON text frame `{"source": "<client>", "content": "<text>",
"agent_id": "<id>"?}`. `source` is the client identifier and becomes
`platform-ws:<client>`; reconnecting with the same identifier continues its
source-to-session binding. `agent_id` selects the Agent for a new binding and is
rejected when it conflicts with an existing session. Malformed JSON, a missing or
empty `source` or `content`, an invalid `agent_id`, or a rejected input returns
`{"type":"error","message":"..."}` to the originating connection without closing
it. Unknown fields are ignored.

Every connected client receives `InboundEvent` and
`OutboundEvent` envelopes for all sessions, including their `type`, `session_id`,
`source`, `content`, `timestamp`, and inbound `retry_count` or outbound `error`.
Generated answers also carry `reply_id`. An outbound reply is broadcast only
after its completion record is committed. Connected clients are observers: a
slow, failed, or disconnected peer is dropped without blocking the event
dispatcher or another session's execution.

The interface is the explicit sender for WebSocket replies. It acknowledges a
pending `platform-ws:` reply only after at least one connected client accepted
the outbound envelope; a reply with no recipient, or one destined for another
platform, remains pending. Acknowledgement is per committed reply: an older
unconfirmed reply stays pending and does not gate a later broadcast
acknowledgement, because the interface delivers no historical replies and every
connected client already observes outbound events in per-session order. There is
no client acknowledgement or replay protocol, so a reconnect observes new events
rather than historical replies. Stopping closes the listener and clients,
cancels in-flight broadcasts, and leaves unconfirmed replies recorded as
pending in the session log.

### API and library documentation

- [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)
- [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/)
- [DeepSeek model limits](https://api-docs.deepseek.com/quick_start/pricing/)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Token-budgeted context compaction](docs/adr/0002-token-budgeted-context-compaction.md)
- [Brave Web Search API](https://api-dashboard.search.brave.com/app/documentation/web-search)
- [Readability main-content extraction](https://github.com/mozilla/readability)
- [jsdom HTML parsing](https://github.com/jsdom/jsdom)
- [Turndown HTML-to-Markdown conversion](https://github.com/mixmark-io/turndown)

Manual compaction retains whole user turns, while automatic compaction can
summarize a long turn's prefix. Token estimates use UTF-8 bytes with a framing
margin, and saved summaries can be restored from the append-only session log.
Manual and automatic compaction both support incremental summary updates.

## Telegram bot

The bot entry point embeds the event runtime and runs a
long-polling Telegram channel when it is enabled. Copy the example Workspace and
enable the channel in the merged configuration:

```yaml
channels:
  enabled: true
  telegram:
    enabled: true
    bot_token: "YOUR_TELEGRAM_BOT_TOKEN"
    allowed_user_ids: ["123456789"] # Empty allows every user.
```

```sh
npm run dev:bot -- --workspace ./workspace
# or, after npm run build:
npm run start:bot -- --workspace ./workspace
```

Without `--workspace` / `-w` the default Workspace is `../default_workspace`.
`--help` prints usage without loading configuration. Starting with both Telegram
and the WebSocket interface disabled prints a message and exits with status 0,
so the entry point can be checked without credentials or network access.
Enabling `api.enabled` starts WebSocket independently of Telegram. Channel enablement, `bot_token`
and `allowed_user_ids` are restart-only settings; edit them and restart the
process.

The Telegram Bot API is called directly over HTTPS; its request and response
shapes stay in `src/bot/telegram-api.ts`, so no Telegram SDK dependency is added.
User and chat identifiers are carried as digit strings and sent back as strings,
so routing, allowlist checks and delivery never depend on JavaScript numeric
precision. A numeric identifier that cannot be represented exactly at the JSON
boundary is rejected instead of silently rounded.

Each user/chat pair maps to its own Agent session, so a user's group and private
conversations stay separate, and a new source binding is saved in
`config.runtime.yaml` before the first turn. Text messages become normal runtime
inputs: follow-ups queue in reception order, tools and Skills work, and generated
replies travel through the durable chunked delivery path (4,096 code-point
chunks) with finite retries. A failed send keeps its pending reply and resumes on
a later restart. Command results and turn errors are ephemeral observations, like
the embedded command registry, and are sent without a durable record. Messages from users outside a
nonempty allowlist are ignored; an empty allowlist allows everyone, matching the
configured behavior. Ctrl+C stops polling and awaits runtime cleanup.

Ordinary tests drive controlled Telegram updates and sends against the real
runtime; they never contact Telegram. Real send/receive acceptance is separate
and uses a user-controlled test destination.

## Checks and tests

```sh
npm run check
npm test
npm run test:watch
npm run verify
```

`check` checks formatting, lint, and types without modifying files. Type checking
includes application source, tests, and the Vitest configuration. Run
`npm run format` to apply formatting fixes.

Ordinary tests use Vitest in Node.js and do not require credentials or a browser.
Tests serve pages and controlled provider responses locally; they do not use
real model or search credentials. Run a
specific file with `npm test -- tests/startup.test.ts`. Live-service tests are
excluded from ordinary tests, watching and `verify`. With DeepSeek and explicit
Brave or SerpApi settings configured in a local Workspace, run:

```sh
MYBOTS_ACCEPTANCE_WORKSPACE=/absolute/path/to/workspace npm run test:live
```

This full live command also includes interactive Telegram acceptance. It requires
a configured test bot and explicit test user/chat IDs; missing settings fail the
case. See [runtime acceptance](docs/runtime-acceptance.md) for focused DeepSeek,
WebSocket and Telegram commands, restart checkpoints, and separate offline/live
evidence. Actual Telegram acceptance is still outstanding until the complete
input/restart flow passes; configured single-turn send/receive has been verified.

The source defaults to `./workspace`. Acceptance uses temporary Workspaces and
real services, consumes model/search quota, and fails when required configuration
or a service check is missing. It covers thinking/tool continuation, Skills and
local tools, saved history, search, HTTP continuation and real compaction. See
[Phase 1 acceptance](docs/phase1-acceptance.md) for scenarios, compatibility
exceptions and separate validation evidence.

`verify` runs checks, ordinary tests, compilation, and offline startup checks
of the compiled host, CLI, bot and runner entry points. It does not start a long-running service or
contact a model or messaging platform.

GitHub Actions runs `npm run verify` and `bash tests/workflow.sh` for pull
requests targeting `main`, pushes to `main`, and manual runs. CI reads the Node.js
version from `.nvmrc` and installs dependencies with `npm ci --ignore-scripts`.
Git workflow tests install Husky in isolated temporary repositories.

## Build and run

```sh
npm run build
npm run start:host -- --root ./workspace
# In another terminal:
npm run start:cli -- --root ./workspace
npm run start:bot -- --workspace ./workspace
```

Builds contain application code under `dist/`; tests and tool configuration
are not emitted. Start commands use the existing build. The bot server serves
`/ws` when `api.enabled` is true. For offline help:

```sh
npm run start:host -- --help
npm run start:cli -- --help
npm run start:bot -- --help
```

## Source layout

Source modules separate host lifecycle, central entities, mailbox protocol,
container drivers and channel clients from the remaining embedded bot runtime:

```text
src/
├── index.ts               # Persistent host entry point
├── host.ts                # Routing, mailbox observation, session lifecycle and delivery
├── db/                    # Central SQLite entities and schema migrations
├── channels/cli.ts        # Owner-local Unix socket listener
├── mailbox/               # Directional SQLite mailbox package
├── drivers/               # Session-driver contract and Docker execution
├── gateway-providers/     # OneCLI credential gateway boundary
├── container-runner.ts    # Session material and immutable context
├── cli.ts                 # CLI entry point
├── server.ts              # Bot entry point
├── cli/chat.ts            # Arguments and terminal interaction
├── core/
│   ├── agent.ts           # Session and tool-loop orchestration
│   ├── commands.ts        # Slash-command registry and handlers
│   ├── compaction.ts      # Token estimates, retention boundary, and summary input
│   ├── history.ts         # JSONL conversation history and session index
│   ├── events.ts          # Validated inbound/outbound event contracts
│   ├── messages.ts        # Shared messages and tool protocol types
│   ├── runtime.ts         # Per-session work queues, observation, and shutdown
│   └── skills.ts          # Skill discovery and loading
├── config/
│   ├── workspace.ts        # Workspace and Agent validation
│   └── reload.ts           # Configuration snapshots, observation, and runtime writes
├── providers/deepseek.ts  # DeepSeek request/response conversion
├── tools/
│   ├── builtin.ts         # Local tool definitions and execution
│   ├── shell.ts           # Shell execution and cleanup
│   ├── skill.ts           # Dynamic skill tool
│   ├── web-access/
│   │   ├── web-search.ts  # Search arguments and tool entry point
│   │   ├── fetch-content.ts # Bounded HTTP fetching, extraction, and pagination
│   │   ├── brave.ts       # Internal Brave adapter
│   │   ├── serpapi.ts     # Internal SerpApi Google adapter
│   │   └── search-request.ts # Bounded search HTTP requests
│   └── toolbox.ts         # Tool schemas, argument validation, and dispatch
├── websocket/
│   ├── interface.ts       # Local listener, client registry, broadcast, and shutdown
│   └── protocol.ts        # Input-frame validation and event/error serialization
└── bot/
    ├── startup.ts         # Bot arguments, shared runtime ownership, and shutdown
    ├── telegram.ts        # Telegram channel lifecycle and reply transport
    └── telegram-api.ts    # Telegram Bot API request/response boundary
```

The Agent supplies the available tool schemas to the provider. The provider
handles model requests without selecting which application tools are enabled.

## Project rules

- [Development](docs/agents/development.md)
- [Testing](docs/agents/testing.md)
- [Git workflow](docs/agents/git-workflow.md)
- [Agent instructions](AGENTS.md)
