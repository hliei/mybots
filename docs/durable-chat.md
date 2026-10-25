# Persistent local chat

The default application runs the API and Durable worker as separate local
processes. It supports Bot creation and saved name, instructions and model,
one persistent Thread per Bot, streamed answers, native steering and Stop,
shell/file tools on a persistent Docker Team Computer, shared Skills, scoped
Markdown memory and original-history retrieval.

Use Node.js 24.21.0 and install with `npm ci`, then `npm run prepare` and
`npm run build`. The Web stylesheet, safe Markdown renderer and reading-position
behavior live in `apps/web`.

## Host configuration and startup

The default data directory is `data/` in the repository root. `--root` selects
another data directory with the same layout; it does not add a nested `data/`:

```text
data/
├── models.json              # Host model configuration
├── client-credential        # Local browser connection credential
├── product.sqlite           # Bots, Threads, Skills and scoped memory
├── durable.sqlite           # SDK conversation and execution storage
├── worker-owner.sqlite      # Worker ownership lock
└── computer/workspace/      # Persistent working files mounted into Docker
```

SQLite may create adjacent journal files. Keep the whole data directory when
backing up a stopped installation. The Computer workspace is created on first
tool use. Application logs go to the terminal; startup does not create `logs/`.

Create the `data/` directory and `data/models.json` with a JSON array of host-configured
OpenAI Chat Completions compatible models. For example, replace the endpoint,
model and credential placeholders with your installation values:

```json
[
  {
    "id": "personal",
    "name": "Personal model",
    "modelId": "your-model-id",
    "baseUrl": "https://your-provider.example/v1",
    "apiKey": "your-provider-credential",
    "contextWindow": 32768,
    "maxTokens": 4096
  }
]
```

Keep this file readable only by the owner (`chmod 600`); the default installation
root is ignored by Git. Use an empty array to check startup without a configured
provider. The model endpoint and credentials stay in the worker; the browser
receives only model choice IDs and display names. Each choice ID must be unique.
Restart the application after changing host model configuration. A Bot whose
saved choice was removed remains editable with its original Thread; choose an
available model in Bot settings before sending new input.

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

The selected root must contain its own `models.json`. Do not point the new entry
at legacy runtime data. The source entry is `npm run dev` with the same
arguments and requires built Web assets. Ctrl+C shuts down both processes;
normal shutdown retains all data. On restart, the worker resumes supported work
from SDK storage, including pending input and committed exchanges. Interrupted
unsafe tools are reported as potentially partially run rather than replayed by
the application. An abrupt worker kill can leave a Docker command running;
recovery does not prove termination or roll back file effects. Use Stop while
the worker is available to cancel its active commands. A second worker cannot
open the same root.
If startup fails, check the model file, its required fields and data-root
ownership before retrying.

## Team Computer

The worker registers only `shell`, `read_file` and `write_file` as working-file
tools. All use the same ComputerRef and Docker SandboxProvider. Product SQLite
retains one Computer identity for the default Space. Its sole host mount is
`<root>/computer/workspace`, exposed as `/workspace` in the container. Host model
configuration and databases are outside that mount.

Relative tool paths and default command directories use `bots/<botId>/`.
`shared/...`, `bots/...` and `/...` explicitly select paths from the workspace
root; `/` selects the root itself. For example, `write_file` at
`shared/input.txt` and `shell` with `cwd: "/shared"` use the same file.
Paths passed as shell command arguments follow ordinary shell semantics; use
`/workspace/shared/input.txt` to reference that file from a Bot's default cwd.
Tool paths reject traversal and links outside the workspace. Bot directories
organize files and do not isolate Bots. Concurrent edits to shared files require
owner coordination.

Concurrent first use shares preparation, while independent commands run without
a global Computer lock. Stop kills the active command's process group inside
the container and joins its wrapper; it preserves the Computer and completed
file effects. Commands have a 120-second limit and retain up to 64 KiB each of
stdout/stderr, with an explicit truncation flag. File tools handle UTF-8 files
up to 1 MiB. Interrupted shell/write operations are not replayed automatically;
the SDK records the interrupted outcome. Read operations are replay-safe.

Normal shutdown closes the worker without removing the container or workspace.
The container may stay running. Later tool use starts a stopped container or
recreates a removed container with the same persistent mount. Rebuilding the
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
public Stop, SDK chat tools, application reopen/container replacement, unsafe
path/archive rejection and workspace transfer using temporary resources and a
controlled HTTP model. It needs Docker but no personal provider credentials.

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
credentials directly in the selected root's owner-readable `models.json`.

Old `groups/`, `host.json`, logs and credentials can remain inactive. If
discarding old installation files, identify them and back up anything needed
first. Once initialized, `data/` contains the current application and must be
preserved. Preserve `.scratch/`, `.agents/`, local instructions, unrelated owner
files and the current `<root>/computer/workspace`.
Builds clean only current package output. Keep the terminal running for the
supported foreground startup; no replacement background service is installed.
