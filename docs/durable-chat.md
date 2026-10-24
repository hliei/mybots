# Persistent local chat

The isolated chat entry runs the API and Durable worker as separate local
processes. It supports Bot creation and saved name, instructions and model,
one persistent Thread per Bot, streamed answers, native steering and Stop,
shell/file tools on a persistent Docker Team Computer, shared Skills and scoped
Markdown memory.
The existing default entry remains available until the full runtime cutover.

Use Node.js 24.21.0 and install with `npm ci`, then `npm run prepare` and
`npm run build`. The new Web build reuses the delivered client stylesheet;
its Markdown renderer and reading-position behavior live in `apps/web`.

## Host configuration and startup

Create `workspace/durable-chat/models.json` with a JSON array of host-configured
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
npm run start:durable
```

Open `http://127.0.0.1:4173`. Connect using the credential in
`workspace/durable-chat/data/client-credential`. The HttpOnly connection cookie
survives reload; Host, Origin and cross-site checks apply to local requests.
Create a Bot, select a configured model and send a message. Enter sends;
Shift+Enter adds a line. A message sent while busy uses native steering.
Stop aborts current work and withdraws queued inputs; withdrawn inputs remain
visible with a Resend control that restores their text to the composer.

Use a different fresh root or port with:

```sh
npm run start:durable -- --root /absolute/path/to/new-installation --port 4174
```

The selected root must contain its own `models.json`. Do not point the new entry
at legacy runtime data. The source entry is `npm run dev:durable` with the same
arguments and requires built Web assets. Ctrl+C shuts down both processes;
normal shutdown retains all data. A second worker cannot open the same root.
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
chat view contains the latest 200 SDK entries. Earlier originals remain in SDK
storage; comprehensive history browsing and retrieval are a subsequent slice.

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

`npm run verify` covers both entries: formatting, lint, source/test/configuration
types, offline tests, compiled startup and built-browser checks. The new fixture
uses the real SDK and SQLite against a controlled HTTP model service, including
native automatic compaction, current tool pairs, originals after reopen,
transport deduplication, credential checks and Stop. Browser checks cover send,
streaming, reload, Bot editing, Thread separation, shared Skill editing and
scoped memory editing/removal. Resource integration checks inspect actual model
inputs and SDK tool calls before/after edits and reopen, including read-only
built-ins, scope isolation and edits during an in-flight request.

No Docker operation or actual provider request is required by these checks.
`npm run test:infrastructure` builds the Computer image and separately verifies
real Docker file/shell agreement, concurrent first use, process-group cancellation,
public Stop, SDK chat tools, application reopen/container replacement, unsafe
path/archive rejection and workspace transfer using temporary resources and a
controlled HTTP model. It needs Docker but no personal provider credentials.
The legacy gateway infrastructure fixtures are outside this command's scope.

Comprehensive original-history controls,
full interruption/recovery combinations and default cutover remain subsequent
slices. Controlled-model success does not establish actual-provider acceptance.
