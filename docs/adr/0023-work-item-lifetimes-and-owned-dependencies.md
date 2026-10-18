# Work item lifetimes and owned dependencies

Status: accepted
Implementation: planned

A work item is tracked Bot work originating from a chat request, task run or
delegation. It can span multiple Agent turns, active execution stages and
persistent waits. An initial message in a chat session with no unfinished chat
work starts a root work item. FIFO follow-ups accepted before it terminates,
including additions during dependency waiting, belong to that work and share
its stopping scope, cumulative active budget and originating-chain delegation
count. A message after terminal completion starts new work. Uncertain work still
requires explicit resolution rather than restarting from an ordinary new message.

Controlled Host requests and user decisions are associated with the work instead
of opening additional model-execution work items. This unifies owner-visible
status and limits without prescribing a generic work table, workflow engine or
competing Agent execution loop.

Parent work cannot complete while its owned delegations or necessary user
requests remain unfinished. Settle unwanted children through explicit cancellation
and confirmed termination; uncertain children hold the parent for owner handling.
Detached delegation is outside the current delivery. An explicitly created
independent scheduled task is a separate persistent definition, not an owned
child delegation, so stopping the originating conversation does not roll back
its creation. These rules keep completion notifications, next task runs, and
cancellation ownership consistent.
