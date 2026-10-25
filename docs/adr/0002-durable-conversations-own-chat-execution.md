# Durable Conversations own chat execution

Status: accepted and implemented.

Map each Bot's direct Thread to one stable Pi Durable Conversation. Let the SDK
own submission, execution, transcript, compaction and supported recovery to
avoid duplicate state and recovery coordination. Accept dependency on its
semantics instead of adding an application Task/Run/Attempt state machine.

The application selects recent context and retrieves older originals through
SDK extensions without another transcript or summary engine. Use native
steering, abort and recovery; interrupted shell effects are not guaranteed to
run exactly once. Prove context selection with native compaction and reopen
before dependent implementation proceeds.

See [conversation execution](../conversation-execution.md).
