# Persistent local chat

The default application runs the API and Durable worker as separate local
processes. It supports Bot creation and saved name, instructions and model,
one persistent Thread per Bot, streamed answers, native steering and Stop,
shell/file tools on a persistent Docker Team Computer, shared Skills, scoped
Markdown memory and original-history retrieval.

Use Node.js 24.21.0 and install with `npm ci`, then `npm run prepare` and
`npm run build`. The Web stylesheet, safe Markdown renderer and reading-position
behavior live in `apps/web`.

## Provider settings and startup

The default data directory is `data/` in the repository root. `--root` selects
another data directory with the same layout; it does not add a nested `data/`:

```text
data/
├── providers/credentials.json # Owner-only provider keys
├── client-credential        # Local browser connection credential
├── product.sqlite           # Bots, Threads, Skills and scoped memory
├── durable.sqlite           # SDK conversation and execution storage
├── worker-owner.sqlite      # Worker ownership lock
├── command-owners.sqlite    # Computer Bot/turn cleanup ownership
└── computer/
    ├── workspace/          # Persistent working files mounted into Docker
    └── worker-generations/ # Read-only launch closure metadata in Docker
```

SQLite may create adjacent journal files. Keep the whole data directory when
backing up a stopped installation. The Computer workspace is created on first
tool use. Application logs go to the terminal; startup does not create `logs/`.

Start without a model file or provider key, connect to Web, then open **Provider
settings**. Save one DeepSeek key and/or one OpenCode Go key. Saving is local:
it does not contact the provider or prove access. The first explicit message
checks authentication, quota, subscription and model availability. Errors are
sanitized before conversation persistence. See [supported models](providers.md)
for protocols and the supported text/tool catalog.

Keys live in `providers/credentials.json` under the selected root. The directory
is owner-only (`0700`) and the atomically replaced file is owner-readable/writable
(`0600`). Include it in private backups; never commit or copy it into the Computer.
Web receives configured status, never saved keys, and clears key input fields.
An empty field preserves the existing key; use **Remove** to delete it explicitly.

Replacement/removal affects the next model request, including a later tool
follow-up in an ongoing turn. Already-issued requests finish with their original
key. No restart or input replay is needed. Removing a key blocks later calls
without changing the Bot's model or history. Existing `models.json` files remain
untouched but are no longer read. Existing unavailable model choices remain
editable; select a supported model and save its provider key before sending.
Each Bot keeps an independent choice; new Bots default to DeepSeek. Select Go
explicitly for coding-agent work. No provider fallback or arbitrary endpoint
configuration is available.

For Computer tools, start Docker Desktop and build the tool image once (and
again after updating its Dockerfile or helper):

```sh
npm run build:computer
```

Plain chat and application startup do not require Docker. The first shell or
file operation prepares the Computer; missing Docker or image failures appear
as tool errors. Model endpoints and credentials are never passed to the container.

Start both processes and serve the built Web with one command:

```sh
npm start
```

Open `http://127.0.0.1:4173`. Connect using the credential in
`data/client-credential`. The HttpOnly connection cookie
survives reload; Host, Origin and cross-site checks apply to local requests.
Create a Bot, select a configured model and send a message. Enter sends;
Shift+Enter adds a line. A message sent while busy uses native steering.
Stop aborts current work and withdraws queued inputs; withdrawn inputs remain
visible with a Resend control that restores their text to the composer. Failed
admitted inputs also remain unprocessed with the SDK reason and error detail.
Resend prepares the text; sending it again deliberately creates new work.

Use a different fresh root or port with:

```sh
npm start -- --root /absolute/path/to/new-installation --port 4174
```

The selected root keeps its own provider settings. Preserve existing current
Bot, Thread, history and workspace data when upgrading. Do not point the entry
at incompatible legacy runtime data. The source entry is `npm run dev` with the same
arguments and requires built Web assets. Ctrl+C shuts down both processes;
normal shutdown retains all data. On restart, the worker resumes supported work
from SDK storage, including pending input and committed exchanges. Interrupted
unsafe tools are reported as potentially partially run rather than replayed by
the application.

