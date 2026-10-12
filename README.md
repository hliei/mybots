# mybots

A TypeScript and Node.js project for an interactive CLI and a message-platform
bot, with a shared agent core.

The CLI supports non-streaming, multi-turn conversations, local tool execution,
and Skill loading with DeepSeek through a shared Agent core. Each launch creates
a fresh session in memory. The bot server currently prints a setup message or
help and exits.

## Setup

Use Node.js 24.21.0, pinned in `.nvmrc`, and npm. With nvm installed:

```sh
nvm install
nvm use
npm ci --ignore-scripts
```

If Node.js 24 is not installed, npm can run a command with a temporary runtime:

```sh
npm exec --yes --package=node@24.21.0 -- npm ci --ignore-scripts
npm exec --yes --package=node@24.21.0 -- npm run verify
```

Direct dependencies use exact versions. Commit `package-lock.json`
with dependency changes. To install or update dependencies locally, use
`npm install --ignore-scripts` and review the resulting changes.

## Development

```sh
npm run dev:cli -- --workspace ./workspace
npm run dev:bot
```

These commands run TypeScript source directly using Node.js native type
stripping. Restart the command manually after changing code. Pass `-- --help`
to print help without loading configuration or contacting a service.

## CLI conversation

Copy the credential-free example into the ignored local Workspace:

```sh
cp -R examples/workspace ./workspace
```

Set `llm.api_key` in `workspace/config.user.yaml` to your DeepSeek API key, then:

```sh
npm run dev:cli -- --workspace ./workspace chat --agent helper
# Short options; chat is optional:
npm run dev:cli -- -w ./workspace -a helper
```

Without `--workspace` / `-w`, the reference default is `../default_workspace`,
relative to the process working directory. Without `--agent` / `-a`, the CLI
uses `default_agent` from `config.user.yaml`. Enter one message per line. Replies
print after the complete response arrives. Blank lines are ignored; `quit`,
`exit`, `q`, EOF, and Ctrl+C end the session. Ctrl+C cancels an in-flight request.

Workspace settings preserve `llm`, `default_agent`, `agents_path`, `skills_path`,
and `history_path`. Relative paths resolve against the Workspace. Optional
`websearch` and `webread` settings are preserved for later capabilities.
Agent definitions default to `.agents/bots/<id>/AGENT.md` (configured by `agents_path`); frontmatter preserves
`name`, `description`, `llm`, and `allow_skills`. The Markdown body supplies the
system instructions. Agent `llm` fields override matching Workspace fields.

The supported provider is `deepseek`. Model settings use `provider`, `model`,
`api_key`, `api_base`, `temperature`, `max_tokens`, and the boolean `thinking`.
The model defaults to `deepseek-flash`, the endpoint to `https://api.deepseek.com`,
temperature to `0.7`, max tokens to `2048`, and thinking to `true`. The API key is
required. Set `llm.thinking: false` in Workspace or Agent settings to explicitly
disable thinking. DeepSeek ignores temperature while thinking is enabled.
Assistant messages retain full `reasoning_content` in session context; the CLI
prints the final text only.

Requests time out after 60 seconds and are not automatically retried. Provider
failures print an error and allow another message. Inputs that fail before a
model response do not enter session context. Completed tool-call/result groups
are retained if a later model request fails or is cancelled; local changes
already made by tools remain in place. The shared Agent interface rejects
overlapping `chat()` calls in the same session; the CLI submits turns sequentially.
Saved history, slash commands, compaction, and web tools are later deliveries.

### Local tools

The Agent can use these tools while answering a request:

| Tool | Arguments | Behavior |
| --- | --- | --- |
| `read` | `path` | Read the complete text file. |
| `write` | `path`, `content` | Create or overwrite a file; parent directories must exist. |
| `edit` | `path`, `old_text`, `new_text` | Replace every literal match; missing text reports an error without writing. |
| `bash` | `command` | Execute through the operating system's default shell and return stdout/stderr. |

Relative tool paths and shell commands use the process working directory, which
may differ from the selected Workspace. Multiple calls in one response execute
in order; each result retains the corresponding call ID. Tool errors return to
the model so it can continue. Complete reasoning from earlier assistant messages
is carried forward in tool requests. The CLI displays the final model reply.

For example, start the CLI from the directory containing your files and ask:
"Read notes.txt, replace every TODO with DONE, and show the updated content."
File writes and commands run with the CLI process's permissions.

