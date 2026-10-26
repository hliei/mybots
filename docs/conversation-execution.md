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

Runtime guidance is composed as SDK prompt sections alongside Bot instructions.
It describes the offered Computer tools, actual paths and writable directories,
Skill discovery, scoped memory and original-history retrieval. Current resources
are injected for each generation request; instructions, model selection and
provider credentials refresh at the next model boundary. Editing them does not
rewrite an already issued request. Tool output, recalled memory and retrieved
history are background evidence, not fresh execution authority.

## Model outcomes and fixed limits

Generation uses the SDK's persisted retry policy: up to three retries, with
2-, 4- and 8-second backoff (capped at 60 seconds). In-request provider retries
are disabled to avoid multiplying that budget. Authentication, subscription
quota and other permanent failures remain actionable failures; sanitized errors
retain the SDK's transient-error classification without retaining provider bodies.

Requests use a 120-second response-header timeout where the adapter supports it.
An additional 180-second model-progress idle timeout aborts a silent stream,
including adapters without a header timeout. Each SDK model event resets the
idle timer; SSE keepalives do not. Timeouts and missing terminal signals enter
the same bounded SDK retry policy. Active streams may last longer while making
progress. Stop aborts the request or retry backoff immediately.

An empty or whitespace-only final response, reasoning without an answer, invalid
tool completion, or output-token exhaustion becomes an SDK model failure rather
than successful completion. Earlier narration and completed tools do not count
as a final reply. The admitted input remains visibly unanswered with its failure
reason. There is no automatic prose-only continuation or replay of committed
tools or user input; deliberate resending is new work. Genuine provider failures
are not reclassified as missing final prose.

SDK tool results retain their native limits (2,000 lines or 50 KiB, whichever
comes first) and truncation diagnostics. Model and tool progress use the SDK's
100 ms persistence interval. Read a required original slice through shell/file
tools or explicitly save a workspace log; truncated output is not a complete
record. No additional full-log store or tuning UI is provided.

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
