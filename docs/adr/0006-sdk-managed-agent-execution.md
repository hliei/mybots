# SDK-managed Agent execution

Status: accepted
Implementation: planned; the delivered embedded runtime remains in use

Agent execution will move into isolated session containers, with the host
responsible for channel routing, operational message persistence, container
lifecycle, and delivery. The Pi coding-agent SDK will own the model/tool loop,
conversation context, compaction, and SDK session persistence. An adapter will
connect its lifecycle to the container runner rather than retaining a second
custom execution loop or a competing source of model context.

This accepts replacing existing execution and context mechanisms where their
responsibilities overlap the SDK. Compatible channel behavior and other host
capabilities may be reused, but retaining their implementation is not a design
constraint. The cost is revisiting existing session contracts and adapting the
SDK's lifecycle; the benefit is a single owner for Agent execution and context.

For capabilities included in a delivery, the data model and file layout will
follow the same ownership boundaries: host routing entities, per-session
directional mailboxes, SDK-owned conversation files, and shared Agent
directories. Entity relationships, field meanings, module responsibilities,
and persistent paths should remain consistent with that structure. Features
outside the delivery do not require placeholder modules, fields, or directories.
SDK requirements and concrete compatibility or maintenance costs can justify
adaptations; record their reasons in local planning. Existing schemas and paths
are reusable where they fit, but preserving them is not a design constraint.

This is the planned replacement for the custom execution and context ownership
in ADRs [0001](0001-agent-runtime-and-data-contracts.md),
[0002](0002-token-budgeted-context-compaction.md), and
[0004](0004-persisted-active-context.md). Those records still describe delivered
behavior until the transition. Completion and delivery persistence across the
SDK boundary follow [ADR 0008](0008-mailbox-completion-and-recovery.md), replacing
the combined completion record from ADRs 0004 and
[0005](0005-durable-outbound-delivery.md).

The transition starts with new sessions because there is no existing user data
to migrate. Legacy history import, archive tooling, old-session continuation,
and old data-format compatibility are outside the transition scope.

The first delivery serves the owner and establishes the complete host,
session-container, message-persistence, credential, SDK-execution, and
restart/delivery path with the existing CLI, Telegram, and WebSocket entry
points. Shared multi-user behavior, scheduling, automated memory maintenance,
and self-modification follow in later deliveries.

DeepSeek is the first live provider acceptance baseline through the Pi SDK;
model selection continues to use the SDK's provider capabilities. Initial
deployment and actual-service acceptance target the owner's macOS machine,
with Docker-based architecture retaining portability to Linux. Other providers
and deployment platforms need separate acceptance evidence.

## API and library documentation

- [Pi coding-agent SDK](https://github.com/earendil-works/pi/blob/39294a5e957f73a58818db9cb586771096d8c3d1/packages/coding-agent/docs/sdk.md).
