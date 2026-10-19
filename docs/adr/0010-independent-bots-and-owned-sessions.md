# Independent Bots with owned sessions

Status: accepted
Implementation: planned

The multiple owner-created chat-session and FIFO-only input choices below are
superseded for the planned model by
[ADR 0024](0024-single-direct-thread-and-application-owned-context.md).
Task/Routine lifetimes and context follow ADRs 0025-0027; the text below
preserves the superseded multi-session decision rather than a pending choice.
Same-Bot concurrency is superseded by serial execution under
[ADR 0026](0026-durable-runs-and-serial-bot-execution.md).

Each Bot has one Agent identity and Agent group, with its own workspace, memory,
configuration, and sessions. An Agent session belongs to exactly one Bot; the
owner can explicitly create and select multiple sessions for that Bot. Sessions
of the same Bot share working files and deliberately persisted memory while
retaining separate conversation histories and active contexts. Separate sessions
therefore do not isolate shared working materials from one another.

Cross-Bot collaboration transfers explicit messages, selected materials, and
results between sessions rather than merging their conversation histories or
implicitly sharing workspaces. This keeps each Bot's working context independent
while allowing deliberate handoffs. An aggregated collaboration view does not
require a shared execution session.

This replaces the default single personal Agent across entry points in
[ADR 0007](0007-shared-agent-workspace.md). Its same-Agent workspace sharing,
separate histories, sequential session execution, cross-session concurrency, and
accepted shared-file conflict behavior remain applicable. Task and delegation
session assignment follows [ADR 0012](0012-dedicated-scheduled-task-sessions.md)
and [ADR 0013](0013-tracked-asynchronous-bot-delegation.md).

Owner-created chat sessions can be named, selected, archived and reopened.
Archiving organizes the list without stopping work or deleting history. Input
during active execution remains a FIFO follow-up rather than live steering.
During delegation waiting, appended instructions stay associated with the
originating work for later continuation; unrelated work uses another chat session.
Answers/approvals use the correlated request controls.

Task/delegation sessions are inspectable in work details with associated decision
and work controls rather than admitting arbitrary new independent chat work.
Reset is allowed only with no unfinished work; it starts fresh active context
while retaining earlier history, shared memory and files. Session-data purge is
outside the current delivery.

Chat work and follow-up lifetime/ownership follow
[ADR 0023](0023-work-item-lifetimes-and-owned-dependencies.md).
