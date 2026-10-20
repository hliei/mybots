# Tracked asynchronous Bot delegation

Status: accepted
Implementation: partial. Deny/ask-each-time/allow delegation, exact local approvals, two-edge nesting, originating-Run chain limits, parent waits, same-Run continuation, and descendant cancellation are implemented. Immediate directed revocation cancels admitted unfinished child work and owned descendants with confirmed-stop and uncertainty handling.

Bot collaboration is durable parent-owned delegation. Each request creates a
target-Bot child Task and Run with selected inputs, source/target/parent and
originating-Run links, state, outcome and results. Its SDK context is independent
while it shares only its Bot's workspace and deliberate Memory. Explicit
cross-Bot copies do not expose the source workspace or conversation.

The Host records necessary dependencies and ends the parent Attempt after
complete tool results, releasing capacity and active budget. A correlated child
outcome makes the same parent Run eligible for another Attempt using its ledger
and effective settings; it does not create a new parent Task or restore a tool
stack. Parent completion requires settled owned work and necessary decisions.
This preserves useful asynchronous collaboration without a general workflow graph.

These lifetimes follow
[ADR 0026](0026-durable-runs-and-serial-bot-execution.md).
Owner additions can target actual child Tasks under
[ADR 0024](0024-single-direct-thread-and-application-owned-context.md); they do
not alter the Routine definition, target other work or settle parent dependencies.

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

An originating Run admits at most eight total delegations including
descendants by default, beyond the separate simultaneous-execution limits.
Denied operations and failed/cancelled children return a correlated outcome for
the source to handle through a permitted alternative or an explicit inability to
continue. Child failure alone is not automatic success or failure of the source
work. Do not automatically repeat identical denied operations/inputs to bypass
an owner decision. Expired requests retain the owner-attention behavior of
[ADR 0014](0014-controlled-host-action-approvals.md).

Explicit source-work cancellation fences late child results from restarting that
work while preserving them for inspection. Thread and explicit Task input rules follow
[ADR 0024](0024-single-direct-thread-and-application-owned-context.md). Work cancellation follows
[ADR 0017](0017-work-cancellation-task-pause-and-bot-disablement.md).
Parent completion requires settled owned work/requests under
[ADR 0023](0023-work-item-lifetimes-and-owned-dependencies.md).
A durable delegation record does not strengthen the execution guarantees in
[ADR 0008](0008-mailbox-completion-and-recovery.md).
