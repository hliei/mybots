# Append-only session recovery

Status: accepted
Implementation: planned

Messages and successful compaction records will share one append-only, linear
session log. A compaction record stores the original summary and a stable
`firstKeptEntryId` retention boundary. Active context is reconstructed from the
latest valid compaction's summary, retained original messages before that record,
and messages appended afterward. Recovery reuses the saved summary without a
model request or a separate full active-context snapshot. Older messages remain
in the log, and older compaction records are not projected as model messages.

New records receive stable IDs. Legacy messages retain their existing fields
and receive deterministic recovery IDs based on immutable physical log positions,
including positions of skipped lines. Appending records must not change those
IDs. Original `reasoning_content` and tool results remain intact; absent reasoning
is never fabricated. Without a valid compaction, reconstruct from recognized
messages and compact later only when the normal budget rules require it.

## Recovery validation

Skip syntactically invalid JSON lines with diagnostics. A nonempty file that
cannot be recognized as a valid session produces an explicit error and is
preserved. Recognize existing message logs through their valid session metadata
and message format. Preserve malformed trailing bytes; separate future appends
with a newline only after the session has been recognized as valid.

A compaction needs a nonempty string summary and a stable boundary resolving
to an earlier message in the same log at a valid retention boundary. A boundary
equal to the compaction's own ID explicitly represents an empty retained prefix.
Missing, wrongly typed, ambiguous, or unresolved boundaries do not imply an empty
prefix. Diagnose and exclude invalid candidates, search backward for the latest
valid compaction, and use recognized message history if none is valid. Optional
statistics do not determine context; malformed statistics are diagnosed and
ignored rather than invalidating an otherwise usable summary and boundary.

## Turn and delivery state

Compaction records describe context reduction, not execution or delivery status.
Preserve saved model messages and confirmed tool results. For unresolved calls
in an interrupted exchange, append ordinary tool-result messages with the original
call IDs and explicit unknown-outcome interruption text. Append an interruption
state record to close the turn. Persist repairs before accepting another turn;
existing saved results make repeated recovery idempotent. Recovery does not
execute tools or automatically resume interrupted turns.

Commit successful completion as one message-bearing log record: the final
original assistant message includes additive metadata identifying the completed
turn and its recoverable pending reply. Validate the whole record and durably
append it before announcing completion, broadcasting, or delivering. Its message
projection completes the context, and its metadata projection creates the pending
reply, so there is no separate final-message/outbox commit gap. Invalid completion
metadata must not silently degrade into a successful ordinary message; report
the affected session's recovery error and preserve its files.

Delivery progress and acknowledgements are additional state records keyed by
stable reply identity. State-only records never enter model context. Pending
delivery files and session-index metadata are projections that can be repaired
from the log. A saved acknowledgement wins over a stale pending file. Legacy
messages without completion metadata never create retroactive pending replies.

This extends the initial in-memory lifecycle described in
[ADR 0002](0002-token-budgeted-context-compaction.md). The current implementation
still keeps compaction state in memory; this decision describes planned behavior.
Conversation and compaction remain linear; branching and alternate session paths
are outside the selected design.
