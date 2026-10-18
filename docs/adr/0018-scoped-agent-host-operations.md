# Scoped Agent-to-Host operations

Status: accepted
Implementation: planned

The owner manages Bot creation, deletion, disablement, role/model/tool/Skill
selection, collaboration policy, and installation settings through management
interfaces. Agents may suggest these changes but do not administer them.

An Agent can use scoped Host operations to manage its Bot's scheduled tasks,
delegate under the directed collaboration policy, ask the owner questions, submit
proposed controlled actions, publish its work progress, and deliver selected
results. Ordinary management of its own Bot's tasks needs no additional approval
per call. It cannot manage other Bots' tasks or grant itself privileges. The Host
derives caller identity and scope from the actual session rather than trusting
identity claims in request payloads.

This permits useful autonomous work while reserving identity/configuration and
privilege changes for the owner. It governs Mybots management operations, without
expanding [ADR 0014](0014-controlled-host-action-approvals.md) to general shell or
network side-effect review or changing the gateway network boundary in
[ADR 0009](0009-direct-gateway-network.md). Concrete operation contracts remain
subsequent interface design.

A Host request timeout means the result is not yet confirmed, rather than proof
that the operation did not apply. Query the same stable request identity rather
than issuing another operation. Persisted pending decisions and results drive
continuation without requiring a blocking SDK call to survive.
