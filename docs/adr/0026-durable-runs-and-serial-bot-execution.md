# Durable Runs and serial Bot execution

Status: accepted
Implementation: partial. Serial Bot execution and fair admission are implemented. Cumulative Run budgets are implemented. Persistent question waits and same-Run continuation are implemented. One-shot and cron Routine occurrences use the same admission and budget rules. Single-hop child waits release capacity and resume the original parent Run. Nested delegation remains later work.

A Task is the requested objective; a Run is one logical execution of that Task;
an Attempt is a period of actual execution. A durable wait retains the Task and
Run, ends the current Attempt, and allows a later Attempt to continue. Explicit
retry creates a new Run under the same Task and preserves the earlier Run's
outcome. A new Routine occurrence creates a new Task rather than retrying the
previous occurrence. Existing uncertain-effect holds and confirmed-stop rules
remain applicable; these identities do not establish instruction-level recovery
or authorize replay of operations whose effects are unknown. Persist the Run's
inputs, completed model/tool exchanges, wait reasons, user answers, and child
results as continuation evidence for later Attempts. Continuing reconstructs
context from that evidence instead of rerunning tools with known results or
restoring an arbitrary in-flight tool stack.

Each Bot executes at most one Attempt at a time, including its model and working
environment operations. It may own multiple independent Tasks that are queued
or waiting. Different Bots may execute concurrently, retaining the four-global
active-execution default from
[ADR 0022](0022-bounded-active-session-admission.md). Durable waits release active
capacity. Serial execution replaces same-Bot concurrent session execution and
the two-per-Bot active default, accepting within-Bot queueing to avoid competing
model/tool execution in the shared working environment.

New independent work and work made runnable after a wait join a fair durable
queue. They do not automatically preempt an active Attempt. Completion, a
durable wait, or confirmed stop permits the next execution. Active conversational
steering still targets the running work rather than opening a competing Attempt.

Steering remains durably associated with its target Run at the Host. Placing it
in an SDK memory queue alone is not evidence of durable consumption; reconcile
recorded input and Run evidence across restart. This does not make input, SDK
transcript, tool effects, and final output one atomic transaction or establish
exactly-once effects. A durable wait ends its Attempt only after the current
tool batch has recorded complete results, retaining valid tool-call/result pairs.

The default sixty-minute active execution budget belongs to the Run and
accumulates across its Attempts, excluding queue, user, and dependency waiting.
Steering, resumption, and process replacement do not reset that budget. Explicit
authorized retry creates a new Run and budget. Delegation-chain counts likewise
remain attached to the originating Run across Attempts rather than resetting
when execution resumes.

Unconfirmed execution stop retains that Bot's serial capacity because tools may
still be operating; other Bots may proceed. Once stop is confirmed, an uncertain
business outcome holds only the affected Run and subsequent occurrences of its
Routine. Unrelated Tasks of that Bot may then proceed. Releasing execution
capacity does not resolve unknown business effects or authorize their replay.

Delegation retains parent-owned child Tasks, durable waiting, correlated child
results, descendant cancellation, and the accepted permission and chain bounds
from [ADR 0013](0013-tracked-asynchronous-bot-delegation.md). A child result makes
the original parent Run eligible for another Attempt; it does not silently create
a new parent Task. Parent completion still requires settled owned dependencies.

This refines the Task vocabulary in
[ADR 0025](0025-tasks-routines-and-independent-occurrence-context.md) and supersedes
the earlier same-Bot concurrency choice in
[ADR 0007](0007-shared-agent-workspace.md) and
[ADR 0010](0010-independent-bots-and-owned-sessions.md).
It also replaces the earlier work-item and retry-identity interpretation in
[ADR 0023](0023-work-item-lifetimes-and-owned-dependencies.md) and
[ADR 0016](0016-durable-work-outcomes-and-uncertain-recovery.md), while preserving
their dependency-completion and honest-outcome requirements.
