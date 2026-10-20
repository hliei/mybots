# Dedicated persistent sessions for scheduled tasks

Status: accepted
Implementation: planned

The dedicated persistent conversation and automatic cross-occurrence context
continuity below are superseded by
[ADR 0025](0025-tasks-routines-and-independent-occurrence-context.md).
Other scheduling behavior remains the baseline while Task/Run terminology and
execution contracts are revised.

Each scheduled task owns a dedicated persistent Agent session belonging to its
Bot. Task runs reuse that session rather than joining the originating chat or
creating a fresh session for every occurrence. Runs retain distinguishable state
and results linked to the task and its creation source.

This keeps scheduled execution separate from everyday conversation while
allowing prior-run context to carry forward. The tradeoff is that previous runs
can influence later ones; normal context compaction and deliberate memory remain
relevant. This does not prescribe a second owner of
SDK conversation history or the physical storage of task/run records.

Recurring schedules use the owning Bot's timezone, falling back to the
installation default, initially Asia/Shanghai. One-shot times resolve to absolute
instants at creation. The UI exposes the resolved schedule, timezone and next
run. A timezone change affects future scheduling calculations without shifting
already admitted work or requiring a container restart; this Host scheduling
setting is distinct from runner configuration application.

Admit at most one unfinished run per task, including time spent waiting for the
user or delegated work. Scheduled slots while a run is unfinished do not create
a backlog. On restart, an existing overdue occurrence runs once rather than
creating an occurrence for every missed historical slot. An overdue one-shot task
also runs once. After a known terminal run outcome, calculate the next future
cron occurrence; an ordinary failure does not silently remove the recurring
definition. This favors current work over replaying stale periodic output.

Uncertain outcomes follow [ADR 0016](0016-durable-work-outcomes-and-uncertain-recovery.md).
Task instruction/schedule edits apply to newly admitted runs; already queued or
executing runs retain their admitted work definition. Resuming a recurring task
selects the next future slot without replaying paused-period occurrences; an
overdue paused one-shot runs once on resume. Manual run-now is allowed while
paused without re-enabling recurrence, but is refused while a run is unfinished.

Deleting a task cancels its current/queued owned work and future scheduling while
retaining the definition identity, history and results. Explicit retry creates a
new linked run preserving the original outcome, after resolving prior unfinished
or uncertain admission and confirming the previous execution stopped. Ordinary
provider errors do not automatically rerun the whole task beyond SDK request
retries and accepted unfinished-claim recovery. Clients expose these operations;
Agents manage tasks only within their Bot's scope, including logical deletion.
The implemented parser and daylight-saving policy are documented in
[Host Routines](../host-runtime.md#cron-parser-and-daylight-saving).
