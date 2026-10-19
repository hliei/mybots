# Single direct Thread and application-owned execution context

Status: accepted
Implementation: planned; detailed execution contracts remain under design

Each Bot has one persistent direct Thread with the owner instead of multiple
owner-created chat sessions. Mybots owns the durable product conversation history
and selects the context supplied to an execution; Pi performs the model and tool
loop for that execution. This separates the owner's continuous conversation from
the context used to perform particular work, accepting application responsibility
for context selection instead of relying exclusively on a continuing SDK session.

Retain the Pi coding-agent SDK for Run-local execution. Each Run has an independent
SDK session initialized with application-selected context; later Attempts reopen
that Run's recorded context. The SDK owns the Run-local model/tool loop, Skills
integration, conversation recording, and compaction. Mybots owns the product
Thread and cross-Run history selection, without automatic Thread-summary jobs or
a competing Run-local compaction engine.

Pi and tool execution remain inside isolated containers. The Host continues to
coordinate work through the existing directional mailboxes, SQLite persistence,
and credential gateway. This decision does not move Pi into the Host process.

Ordinary chat sends target the Thread. At durable admission, append to the
current conversational Run if it can accept the input; otherwise create a
subsequent Task and Run. Thread history supplies the background for follow-up
phrases rather than implicitly retrying old work. Ordinary sends do not require
the owner to select a still-running Task or recover a draft merely because the
previous Run ended. Stable request identity preserves the admitted message's
Task/Run association across response loss, completion races, and client retries.
An input admitted before completion cannot be orphaned by the terminal transition.

Explicit Task-targeted additions are available for all Task origins, including
Routine occurrences and delegations. An active target receives steering at the
next permitted model boundary without forcibly interrupting in-flight tools;
queued or waiting targets retain the addition for later processing. Additions
affect the selected Task, not the Routine definition or another Task using the
Bot. They do not implicitly retry terminal work. Ordinary Thread sends do not
guess a background Task as their target. Multiple decision requests require
their correlated controls; ordinary chat or added instructions do not grant
approvals, resolve uncertain effects, or settle necessary owned dependencies.
These rules replace the FIFO-only conversational-input choice in ADR 0010.

The direct Thread presents conversation, source-labelled work summaries,
questions, and linked Task cards. Complete inputs, tool records, Run/Attempt
history, and results remain inspectable in Task details rather than being
flattened into interleaved conversations. Visibility in the Thread does not
automatically select content for another execution's model context.

Resetting chat background establishes a new boundary for future conversational
Runs without erasing history, workspace, or memory. Their default recent-history
selection and history lookup start at that boundary; older material requires
deliberate owner selection. Runs already admitted, including queued or waiting
Runs, retain their original boundary and evidence. Reset does not cancel them or
rewrite their SDK context.

For the planned model, this supersedes the multiple owner-created chat-session
choice in [ADR 0010](0010-independent-bots-and-owned-sessions.md) and the exclusive
SDK ownership of cross-execution history and context in
[ADR 0006](0006-sdk-managed-agent-execution.md). It does not change delivered
behavior by itself. Task and Routine meanings and scheduled-context selection
are recorded in
[ADR 0025](0025-tasks-routines-and-independent-occurrence-context.md).
Run/Attempt lifetimes and serial per-Bot execution are recorded in
[ADR 0026](0026-durable-runs-and-serial-bot-execution.md).
The selected SDK split and reset boundary refine
[ADR 0027](0027-retrieval-based-thread-history.md). The planned input and execution
contracts are settled; coordinated specification and ticket revision follows
overall shared-understanding confirmation.
