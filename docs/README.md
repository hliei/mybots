# Documentation

The architecture and operation guides describe the implemented local application;
ADRs identify accepted changes whose implementation is still pending. Controlled-model,
Docker and browser checks cover its behavior; actual-provider acceptance remains
a separate opt-in gate. Retired runtime designs remain available in Git history.

## Architecture

| Document | Purpose |
| --- | --- |
| [Architecture](architecture.md) | Release scope, process layout and data ownership |
| [Conversation execution](conversation-execution.md) | Context, history, input, Stop and recovery |
| [Computer and resources](computer-and-resources.md) | Docker workspace, Bot configuration, Skills and memory |

See [persistent local chat](durable-chat.md) for the implemented entry, host
configuration, context defaults and current validation scope.

## Decisions

The ADR sequence restarts at `0001`. Decisions 0001-0004 are accepted and
implemented; 0005 is accepted with implementation pending.

| ADR | Decision |
| --- | --- |
| [0001](adr/0001-host-execution-with-container-tools.md) | Separate host execution from the shared tool environment |
| [0002](adr/0002-durable-conversations-own-chat-execution.md) | Let Durable own conversation execution and history |
| [0003](adr/0003-api-worker-and-local-storage-boundaries.md) | Separate API and worker with local SQLite persistence |
| [0004](adr/0004-shared-skills-and-scoped-markdown-memory.md) | Store shared Skills and scoped memory as product data |
| [0005](adr/0005-command-ownership-and-service-lifetime.md) | Scope command cleanup to its turn and retain intentionally launched services |

## Repository conventions

[Glossary](../GLOSSARY.md) · [Development](agents/development.md) ·
[Testing](agents/testing.md) · [Git workflow](agents/git-workflow.md) ·
[Domain docs](agents/domain.md) · [Issue tracker](agents/issue-tracker.md) ·
[Triage labels](agents/triage-labels.md)
