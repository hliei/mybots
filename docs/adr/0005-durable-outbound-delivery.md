# Durable outbound delivery

Status: accepted
Implementation: planned

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
