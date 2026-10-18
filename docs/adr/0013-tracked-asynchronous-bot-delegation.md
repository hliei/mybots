# Tracked asynchronous Bot delegation

Status: accepted
Implementation: planned

Bot collaboration includes durable, tracked asynchronous delegation. A delegation
has its own identity, source and target Bots, related sessions, observable work
state, outcome, and associated results. Asynchronous messages carry the handoff
and response; message delivery alone is not work completion.

This lets the owner inspect whether requested work is still pending, completed,
or failed without inferring its outcome from conversation text. It adds work
coordination beyond reply routing, but does not require a general workflow-graph
engine. Each delegation creates a dedicated session belonging to its target Bot,
linked to the source session and retained with the delegation after completion.
Unrelated delegations have separate conversation contexts while sharing the
target Bot's workspace and deliberately persisted memory. This accepts more
sessions to manage in exchange for independent work context and progress.

When the originating work requires a delegation's result, the Host durably records
that dependency and presents the work as waiting rather than completed. The
current model execution ends; a correlated target result or failure makes later
processing in the source session eligible to continue the originating work.
Waiting need not retain a blocking tool invocation or container, and other
sessions can progress. This is a Host-owned work continuation rather than
restoration of a crashed SDK call stack.

The owner controls directed source-to-target collaboration policy with deny,
ask-each-time, and allow modes; the default is deny. Bots cannot grant themselves
access or edit that policy. Returning a result to its existing authorized
delegation does not require reverse-direction authorization; a new reverse work
request does. Results must still belong to valid originating work.

Each work chain supports at most two delegation edges, allowing an originating
Bot to delegate to a specialist that delegates to a reviewer. Reject new work
requests to an ancestor Bot in that chain and requests exceeding the depth bound;
return an explicit error to the source. Ordinary correlated results/replies do
not add a delegation edge. Directed policy applies independently at every edge.
This bounds delegation loops while retaining a specialist review handoff.

Changing a directed policy to deny immediately blocks new work requests and
not-yet-executed approvals, and requests cancellation of unfinished delegations
admitted through that edge together with their owned descendants. The source
receives a correlated revoked/cancelled outcome. Preserve already delivered
material and completed effects, and leave unrelated work/directions running.
Changing allow to ask-each-time applies to new requests without retroactive
approval of completed actions. Revocation does not wait for runner configuration
cutover, but cancellation still requires confirmed termination and honest handling
of uncertain outcomes.

An originating work chain admits at most eight total delegations including
descendants by default, beyond the separate simultaneous-execution limits.
Denied operations and failed/cancelled children return a correlated outcome for
the source to handle through a permitted alternative or an explicit inability to
continue. Child failure alone is not automatic success or failure of the source
work. Do not automatically repeat identical denied operations/inputs to bypass
an owner decision. Expired requests retain the owner-attention behavior of
[ADR 0014](0014-controlled-host-action-approvals.md).

Explicit source-work cancellation fences late child results from restarting that
work while preserving them for inspection. Source-session input rules follow
[ADR 0010](0010-independent-bots-and-owned-sessions.md). Work cancellation follows
[ADR 0017](0017-work-cancellation-task-pause-and-bot-disablement.md).
Parent completion requires settled owned work/requests under
[ADR 0023](0023-work-item-lifetimes-and-owned-dependencies.md).
A durable delegation record does not strengthen the execution guarantees in
[ADR 0008](0008-mailbox-completion-and-recovery.md).
