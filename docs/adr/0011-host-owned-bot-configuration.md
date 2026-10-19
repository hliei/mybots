# Host-owned durable Bot configuration

Status: accepted
Implementation: saved and effective Bot configuration versions and the finite
Attempt cutoff and protected local Skill revisions are delivered

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
inherited by Attempts of chat, Routine and delegation Tasks. Per-Task/Run
configuration overrides are outside the current delivery; work-specific
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

Saved settings apply before new Attempts through safe replacement of runtime
material. An active Attempt and its steering admitted before configuration save
finish under their captured version, then the Bot applies the saved version at
the finite execution boundary. The UI distinguishes saved and effective versions
and records each Attempt's version. This avoids aborting work when settings
change while retaining the Run's SDK history. Stop/disable behavior follows
[ADR 0017](0017-work-cancellation-task-pause-and-bot-disablement.md), while
collaboration revocation follows [ADR 0013](0013-tracked-asynchronous-bot-delegation.md).

Saving a runtime/Skill version establishes a finite steering-admission cutover.
Later inputs remain durable behind that boundary instead of indefinitely
extending old-version execution. A subsequent Attempt in the same Run, including
continuation after a wait, uses the then-effective Bot version. Refresh current
memory and resources without rewriting earlier evidence or replaying completed
tools. A model/history incompatibility fails visibly for owner handling instead
of silently resetting the Run. Host permission revocation takes effect
independently of this execution boundary. This adapts the accepted finite-cutover
contract to [ADR 0024](0024-single-direct-thread-and-application-owned-context.md)
and [ADR 0026](0026-durable-runs-and-serial-bot-execution.md).
