# User questions and controlled Host action approvals

Status: accepted
Implementation: partial. Persistent user questions and same-Run continuation are implemented; controlled action approvals remain planned.

The current delivery includes persistent user questions and approvals for
explicitly controlled Host operations. A user question collects information or
a preference; an action approval binds a proposed operation and its concrete
inputs for an owner decision. Operation policy determines which actions require
approval, and approved Host actions execute through that controlled boundary.

This scopes enforcement to operations the Host can identify and control rather
than adding general risk review across every shell, file, or network effect.
Permitted runner tools continue operating within their granted execution
permissions; a voluntary confirmation question does not intercept their arbitrary
side effects. The localhost Web UI accepts user answers and approve/deny actions;
Telegram only announces pending decisions with Bot, work, and request identity.
Telegram callbacks and free-text decision routing are outside the current
delivery. A local-client link is useful on the Host computer but does not provide
remote access from a phone.

Questions and approvals wait for the owner by default; client disconnect and
Host restart do not automatically expire them. An explicitly specified deadline
can expire a request without executing its operation, leaving the originating
work needing attention. This permits a local-only owner to return to the Host
computer but can hold that task's later scheduled runs while a request waits.

Submitting a decision revalidates request state, proposed inputs and current
permissions. Changed or stale requests require a new decision; duplicate or late
answers cannot apply an already resolved request again. Operation scope follows
[ADR 0018](0018-scoped-agent-host-operations.md), directed collaboration policy
follows [ADR 0013](0013-tracked-asynchronous-bot-delegation.md), and uncertain
restart outcomes follow [ADR 0016](0016-durable-work-outcomes-and-uncertain-recovery.md).
Persisting an approval does not imply exactly-once execution or a surviving SDK
tool invocation.
