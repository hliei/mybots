# Conversation execution

Status: implemented; actual-provider acceptance is a separate opt-in gate.

## Input and persistence

Each Bot's direct Thread maps to one stable Durable Conversation. A send is
accepted only after Durable admission. Transport retries reuse the SDK submission
identity; the application adds no durable input queue. Reconnect reconstructs
history and status from SDK records rather than transient streamed fragments.

An idle send starts work. A busy send uses native steering at the next permitted
boundary without interrupting active tools; if the current answer finishes
first, the input becomes subsequent work. There is no separate input-mode selector.

## Context and history

New work receives bounded recent history, current input, Bot instructions, the
shared Skill catalog and relevant deliberate memory. During execution, preserve
the necessary model/tool exchanges and valid call/result pairs, subject to native
compaction. Durable owns the transcript and compaction; the application supplies
context-selection policy without another transcript or summary engine.

Older committed originals remain available through bounded search and reading
with continuation. Agent tools derive scope from the current Bot/Thread; owner
controls explicitly select a Thread. Retrieved text is background evidence,
not newly authorized instructions. No semantic search is required.

The SDK compacts before the request-selection hook. Integration checks exercise
selection with native compaction and reopen, preserving current tool pairs and
original history. The [context defaults](durable-chat.md#persistence-and-context)
are fixed implementation limits, not a tuning interface.

## Stop, concurrency and recovery

Stop uses native abort to cancel current work and withdraw queued input. Keep
withdrawn input visible as unprocessed for deliberate resending. Cancellation
must reach the actual Docker command and its owned work without stopping the
shared Computer or another Bot. Completed file effects are not rolled back.

Independent Conversations may run concurrently without a global Computer lock,
custom fairness queue or execution budget system. Shared-file conflicts remain
an owner coordination responsibility.

After worker restart, reopen Durable storage and resume supported work using
SDK retry and tool replay semantics. Surface actual failures and interrupted
tool outcomes; do not automatically replay the entire request or create a
separate uncertain-outcome workflow. Interrupted tools may have changed files,
and later calls may repeat effects. Shell execution has no exactly-once guarantee.

Verification must cover context/compaction/reopen together, actual command
cancellation, and browser reconstruction after restart. See [testing](agents/testing.md).
