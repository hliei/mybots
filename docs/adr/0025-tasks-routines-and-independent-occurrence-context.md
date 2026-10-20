# Tasks, Routines, and independent occurrence context

Status: accepted
Implementation: partial. One-shot and cron Routines create independent occurrence Tasks and Runs. Routine lifecycle controls remain planned.

A Task represents requested work, whether it originates in the Bot's direct
Thread, a scheduled occurrence, or a delegation. A Routine is the persistent
scheduling definition; each occurrence creates a new Task. Keeping the
definition separate from its occurrences gives each unit of work its own
identity and outcome without treating a continuing schedule as one endless Task.

Each scheduled occurrence starts with independently selected execution context.
It receives the Bot's identity and current deliberate memory, retains access to
the Bot's workspace, and may use explicitly selected previous results. It does
not automatically inherit the direct Thread history or the preceding occurrence's
active context. This accepts explicit selection of useful prior material in
exchange for avoiding unrelated conversation and execution history accumulation.

This supersedes the dedicated persistent conversation and automatic
cross-occurrence context continuity in
[ADR 0012](0012-dedicated-scheduled-task-sessions.md), within the application-owned
context boundary in
[ADR 0024](0024-single-direct-thread-and-application-owned-context.md).
Other scheduling contracts remain the baseline pending coordinated terminology
and execution-contract revision. Run and Attempt lifetimes follow
[ADR 0026](0026-durable-runs-and-serial-bot-execution.md).
