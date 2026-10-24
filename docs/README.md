# Documentation

These documents describe the accepted target architecture. Implementation and
acceptance are pending. Previous runtime designs and acceptance records have
been retired from this documentation set; tracked history remains in Git.

## Architecture

| Document | Purpose |
| --- | --- |
| [Architecture](architecture.md) | Release scope, process layout and data ownership |
| [Conversation execution](conversation-execution.md) | Context, history, input, Stop and recovery |
| [Computer and resources](computer-and-resources.md) | Docker workspace, Bot configuration, Skills and memory |

## Decisions

The ADR sequence restarts at `0001`. All four decisions are accepted and planned.

| ADR | Decision |
| --- | --- |
| [0001](adr/0001-host-execution-with-container-tools.md) | Separate host execution from the shared tool environment |
| [0002](adr/0002-durable-conversations-own-chat-execution.md) | Let Durable own conversation execution and history |
| [0003](adr/0003-api-worker-and-local-storage-boundaries.md) | Separate API and worker with local SQLite persistence |
| [0004](adr/0004-shared-skills-and-scoped-markdown-memory.md) | Store shared Skills and scoped memory as product data |

## Repository conventions

[Glossary](../GLOSSARY.md) · [Development](agents/development.md) ·
[Testing](agents/testing.md) · [Git workflow](agents/git-workflow.md) ·
[Domain docs](agents/domain.md) · [Issue tracker](agents/issue-tracker.md) ·
[Triage labels](agents/triage-labels.md)
