# Shared Agent workspace with separate conversations

Status: accepted
Implementation: persistent host/CLI affinity, owner-only Telegram
private-chat affinity, local WebSocket conversations and shared workspace delivered

The default single personal Agent across entry points is superseded by planned
[independent Bots with owned sessions](0010-independent-bots-and-owned-sessions.md).
The same-Agent workspace sharing and session execution rules below remain applicable.

Personal entry points will use the same Agent identity and Agent workspace by
default, with separate persistent Agent sessions per entry or chat. Returning
to an entry continues its session rather than creating a new conversation on
each launch. This shares instructions, Skills, and deliberately persisted
working materials while keeping unrelated conversations out of each other's
active context. Separate sessions are not a privacy boundary for shared
workspace contents; sharing a single conversation across entries remains an
explicit routing choice rather than the default.

This changes the fresh-session-per-CLI-launch behavior recorded in ADRs
[0001](0001-agent-runtime-and-data-contracts.md) and
[0005](0005-durable-outbound-delivery.md). Each session executes sequentially;
different sessions may run concurrently against shared writable workspace
contents. No workspace-wide execution lock is added. This retains independent
session responsiveness while accepting possible conflicting file edits.
Automated memory maintenance is outside the first delivery; sharing a workspace
does not imply copying every message into shared memory.