Unexpected worker exit triggers up to three serialized restart attempts per
application lifetime, delayed by 250 ms, 1 second and 4 seconds. Each startup
attempt has a 10-second deadline. The budget does not reset after a successful
restart; restart the application after resolving an exhausted failure. Web
distinguishes worker recovery from a lost browser connection, reports recovery
completion and shows an actionable failure when attempts are exhausted.

Before enabling SDK execution, the worker reconciles persisted Computer Bot/turn
ownership against native submission status. It terminates interrupted-turn work,
including that turn's services, and preserves completed-turn services. Old worker
launch generations are closed before scanning: a provider lock joins launches
already entering the Computer and rejects Docker execs that arrive later. The
replacement worker uses a fresh generation, including for native continuation of
the same Agent turn. If cleanup cannot be confirmed, execution stays paused and Web reports the failure. Restore
Docker access or inspect the affected Computer, then restart the application;
do not delete ownership records to bypass cleanup. No input is automatically
resubmitted by the API, and an interrupted unsafe tool may have partially run.
Cleanup cannot undo file effects or provide exactly-once effects.

Plain chat does not require Docker when no command cleanup is pending. On the
first upgrade from an installation without command ownership records, an existing
Computer workspace requires Docker access once to discover provider ownership;
this preserves existing services and interrupted work without resetting data.
A stopped or removed Computer has no surviving processes and is not restarted
just for cleanup. A second worker cannot open the same root.

Shutdown cancels restart backoff and startup, closes subscriptions and suppresses
respawn. A worker that has not exited within five seconds is killed; unconfirmed
cleanup remains recorded for the next startup. Completed-turn retained services
are not additional shutdown cleanup targets.
If startup fails, check data-root ownership and provider credential storage
before retrying. Missing keys do not prevent startup.

## Team Computer

The worker registers `shell`, `list_files`, `read_file` and `write_file`, plus
`start_service`, `command_status`, `list_services` and `stop_service` for managed
processes. All use the same ComputerRef and Docker SandboxProvider. Product SQLite
retains one Computer identity for the default Space. Working files use
`<root>/computer/workspace`, exposed read/write as `/workspace`. A second,
read-only bind mount exposes only `<root>/computer/worker-generations` at
`/var/lib/mybots/worker-generations`. These small markers fence late command
launches across worker/container lifetimes; they are outside workspace export
and cannot be edited by Computer tools. Host credentials, model configuration
and databases are outside both mounts.

Relative tool paths and default command directories use `bots/<botId>/`.
`shared/...`, `bots/...` and `/...` explicitly select paths from the workspace
root; `/` selects the root itself. For example, `write_file` at
`shared/input.txt` and `shell` with `cwd: "/shared"` use the same file.
Paths passed as shell command arguments follow ordinary shell semantics; use
`/workspace/shared/input.txt` to reference that file from a Bot's default cwd.
Tool paths reject traversal and links outside the workspace. Bot directories
organize files and do not isolate Bots. Concurrent edits to shared files require
owner coordination.

Concurrent first use shares preparation; independent commands have no global
Computer lock. `shell` runs bash with a five-minute deadline. The host environment
variable `SANDBOX_COMMAND_TIMEOUT_MS` accepts a positive integer in milliseconds
up to 3,600,000 (sixty minutes); missing or invalid values use 300,000. There is
no per-tool deadline option or tuning UI. A container supervisor enforces the
deadline independently of worker lifetime; expiry kills the process group and
returns `timedOut: true` with exit code 124.

Output is polled every 200 ms and published through native SDK tool progress.
After output goes quiet for one second, or after ten seconds of observation,
the tool can return `running: true`, a null exit code and a `commandId` while the
bounded command continues. This does not detach it or remove its deadline.
`command_status` observes that ID again. At the final-answer boundary, native
SDK continuation first commits progress if work still runs, then supplies bounded
final command output before the final reply. Completion observation checks the
native inbox between bounded waits, so queued owner input retains precedence. Completed commands are not
reexecuted to obtain their results. Commands retain the first 64 KiB of each
stream; SDK results/continuations additionally use 50 KiB / 2,000-line bounds.
Truncation is explicit. Use shell slices to retrieve required original bytes,
or explicitly redirect output to a workspace log; there is no automatic full-log
store. Command identity and exit metadata precede output in tool results.

