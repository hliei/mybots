# Durable work outcomes and uncertain recovery

Status: accepted
Implementation: Run stop, uncertain outcomes, explicit retry, and close are delivered; Routine occurrence scheduling and delegation remain planned

Explicit retry now creates a new Run under the same Task in the planned model,
preserving the prior Run outcome under
[ADR 0026](0026-durable-runs-and-serial-bot-execution.md).
The durable-evidence, uncertainty, and confirmed-stop requirements below remain.
ADR 0026 distinguishes capacity release from business-outcome resolution:
unconfirmed execution stop holds the Bot's serial slot, while confirmed stop
allows unrelated Bot work despite an uncertain outcome of the affected Run.

Chat work, task runs, delegations, and controlled Host actions reach success or
failure from durable correlated evidence of their work outcome, rather than treating input
processing acknowledgement as completion. Completion notifications require an
observed durable outcome. Known persisted waits and results can be reconciled
after restart, and unfinished execution claims retain the bounded recovery in
[ADR 0008](0008-mailbox-completion-and-recovery.md).

When acknowledged work or an action may have executed but its final outcome
cannot be established, present it as interrupted and requiring owner confirmation.
Hold automatic advancement of that work and subsequent runs of the same
scheduled task rather than silently replaying the entire acknowledged operation.
The owner can inspect existing evidence and explicitly retry or close the work;
attempts remain distinguishable. Other Bots and tasks continue independently.

This accepts an explicit uncertain outcome instead of claiming transparent
recovery across the acknowledgement/output gap. It preserves ADR 0008's possible
hard-crash loss, repeated tool effects, and duplicate delivery; a durable business
record does not establish exactly-once tool execution or restore an SDK call
stack. Explicit retry creates a new linked run after resolving the prior work
and confirming the old execution stopped, preserving the original outcome under
[ADR 0012](0012-dedicated-scheduled-task-sessions.md).
Chat work shares the lifetime, ownership and budget boundaries in
[ADR 0023](0023-work-item-lifetimes-and-owned-dependencies.md).
