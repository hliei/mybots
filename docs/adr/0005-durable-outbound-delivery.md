# Durable outbound delivery

Status: accepted
Implementation: completion commits, ordered delivery workers, finite retries, chunk progress, acknowledgements, and the local WebSocket interface delivered; Telegram adapters planned

Generated replies awaiting delivery will be persisted, retried after delivery
failure, and recovered after restart. A pending reply is cleared only after
delivery is confirmed. This favors continued delivery over discarding a failed
reply and permits duplicates when a recipient accepts a reply but the process
stops before recording success. Exactly-once delivery is not promised.

Delivery uses a finite number of attempts with backoff. Exhausting those attempts
retains the pending record and records the failure, so a later restart can retry.
For replies split into multiple messages, persist confirmed chunk progress and
continue from the first unconfirmed chunk. A crash after platform acceptance but
before recording progress can still duplicate that chunk.

Replies are delivered in order within each Agent session. Retry waits do not
block other sessions or Agent execution. Exhaustion pauses that session's
delivery, preserving subsequent replies; restart recovery processes older
pending replies first. One appended completion record contains the final assistant
message and its pending reply before broadcasting or delivery, as described in
[ADR 0004](0004-persisted-active-context.md). Delivery progress and acknowledgements
are appended separately by stable reply identity. Pending files are projections
of that log: rebuild missing pending files, resume at the saved chunk boundary,
and suppress stale pending files whose replies have saved acknowledgements.
Compaction records do not establish delivery or turn-completion state.

The Agent commits completion before returning its answer. Senders use
`getPendingReplies()`, `confirmChunks(replyId, confirmedChunks)` and
`acknowledgeReply(replyId)`; the confirmed count is the number of chunks already
accepted, so delivery resumes at that zero-based boundary. The CLI confirms only
its current session's reply after the standard output write completes. Each CLI
launch creates a new session and does not replay older CLI deliveries.

The runtime optionally accepts delivery transports for Telegram and WebSocket
destinations. Adapters own recipient lookup, a stable maximum chunk size in Unicode code points,
and asynchronous sends that settle only after cancellation cleanup. Terminal
delivery stays with the current CLI subscriber and is never recovered into a
later launch's output. Without delivery transports the runtime leaves generated
replies pending for an explicit sender.

Each session owns an independent delivery queue. Startup reads existing sessions
and configured bindings and schedules pending deliveries before new replies.
Five total attempts use four waits of 5 seconds, 25 seconds, 2 minutes and
10 minutes, each with uniform integer jitter within plus or minus 20 percent.
Retries re-read committed chunk progress. Paragraph boundaries are preferred;
oversized paragraphs are split by Unicode code points. Transport limits must stay
stable across restarts so confirmed counts refer to the same chunk boundaries.
Exhaustion or a missing adapter appends `reply_failed` with attempt count and error,
retains pending replies and pauses that session until the next runtime instance.
These records do not enter model context. `deliveryFailures` exposes delivery and
persistence errors independently of Agent outcomes. Shutdown owns workers, sends
and waits through its signal, awaits them, and retains committed progress.

Pending projections live at `event_path/pending/<sessionId>/<replyId>.json`.
Recovery validates completion metadata and state references before repairing
files; invalid completion metadata raises a session error. Missing projections
are rebuilt and acknowledged or orphaned projections are removed. Projection
failure after a completion append does not undo that append: recovery retains
the answer and pending reply without invoking the model or tools again.

Reply destinations retain the source encodings `platform-cli:cli-user`,
`platform-telegram:<userId>:<chatId>` and `platform-ws:<userId>`.

The local WebSocket interface is the explicit sender for WebSocket replies and
registers no delivery transport. It broadcasts each committed outbound envelope
to every connected client and acknowledges a `platform-ws:` pending reply only
after at least one client accepted that envelope. A reply with no connected
recipient, or one whose destination belongs to another platform, stays pending
for a later explicit sender. Acknowledgement is per committed reply: an older
unconfirmed reply remains pending without gating a later broadcast
acknowledgement, because the interface replays no historical replies and
per-session event order already governs what connected clients observe.
Connected clients are observers: a slow, failed, or
disconnected peer is dropped without blocking the event dispatcher or another
session. No client acknowledgement or replay protocol is added: a reconnect
observes new events rather than historical replies, and unconfirmed replies stay
recoverable for an explicit sender.