`list_files` includes hidden names and directories, limited to 1,000 entries
with a truncation flag; use shell for larger or filtered listings. Read/write
tools handle UTF-8 files up to 1 MiB, and writes replace contents. Interrupted
shell/write operations are unsafe to replay; the SDK records interruption.
Read/list operations are replay-safe.

The image includes Python 3, bash, curl, git, gh, jq, an SSH client, unzip,
procps, PDF text/info utilities, pandoc, openpyxl and uv/uvx. It includes no desktop
or Node/npm toolchain. Each shell sets HOME to its resolved cwd, adds
`$HOME/.local/bin` to PATH and uses `$HOME/.cache` (including `uv`) for caches.
These directories persist when cwd is in the workspace; the root filesystem is
read-only and `/tmp` is temporary. Verify additional tools before using them.

`start_service` explicitly launches intentional work without the ordinary shell
deadline. Run the service in the foreground. The tool returns its `commandId`;
`command_status` and `list_services` report current state, and an explicit later
chat request can invoke `stop_service` for this Bot's earlier service. Services
are retained only after the SDK settles the originating input successfully.
They can use CPU, memory and ports after the application exits. This does not
manage arbitrary daemons that escape the command's process group and provides
no management screen or automatic restart.

For a browser preview, bind the HTTP service to `0.0.0.0` inside the Computer,
then call `preview_service` with its `commandId` and container `port`. It returns
`http://<commandId>.localhost:<port>/` only after a successful HTTP response at
the host's loopback port. The root path must return a 2xx response. Check an old
URL again with the tool before claiming it still works. A stopped service,
unreachable port, port conflict or failed check is a tool failure, not a live URL.

Each requested port uses a separate Docker relay with an automatically assigned
host port bound only to `127.0.0.1`. The preview hostname is distinct from the
product's `localhost`/`127.0.0.1` origins and host-only connection cookies. The
relay rejects alternate Host names before forwarding headers; product Host,
Origin and credential checks still apply. Relays have no host/workspace mounts
or product credentials. Open the returned `.localhost` address in the host
browser; replacing it with `localhost` or `127.0.0.1` is rejected.

The relay runs independently of API and worker, so a retained service's URL
survives normal application exit. It releases its port when the target stops
accepting connections. Stop and explicit `stop_service` end availability with
the service; there is no service restart or background availability UI. Preview
URLs use HTTP and require a browser that resolves `.localhost` to loopback (verified with Chromium).

Rebuild the Computer image to install the relay script. Existing compatible
Computers need no replacement or added port mappings: relays use the new image
and reach the existing Computer through its Docker bridge. Its live services,
identity and workspace remain intact. Computer replacement still ends services
and requires deliberately starting new ones and requesting new preview URLs.

Stop uses native abort and queued-input withdrawal, then joins cleanup of all
commands and services owned by the current Agent turn. It preserves other Bots,
services retained by earlier completed turns, the Computer and completed file
effects. Inspecting an earlier service does not transfer its ownership to the
current turn. A failed turn does not retain its newly started services. Cleanup
failures remain visible and cause application shutdown to fail after releasing
SDK/database ownership; they are not silently treated as successful cleanup.

Provider metadata under `/tmp/mybots-commands` associates command IDs and process
groups with Bot IDs and the turn's first SDK submission ID, which remains stable
across generation handovers. Supervisor and process start tokens guard signals
against PID reuse. Metadata survives worker death while the Computer runs;
`DockerSandbox.listCommands()` exposes ownership and retained state, and
`finishTurn(computer, owner, completed)` retains successful services or joins
scoped cancellation. The worker marks retention only after committed SDK
settlement. Recovery can reconcile a crash between settlement and that mark
against the native submission; a transcript interruption alone proves nothing
about process death. The worker reconciles this ownership before enabling SDK
execution after restart.

Normal shutdown closes the worker without removing the container or workspace.
The container may stay running. Later tool use starts a stopped container or
recreates a removed container with the same persistent workspace and read-only
launch metadata mounts. Existing containers from before launch fencing need
explicit replacement with the current image and both mounts; the application
refuses incompatible mounts rather than attaching unsafely. Preserve the
workspace and generation metadata directories when replacing a container. Its
processes end, so retained services must be started again deliberately.
Rebuilding the
image requires removing the installation's container before the next tool use;
identify its name through `ProductDatabase.computer().id`, and preserve the
workspace directory. Tool binaries and `/tmp` are disposable; working files
belong under `/workspace`.

