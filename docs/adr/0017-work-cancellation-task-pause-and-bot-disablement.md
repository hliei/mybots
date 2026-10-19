# Work cancellation, Routine pause, and Bot disablement

Status: accepted
Implementation: planned

Stopping selected work cancels that work, its owned delegated descendants and
pending user decisions. Preserve history and existing results; stopping one
occurrence Run leaves its Routine enabled. Cancelling delegated work
does not cancel unrelated work of its target Bot.

Pausing a Routine prevents future starts while allowing its current run
to finish. Disabling a Bot prevents new chat, Routine and delegation admissions and
requests cancellation of its current work and owned descendants. Preserve Bot
configuration, memory and history. Re-enabling does not revive cancelled work.

These operations distinguish scheduling admission from stopping execution, so
the owner can pause future work without interrupting current progress. Cancellation
remains stopping until termination is confirmed. Completed external effects are
not rolled back, and unprovable outcomes follow
[ADR 0016](0016-durable-work-outcomes-and-uncertain-recovery.md). Routine resume follows
the scheduling contracts in [ADR 0012](0012-dedicated-scheduled-task-sessions.md)
as refined by [ADR 0025](0025-tasks-routines-and-independent-occurrence-context.md);
cancelled-work late results
remain inspectable without restarting the source under
[ADR 0013](0013-tracked-asynchronous-bot-delegation.md).

Bot deletion first follows disablement and removes the active identity from
normal chat/management use, while retaining a tombstone identity, history,
results, workspace and memory for inspection. The UI explicitly identifies this
as data-preserving logical deletion. Creating another Bot with the same display
name produces a new identity and workspace with no implicit inheritance. Content
already transferred and retained by other Bots is not automatically removed.
Restoring the deleted identity and permanently purging retained data are outside
the initial deletion contract. This preserves collaboration/result provenance
while accepting retained storage after deletion.
