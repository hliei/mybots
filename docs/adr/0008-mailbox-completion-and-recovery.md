# Mailbox completion and bounded recovery

Status: accepted
Implementation: initial mailbox acknowledgement/output separation and basic host
delivery delivered; follow-up acknowledgement, retry accounting and bounded
interrupted-execution recovery planned

Processing acknowledgements and outbound messages remain separate container-owned
mailbox records. Additional inputs pushed into an active SDK query are marked
completed when queued, and the initial input batch is marked completed on the
SDK result before final-result output is persisted. This favors matching the
selected execution lifecycle over introducing a stronger completion protocol.
A hard crash can therefore abandon queued work or a final reply after its input
has already been acknowledged. SDK transcript persistence and mailbox completion
do not form an atomic transaction.

Crash or stuck-container recovery retries unfinished processing claims with
bounded exponential backoff. Completed inputs are not redelivered, including
early-acknowledged follow-ups. Ordinary provider errors follow their separate
failure path rather than automatically repeating the whole task. A retry can
repeat a tool's external effects when execution preceded durable recording;
exactly-once tool execution is not guaranteed. Outbound delivery state remains
separate from input processing completion, and platform delivery can also be
duplicated around acknowledgement failures.

This planned contract replaces the no-automatic-resumption rule and combined
final-message/completion/pending-reply record in
[ADR 0004](0004-persisted-active-context.md), and the dependency on that combined
record in [ADR 0005](0005-durable-outbound-delivery.md). Those ADRs continue to
describe the delivered runtime until the architecture transition is implemented.