`@mybots/sandbox` exposes `DockerSandbox.exportWorkspace(computer)` and
`importWorkspace(computer, archive)` for explicit installation transfer.
These exchange an uncompressed tar archive, limited to 16 MiB and 2,048 entries,
containing regular files/directories. Links and special files are rejected;
binary bytes, empty directories and regular-file permission bits are preserved.
Import validates the manifest before writing, merges into the target workspace,
and overwrites named files without deleting other files. Pause working Bots
before transfer; it is not a concurrent snapshot or an atomic restore. No
workspace copying occurs during normal turns and no management UI is included.

## Shared Skills and memory

Use **Shared Skills** to create, inspect, edit or remove a user Skill shared by
all Bots. Each Skill has a stable lowercase name, a description (up to 1,000
characters) and Markdown instructions (up to 16,000 characters). Names start with
a letter and contain letters, numbers or hyphens, up to 80 characters. Built-in
Skills are readable but cannot be edited, removed or shadowed by user Skills.
The built-in `resource-maintenance` Skill describes deliberate resource upkeep.

Use **Memory** to inspect, edit or remove either the shared owner document or
the selected Bot's private document. Each scope has one Markdown document, up to
16,000 characters. Writes replace the current document; removal clears its
current content. Bots receive only their own document and the owner document.
Memory is deliberately retained knowledge, separate from conversation history.
Removing it does not erase earlier transcript entries or guarantee forgetting.

Skills and memory live in product SQLite and survive reload and worker restart;
they do not require Docker or create files on the Computer. Each model request
loads a Skill catalog and the two memory scopes through the existing context
adapter. Catalog entries include names and descriptions, without full Skill
instructions. Changes appear on subsequent context loads, including the next
model boundary after a tool round; an already-issued request keeps its input.

The worker registers `skill_read`, `skill_write` and `skill_delete` for on-demand
reading and deliberate user Skill maintenance. `memory_read`, `memory_write`
and `memory_delete` accept `owner` or `bot` scope; Bot identity comes from the
current Conversation, never a model-selected Bot ID. Resource write/remove tools
use unsafe replay semantics so interrupted mutations are not automatically
repeated. There is no per-Bot Skill activation, resource version engine or
background memory extraction.

## Persistence and context

Product SQLite stores the default Space, Bots and each Bot's stable
Thread/Conversation association. Only the worker opens the separate Durable
SQLite store. There is no application transcript or execution queue. A send
returns its SDK submission identity only after native admission and a
non-model-visible SDK receipt; retries reuse the same request ID. That receipt
lets withdrawn text remain visible after the SDK removes it from its inbox.

Reload and reconnect read committed SDK originals and live state. The initial
chat view contains the latest 200 SDK entries. Use **History** to search or browse
the explicitly selected Bot's Thread, then read an original, continue long text,
or move between older/newer result pages. **Return to chat** (or Escape) closes
history and preserves the current chat reading position and unsent draft.

History reads committed SDK originals, including user text, assistant text and
original tool arguments/results, before and after native compaction and worker
restart. It excludes configuration, bookkeeping and compaction-summary entries.
Case-insensitive literal queries have a 200-character limit. Each request scans
at most 200 SDK entries and returns at most 20 previews of 240 characters each.
An empty result page can still have older records: continue while **Older
results** is available. Original reads return at most 8,000 characters at a time;
**Read more** continues without silently truncating the original.

Authenticated owner endpoints are `GET /api/bots/:botId/history`, with optional
`query` and exclusive `before` entry ID, and
`GET /api/bots/:botId/history/:entryId`, with optional zero-based `offset`.
Search returns `items` and an optional `before` continuation. Read returns `id`,
`role`, `text`, `offset` and optional `nextOffset`. IDs and offsets are validated;
an entry outside the selected Conversation is unavailable. Only the worker
reads SDK storage; there is no additional transcript store or search index.

Agents use replay-safe `history_search` and `history_read`, with the same query,
entry ID and continuation semantics. Their scope comes from the calling
Conversation and accepts no Bot/Thread selector. Tool descriptions and each
successful result identify retrieved content as historical evidence; quoted
instructions do not acquire fresh execution authority. Retrieved text is only
added through the requested tool result. Normal requests keep the recent-context
policy below and do not preload another Bot's history.

