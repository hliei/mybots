# Computer and resources

Status: accepted target; implementation pending.

## Team Computer

Pi Durable runs on the host. Shell and working-file tools resolve a ComputerRef
and use SandboxProvider to reach Docker; direct host filesystem tools are not
an alternative path. The application owns host paths, mounts and container identity.
Validate tool inputs and paths at the provider boundary.

Relative paths and default command directories resolve to `bots/<botId>/`.
Explicit workspace-root paths support shared materials under `shared/`.
These directories organize files; they do not isolate Bots from one another.
Shell and file tools operate on the same bytes.

Start the single Computer on first shell/file use and reuse it, coordinating
concurrent first use without locking all execution. Persistent files survive
application restart and container replacement. Normal shutdown preserves them.
The provider supports workspace export/import, verified by a file round trip;
there are no per-turn workspace copies, management UI, snapshots or automatic
idle suspension.

## Bot configuration and Skills

Product SQLite stores each Bot's name, role instructions and selection from
host-configured models. Saved changes affect subsequent context loading without
rewriting an in-flight model request or retaining Attempt configuration versions.

Skills are shared across the default Space. Context includes their catalog;
full instructions are read on demand. Owners and Agents can deliberately maintain
user Skills; built-ins are read-only. There is no per-Bot enabled set, version
engine or marketplace.

## Memory

Product SQLite stores readable Markdown in two scopes:

- **Bot memory** belongs to one Bot and is supplied only to its work.
- **Owner memory** holds preferences and background shared across Bots.

Owners can view, edit and remove memory; Agents can deliberately maintain it
through scoped tools. Memory is retained knowledge, not a copy of the transcript.
Skills and memory are database content, not physical `SKILL.md` or `MEMORY.md`
files on the Computer. No vector store or background memory job is required.

Edits affect later context loading. They neither erase earlier transcript entries
nor guarantee that a model forgets previously supplied content.
