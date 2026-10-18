# Agent-maintained file memory

Status: accepted
Implementation: planned

Each Bot retains long-term memory as readable Markdown in its own workspace,
with a concise core/index and detailed topic files. The Agent deliberately
maintains useful facts, preferences, and work summaries through normal file tools
without approval for every memory edit. The owner can inspect, correct, and
delete memory. Separate Bots do not implicitly share memory.

Make concise core memory available in fresh, reset, and compacted conversation
context; retrieve details as needed. Conversation history remains separate and
is not copied wholesale into memory. This favors inspectable persistent knowledge
using existing file capabilities over a vector database or independent background
maintenance service. The client provides index/topic viewing and basic text
editing/deletion. Owner edits become available to subsequent context loading or
turns rather than rewriting an active model invocation.

Version-aware owner saves flag observed intervening file changes for rereading
and reconciliation. Retain the shared writable workspace semantics of
[ADR 0007](0007-shared-agent-workspace.md): ordinary Agent file tools may still
race or overwrite, and there is no general conflict-free write or automatic
semantic merge guarantee. Load at most 16,000 characters each from the concise
index and definition by default, explicitly indicating truncation and allowing
detailed-file retrieval. Writable memory does not create another owner of SDK
conversation context.

Current memory is the deliberately shared version across the Bot's sessions.
Subsequent execution receives current core content or change indication and
treats explicit owner corrections as newer than old recollections. Deleting
memory stops deliberately supplying it as current shared memory; it does not
erase retained SDK history/context or guarantee permanent forgetting or prevention
of old facts being saved again by ordinary file tools. Changing external facts
still require current-source checks. Full history erasure and cross-session fact
suppression are outside this delivery, preserving the ordinary file-concurrency
tradeoff above.
