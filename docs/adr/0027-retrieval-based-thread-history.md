# Retrieval-based Thread history

Status: accepted
Implementation: planned

New conversational Runs receive bounded recent Thread text, the current request,
and explicitly selected materials. Earlier messages remain durable and are
retrieved on demand through local lexical history search and paginated reading
of original messages, surrounding conversation, and linked results. Current
input and admitted steering remain protected when selecting context within the
model budget. Historical replies are reference material rather than restored
tool calls or fresh authority to act.

History search and reading derive Bot/Thread scope from authenticated execution,
not tool-supplied identity. Search excludes the current source message and later
messages, while authorized reading around a selected historical anchor can
inspect later corrections and outcomes. Responses preserve source identities,
coverage, and continuation cursors with explicit truncation. Progress and raw
tool traces are not the searchable conversation body. Existing scoped result
and file controls continue to govern any linked material.

The default cross-Run history policy does not require automatic model-generated
Thread summaries, an embedding provider, a vector service, or independent
background memory maintenance. Long-term file memory remains a separate Bot
input under [ADR 0015](0015-agent-maintained-file-memory.md). Routine execution
continues to exclude implicit direct-chat history under
[ADR 0025](0025-tasks-routines-and-independent-occurrence-context.md).

This accepts bounded immediate context and explicit lookup latency in exchange
for preserving original evidence without recurring summary generation. It
refines application-owned selection in
[ADR 0024](0024-single-direct-thread-and-application-owned-context.md).
Same-Run continuation evidence remains governed by
[ADR 0026](0026-durable-runs-and-serial-bot-execution.md); the Pi integration and
its within-Run compaction follow the accepted coding-agent SDK split in
[ADR 0024](0024-single-direct-thread-and-application-owned-context.md).
That record also scopes default lookup to the Run's captured chat background
boundary while allowing older material through deliberate owner selection.
