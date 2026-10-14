# Data contract fixtures

These literal fixtures define Workspace configuration, Agent and Skill definitions,
and JSONL conversation-history formats independently of runtime serialization and
response builders. Dates, IDs, text and fake keys are deterministic examples.
They contain no service credentials.

| Contract | Fixture | Coverage |
| --- | --- | --- |
| Workspace configuration | `workspace/config.user.yaml` | Model settings and explicit directory resolution |
| Agent definition | `workspace/agents/helper/AGENT.md` | Frontmatter, instructions and model overrides |
| Skill definition | `workspace/skills/brief/SKILL.md` | Directory ID, metadata and instruction body |
| Conversation history | `sessions/*.jsonl`, `index.jsonl` | Optional fields, paired tool exchanges and session metadata |

`workspace-contracts.test.ts` opens the literal Workspace through the public
Agent interface, checks model fields and overrides, and loads the Skill through
the tool loop with a controlled endpoint. `history.test.ts` checks imports,
optional fields, IDs, literal serialization, legacy messages, unknown extensions,
and new-reader recovery. Unknown fixture fields exercise forward compatibility.
Explicit directory settings test configurable Agent and Skill locations.
See the [data contracts and compatibility guarantees](../../../docs/phase1-acceptance.md)
for the supported formats and their limits.

`events.json` defines independent inbound/outbound envelopes, including a
Telegram source, Unix-second timestamps and reply identity. `runtime.test.ts`
submits its literal inbound envelope through a persisted source binding and
checks the observed event, expected outbound fields and recovered destination.
See [runtime acceptance](../../../docs/runtime-acceptance.md) for fault/restart
coverage and separate actual-service checks.
