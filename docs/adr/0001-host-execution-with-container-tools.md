# Host execution with container tools

Status: accepted; implementation planned.

Run Pi Durable on the host and route shell/file tools through SandboxProvider
to one persistent Docker Team Computer per Space. This separates conversation
lifetime from the tool environment and lets Bots share working files without
sharing identity or history. Bot directories organize that shared workspace;
they are not isolation boundaries.

Accept concurrent file access without a global Computer lock. Preserve workspace
data across restart and container replacement; provider export/import avoids
per-turn copying. The transition may discard identified old runtime data instead
of maintaining compatibility, but normal shutdown preserves the new workspace.

See [Computer and resources](../computer-and-resources.md).
