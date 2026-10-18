# Host-owned durable Bot configuration

Status: accepted
Implementation: planned

The Host owns one durable authoritative configuration for each Bot. Web UI and
management API edits persist across Host restarts, and chat, scheduled work,
and collaboration execution derive Bot settings from that authority. Startup
must not overwrite managed Bot configuration with installation-file values.

Installation configuration owns Host, Docker, gateway, and channel setup; an
initial Bot seed applies only during bootstrap. This separates managed Bot
settings from deployment settings and avoids competing file and API sources of
truth. Model choices come from the installation-approved set for one initially
integrated provider, allowing different Bots to select different available
models. Credentials and endpoints remain installation/gateway concerns.

Role instructions, model, tools and enabled Skills are Bot-level configuration
inherited by chat, scheduled-task and delegation sessions. Per-session, task and
delegation configuration overrides are outside the current delivery; work-specific
instructions remain ordinary task/message content. Owner-only configuration
management follows [ADR 0018](0018-scoped-agent-host-operations.md).

The owner imports and maintains locally installed Skill content and selects the
enabled set per Bot. Preserve each Bot's Skill material boundary; a source can
be reused without sharing writable activated content. Protect enabled materials
against Agent edits and apply explicit content versions at the same safe idle
boundary as configuration changes. Agents may produce proposed Skill files in
working materials, but those do not automatically activate or replace enabled
Skills. The current delivery provides selection and inspection of local installed
Skills, without marketplace, dependency installation or recording-based teaching.
This separates deliberate resource changes from autonomous memory/file edits.

Saved settings apply to new sessions and to existing idle sessions before their
next execution through safe replacement of runtime material. Active sessions
finish their current execution and already admitted follow-ups using the prior
configuration, then adopt the saved configuration at the idle boundary. The UI
distinguishes saved and effective configuration versions. This avoids aborting
work when settings change while accepting temporary differences between sessions;
past conversation history is retained. Stop/disable behavior follows
[ADR 0017](0017-work-cancellation-task-pause-and-bot-disablement.md), while
collaboration revocation follows [ADR 0013](0013-tracked-asynchronous-bot-delegation.md).

Saving a runtime/Skill version establishes a finite cutover after current
execution and follow-ups already accepted at save time. Later inputs wait behind
that boundary, so sustained traffic cannot defer configuration application
indefinitely. Continue existing history after runtime replacement. Work resuming
after a durable wait uses the then-effective Bot configuration and records its
execution-stage version, rather than pinning an entire multi-stage run to an old
version. A model/history incompatibility fails visibly for owner handling instead
of silently resetting the conversation. Host permission revocation takes effect
independently of this runner-idle boundary.
