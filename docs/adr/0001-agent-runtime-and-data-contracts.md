# Agent runtime and data contracts

Status: accepted
Implementation: partial (conversation history, CLI inspection, compaction, and Brave web search delivered; web reading planned)

The application uses TypeScript and Node.js in one npm package, with a shared
Agent core called by the CLI. Terminal interaction and provider APIs remain at
the core's boundaries so execution can be tested with controlled services.
Explicit configuration and message formats support exchanging workspace data
and preserving the information needed to continue model requests.

## Configuration and providers

Workspace YAML contains `llm`, `default_agent`, `agents_path`, `skills_path`, and
`history_path`, with optional web-tool settings. The model settings are
`provider`, `model`, `api_key`, `api_base`, `temperature`, and `max_tokens`.
Agent definitions contain `name`, `description`, `llm` overrides, and
`allow_skills` in frontmatter, followed by their system instructions.

Agent definitions default to `.agents/bots/<id>/AGENT.md` and Skills default to
`.agents/skills/<id>/SKILL.md`, relative to the Workspace. Explicit `agents_path`
and `skills_path` override these defaults. This layout intentionally differs from
the reference's default `bots/` and `skills/` directories; the configuration fields
and definition formats remain compatible.

The initial model provider is DeepSeek through Chat Completions. The boolean
`llm.thinking` defaults to `true` and supports Agent-level overrides. Assistant
messages retain their original `reasoning_content`, which is sent back with
retained conversation messages during thinking-mode tool calls.

Web search uses Brave Search when the optional `websearch` configuration is present.
It contains `provider` (defaults to `brave`) and a required string `api_key`.
The optional `api_base` extension selects a complete HTTP(S) endpoint for local
controlled services; otherwise requests use Brave's web-search endpoint.
Requests ask for ten results, use a 30-second overall deadline, and support
Agent cancellation. Node.js fetch replaces httpx, so the deadline includes
response-body consumption rather than applying separately to network operations;
transport-error wording is Node.js-specific. HTTP errors and empty results are
returned through the tool loop for model continuation.

Web reading is planned to use Chromium controlled by Node.js
to obtain rendered content and convert it to Markdown. The web-tool data shapes
are:

| Result | Fields |
| --- | --- |
| Search result | `title`, `url`, `snippet` |
| Page read result | `url`, `title`, `content`, `error` |

Page-read results retain the requested URL. Successful reads contain Markdown
and a null error; failed reads contain empty title/content and an error message.

## Skills

Skills are lazy-loaded instruction sets. The configured `skills_path` contains
one directory per Skill, each with a `SKILL.md` whose `name` and `description`
frontmatter identify the Skill and whose body supplies its instructions. The
directory name is the Skill ID.

When an Agent allows Skills and at least one valid definition exists, its toolset
includes a `skill` tool. The tool description lists the discovered names and
descriptions, and the `skill_name` argument accepts a discovered ID. Loading a
Skill returns its instruction body without frontmatter as the tool result.
Definitions without both string fields are skipped; requesting an ID that is not
among the discovered Skills returns an error result instead of reading the file
system. The CLI lists and inspects discovered Skills through its inspection
commands without registering the tool or loading instructions into context;
this reads the Agent's `SkillLoader` directly, correcting the reference command's
attempt to read a non-existent session attribute.

## Conversation history

Each CLI launch creates a new Agent session. The configured history directory
contains a JSONL session index (`index.jsonl`) and a separate append-only
message log (`sessions/<session_id>.jsonl`) for each session. Index metadata is
updated as messages are recorded.

- Index records contain `id`, `agent_id`, `title`, `message_count`, `created_at`,
  and `updated_at`.
- Message records contain `timestamp`, `role`, `content`, `tool_calls`, and
  `tool_call_id`, with optional `reasoning_content`.
- Tool calls contain `id`, `type`, and `function`; function data contains `name`
  and JSON-string `arguments`. Results retain the corresponding call ID.

Records without reasoning content remain readable. The Python reference ignores
reasoning content and drops it when rewriting records, so common-field exchange
is compatible while Mybots preserves reasoning losslessly. Missing reasoning is
never fabricated; histories lacking the original reasoning cannot guarantee
thinking-mode tool continuation. Unknown extension fields are retained when the
index is rewritten, and message records are append-only.

Full conversation history remains saved while [context compaction](0002-token-budgeted-context-compaction.md)
rebuilds the active context used for subsequent model requests.

## Sources

- [Workspace and Agent configuration](https://github.com/czl9707/build-your-own-openclaw/blob/37ae5dd255a0451609e67ad6d6a51fa5de80523c/06-web-tools/src/mybot/utils/config.py).
- [Session and message schemas](https://github.com/czl9707/build-your-own-openclaw/blob/37ae5dd255a0451609e67ad6d6a51fa5de80523c/06-web-tools/src/mybot/core/history.py).
- [DeepSeek thinking-mode request requirements](https://api-docs.deepseek.com/guides/thinking_mode/).
