# Conversation execution

Status: implemented; actual-provider acceptance is a separate opt-in gate.

## Input and persistence

Each Bot's direct Thread maps to one stable Durable Conversation. A send is
accepted only after Durable admission. Transport retries reuse the SDK submission
identity; the application adds no durable input queue. Reconnect reconstructs
history and status from SDK records rather than transient streamed fragments.

Before transport, Web saves one unconfirmed delivery per Bot with its Conversation,
text and request ID in browser local storage. Reload and worker recovery only look
up native admission; they never send automatically. Retry delivery reuses that
identity. Discard removes only the browser record, so previously admitted work
continues; a later intentional send or Resend uses a new identity. Draft edits
cannot silently replace an unconfirmed delivery. Resolve an unrelated pending
delivery before deliberately resending older unanswered input.

The worker persists display text as an idempotent SDK write before input admission.
Only a matching native input makes that text visible as queued or unanswered; an
orphan display record never starts work. Retries must match the persisted display
text before admitting that identity. Public SDK submission scans discover
unanswered inputs independently of the recent chat window, including withdrawn
inputs without a transcript entry. No SDK-private table queries are used.

An idle send starts work. A busy send uses native steering at the next permitted
boundary without interrupting active tools; if the current answer finishes
first, the input becomes subsequent work. There is no separate input-mode selector.

## Readable chat

Web shows assistant narration and replies, with tool activity off by default.
The saved browser preference enables concise collapsible steps: open while their
Agent turn is active, folded after it settles, with manual toggles preserved
through progress updates. Tool-only messages use activity lines rather than empty
bubbles. Raw arguments and full tool output remain in the original-history reader
and history tools; chat transports at most 500 characters of each tool result and
160 characters of a step's diagnostic or current output.

Each step associates its assistant entry and native call ID with its result,
retaining failed/interrupted outcomes. Only an SDK input's answer entry is labelled Completed; narration,
interrupted fragments and partial streams never establish completion. Projection
uses at most 200 recent entries at the observed watch boundary, avoiding a new
transcript or a separate event log. Outstanding inputs are read in SDK pages of
200 without a history-age cutoff. Those reads scale with outstanding inputs;
recent completion reads stop after passing the visible window.

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
shared Computer or another Bot. It also stops services started by the current
turn, while preserving services retained by earlier successful turns. Retention
is marked only after native input settlement, using the first submission ID
across generation handovers. Completed file effects are not rolled back.

Bounded Computer commands publish native tool progress and can return running
output before exit. At a final-answer boundary, the native onYield continuation
supplies their bounded final output without replaying the commands. This is
separate from explicit retained-service launch; see the
[Computer contract](durable-chat.md#team-computer).

Independent Conversations may run concurrently without a global Computer lock,
custom fairness queue or execution budget system. Shared-file conflicts remain
an owner coordination responsibility.

The API supervises the worker with a bounded restart budget and rebinds existing
subscriptions without resubmitting admitted input. Pending IPC calls fail on
process loss; the owner checks the reconstructed chat before retrying ambiguous
input. Recovery status is separate from browser connectivity.

Before enabling execution after reopen, reconcile Computer ownership with native
submission status and clean interrupted-turn work. `Harness.open` reconciles tasks
without dispatch; cleanup uses read-only submission status before `resume`,
submission, abort or wait operations can enable scheduling. Failed cleanup leaves
execution paused and ownership records intact. Before scanning commands, seal
previous worker launch generations and join their provider-side launch locks;
late Docker execs are rejected even after a container restart or replacement.
Fresh worker generations still allow native continuation to launch new work. Completed-turn retained services
are preserved, including a service whose native submission settled just before
the old worker could mark retention. The host ownership journal records only
Bot/turn identities and a launch generation before process launch; it is not an execution queue.

After confirmed cleanup, resume supported work using
SDK retry and tool replay semantics. Surface actual failures and interrupted
tool outcomes; do not automatically replay the entire request or create a
separate uncertain-outcome workflow. Interrupted tools may have changed files,
and later calls may repeat effects. Shell execution has no exactly-once guarantee.

Verification must cover context/compaction/reopen together, actual command
cancellation, and browser reconstruction after restart. See [testing](agents/testing.md).