Shell output matches the reference: stdout and stderr are separated by an extra
newline when both exist; a nonzero exit returns its output, and no output returns
`Command completed with no output`. Commands have a 60-second timeout. Ctrl+C
cancels a running command and waits for termination; on POSIX systems the shell
and descendants in its process group receive SIGTERM, then SIGKILL after a
one-second grace period if needed. POSIX process cleanup is tested; Windows
process-tree termination has not been verified.

### Skills

A Skill is a named set of instructions in a directory under `skills_path`
(`.agents/skills` by default) that contains a `SKILL.md` file.

Both Agent definitions and Skills live under the Workspace's `.agents/` directory.
Set `agents_path: bots` and `skills_path: skills` explicitly to use the old layout.

```text
.agents/
├── bots/
│   └── helper/
│       └── AGENT.md
└── skills/
    └── concise-summary/
        └── SKILL.md
```

`SKILL.md` starts with YAML frontmatter containing `name` and `description`,
followed by the instructions:

```markdown
---
name: Concise summary
description: Summarize long text as a short bullet list
---

When the user asks for a summary, read the requested text in full and return at
most five bullets, most important first.
```

Set `allow_skills: true` in the Agent frontmatter to let that Agent use Skills.
When it is enabled and at least one directory has a valid `SKILL.md`, the Agent
adds a `skill` tool. The tool description lists each Skill's frontmatter name and
description, and its `skill_name` argument accepts a Skill directory name (the
Skill ID). Loading a Skill returns its instruction body without the frontmatter
and supplies it to the model as the tool result, so the model can follow the
instructions for the current task.

Directories without `SKILL.md`, and files missing a string `name` or
`description`, are skipped without an error. Extra frontmatter fields are
ignored and the instruction body may be empty. When the Agent sets
`allow_skills: false`, the skills location is missing, or no valid Skill exists,
the Agent registers no `skill` tool. Requesting an ID that is not among the
discovered Skills returns
`Error: Skill '<id>' not found. It may have been removed or is unavailable.`
Skills load only when the model requests them; interactive listing and
inspection from the CLI are a later delivery.

### API sources

- [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)
- [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/)

## Checks and tests

```sh
npm run check
npm test
npm run test:watch
npm run verify
```

`check` checks formatting, lint, and types without modifying files. Type checking
includes application source, tests, and the Vitest configuration. Run
`npm run format` to apply formatting fixes.

Ordinary tests use Vitest in Node.js and do not require credentials. Run a
specific file with `npm test -- tests/startup.test.ts`. Live-service tests belong
in `tests/live/` and are excluded from ordinary test discovery; no live-test
command is configured yet.

`verify` runs checks, ordinary tests, compilation, and offline startup checks
of both compiled entry points. It does not start a long-running service or
contact a model or messaging platform.

## Build and run

```sh
npm run build
npm run start:cli -- --workspace ./workspace
npm run start:bot
```

Builds contain application code under `dist/`; tests and tool configuration
are not emitted. Start commands use the existing build. For offline help:

```sh
npm run start:cli -- --help
npm run start:bot -- --help
```

## Source layout

Only executable entry points live directly under `src/`. Implementation files
are grouped by their current responsibilities:

```text
src/
├── cli.ts                 # CLI entry point
├── server.ts              # Bot entry point
├── cli/chat.ts            # Arguments and terminal interaction
├── core/
│   ├── agent.ts           # Session and tool-loop orchestration
│   ├── messages.ts        # Shared messages and tool protocol types
│   └── skills.ts          # Skill discovery and loading
├── config/workspace.ts    # Workspace and Agent settings
├── providers/deepseek.ts  # DeepSeek request/response conversion
├── tools/
│   ├── builtin.ts         # Local tool definitions and execution
│   ├── shell.ts           # Shell execution and cleanup
│   ├── skill.ts           # Dynamic skill tool
│   └── toolbox.ts         # Tool schemas, argument validation, and dispatch
└── bot/startup.ts          # Bot startup placeholder
```

The Agent supplies the available tool schemas to the provider. The provider
handles model requests without selecting which application tools are enabled.

## Project rules

- [Development](docs/agents/development.md)
- [Testing](docs/agents/testing.md)
- [Git workflow](docs/agents/git-workflow.md)
- [Agent instructions](AGENTS.md)