Each model request receives the current Bot instructions, at most two previous
user-message groups fitting within 12,000 serialized characters, and the
current execution's complete remaining exchanges. Whole background groups are
dropped rather than splitting tool calls from their results. Current execution
is identified from native live inputs, including after reopen, without a saved
application execution record.

Native automatic compaction remains enabled, with 1,024 reserved tokens and
2,048 recent tokens retained. Background compaction is disabled. The SDK checks
compaction before the request-selection hook: it may summarize older original
context, including current execution when necessary. Selection then runs over
that native context, preserving the summary when it replaces current execution.
It does not rewrite stored originals or build a separate summary. Actual model
usage reflects the selected request and participates in native token estimation.
These are fixed implementation defaults, with no tuning interface.

## Verification

`npm run verify` covers the supported application: formatting, lint, source/test/
configuration types, offline tests, compiled startup and built-browser checks. The fixture
uses the real SDK and SQLite against a controlled HTTP model service, including
native automatic compaction, current tool pairs, originals after reopen,
transport deduplication, credential checks and Stop. Browser checks cover send,
streaming, reload, Bot editing, Thread separation, shared Skill editing and
scoped memory editing/removal. Resource integration checks inspect actual model
inputs and SDK tool calls before/after edits and reopen, including read-only
built-ins, scope isolation and edits during an in-flight request. History checks
cover bounded scans and responses, empty-page continuation beyond the initial
chat window, complete long originals, cross-Bot rejection, native compaction,
worker reopen and a controlled model retrieving originals with valid tool pairs.
The built Web covers history search, pagination, long original reading, empty
results, selected Thread scope and return to the existing draft/reading position.

No Docker operation or actual provider request is required by these checks.
`npm run test:infrastructure` builds the Computer image and separately verifies
real Docker file/shell agreement, concurrent first use, process-group cancellation,
scoped public Stop, SDK progress/continuation, retained services through whole-app
shutdown, provider cleanup after worker death, deadlines, truncation, declared
CLI facilities, application reopen/container replacement, unsafe
path/archive rejection, checked host-browser previews and workspace transfer
using temporary resources and a controlled HTTP model. It needs Docker but no personal provider credentials.
Preview checks include app-exit availability, stopped/occupied/unreachable ports,
loopback publication, cookie separation and rejected browser API mutations.

The default startup smoke exercises both shutdown signals, child-process cleanup,
authenticated resource persistence, retained working files and retired-route rejection.
Integrated Docker checks combine resource context, native compaction, original
retrieval and tools across restart and multiple Bots. Controlled-model success
does not establish actual-provider acceptance.

## Retiring an older installation

The former Host, mailbox, containerized agent runner, terminal chat, gateway
setup and background-service installers have been removed. Their launch commands
and APIs are unsupported. No migration or continuation of their work is provided.
The default `data/` name was also used by the former Host. Before initializing
this application, stop that service and move aside or deliberately remove its
old data. Startup does not detect, migrate or automatically delete old records.

Before starting this version, stop the old installation's service. On macOS,
inspect `~/Library/LaunchAgents/com.mybots.*.plist` and identify the one whose
`WorkingDirectory` and `ProgramArguments` point to this checkout's former Host.
Run `launchctl bootout gui/$(id -u) /absolute/path/to/that.plist`, then move that
exact plist outside `LaunchAgents` so login cannot relaunch it. Keep a private
backup if needed. For an older systemd installation, inspect the specific
`mybots-<installation-id>.service` and disable/stop that unit at its installed
user or system scope. For a manually launched Host, verify its executable and
installation path before stopping its PID. Do not kill unrelated Node processes.

Inspect Docker container names and mounts before stopping any old runner. Keep
shared gateways and unrelated containers. This application does not use the old
gateway, Telegram configuration or environment-file setup. Configure model
credentials through Web Provider settings.

Old `groups/`, `host.json`, logs and credentials can remain inactive. If
discarding old installation files, identify them and back up anything needed
first. Once initialized, `data/` contains the current application and must be
preserved. Preserve `.scratch/`, `.agents/`, local instructions, unrelated owner
files and the current `<root>/computer/workspace`.
Builds clean only current package output. Keep the terminal running for the
supported foreground startup; no replacement background service is installed.
