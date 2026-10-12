# mybots

A TypeScript and Node.js project for an interactive CLI and a message-platform
bot, with a shared agent core.

The CLI supports non-streaming, multi-turn conversations with DeepSeek through
a shared Agent core. Each launch creates a fresh session in memory. The bot
server currently prints a setup message or help and exits.

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
Agent definitions default to `bots/<id>/AGENT.md` (configured by `agents_path`); frontmatter preserves
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
failures print an error and allow another message; failed turns do not enter
session context. Only successful turns carry forward. The shared Agent interface
rejects overlapping `chat()` calls in the same session; the CLI submits turns
sequentially. Tool execution, Skills,
saved history, slash commands, compaction, and web tools are later deliveries.

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

## Project rules

- [Development](docs/agents/development.md)
- [Testing](docs/agents/testing.md)
- [Git workflow](docs/agents/git-workflow.md)
- [Agent instructions](AGENTS.md)
