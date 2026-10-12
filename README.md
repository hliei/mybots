# mybots

A TypeScript and Node.js project for an interactive CLI and a message-platform
bot, with a shared agent core.

The CLI supports non-streaming, multi-turn conversations, local tool execution,
Skill loading, and optional web search and rendered page reading with DeepSeek
through a shared Agent core. Each launch creates
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
Type `/help` to list the available commands.

Workspace settings preserve `llm`, `default_agent`, `agents_path`, `skills_path`,
and `history_path`. Relative paths resolve against the Workspace. Optional
`websearch` enables Brave Search; `webread` enables Chromium page reading.
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
Automatic context compaction and manual `/compact` are available.

### Slash commands

The CLI recognizes `/help` (alias `/?`), `/session`, `/skills`, and `/context` as
inspection commands; `/compact` requests manual compaction. Command names are case-insensitive. Successful inspection commands
neither call the model nor append conversation-history messages. Any other slash
input, including a lone `/`, is sent to the model as ordinary chat.

| Command | Behavior |
| --- | --- |
| `/help`, `/?` | List the available commands and descriptions. |
| `/session` | Show the current session ID, Agent name and ID, creation time, and in-memory active-message count without creating or switching sessions. |
| `/skills` | List each discovered Skill ID and description, or `No skills configured.` when none are valid. |
| `/skills <id>` | Show one Skill's name, description, and instruction body, or ``✗ Skill `<id>` not found.`` for an unknown ID. |
| `/context` | Show active-message count (excluding the system prompt), estimated tokens, model context window, output reserve, and effective compaction threshold. |
| `/compact` | Summarize older active context and retain recent complete turns. Report success, insufficient content or budget, failure, cancellation, or an unusable summary. |

Inspecting a Skill only reads it to render text. It does not register the `skill`
tool, load the instructions into active context, or change `allow_skills`, and it
works whether or not the Agent enables Skills.

### Context compaction

`/compact` replaces older active context with a user summary followed by the
original recent messages. It uses a separate model request without tools and
adds no artificial assistant acknowledgement. The summary request includes
visible text, tool names and arguments, and at most 2,000 characters per tool
result, with a truncation marker. It excludes original reasoning; retained
assistant messages keep their complete `reasoning_content`.

Budget reporting prefers valid provider input-plus-output usage and estimates
messages appended since that response. Without valid usage, it estimates UTF-8
JSON bytes divided by three plus framing overhead, including system instructions,
reasoning, tool arguments, and tool definitions. These are estimates, not exact
tokenizer counts. The output reserve is the larger of 16,384 and `max_tokens`;
the effective threshold is the context window minus that reserve, floored at zero.

The provider's published 1M context window is used for `deepseek-flash`,
`deepseek-v4-pro`, and the Flash aliases `deepseek-v4-flash` and
`deepseek-v4-flash-vision-exp` (verified October 12, 2026). Other model names use a
128,000-token fallback. Set the optional positive integer `llm.context_window`
in Workspace or Agent settings for another model or endpoint's actual limit.
This setting controls budgeting and is not sent to the API.

The retained tail targets at least 20,000 estimated tokens. Manual compaction
extends backward to a user-turn boundary, retaining whole turns even when one
turn exceeds the tail target. Automatic compaction first tries the same boundary;
when a long turn prevents progress or its retained tail exceeds the input budget,
it can cut before an assistant message while preserving every retained tool call
and all its results. The removed prefix is summarized with instructions to carry
forward the continuing user objective and completed work.
Too little older content causes no summary request. The separate summary request
must fit the model window with the output reserve. Blank, truncated, tool-calling,
or non-reducing summaries are rejected. Failure and cancellation keep active
context intact. Chat and compaction cannot mutate the same Agent concurrently.

A successful compaction clears usage from the old context; the next chat request
uses the rebuilt context. Original JSONL history is unchanged, and neither the
command nor generated summary is recorded as conversation history. Compaction
state remains in memory for this launch. Repeated manual and automatic compaction
update the previous summary with only newly removed content, without rereading
raw history.

Before each chat request, including every tool-round continuation, the Agent
checks the estimated input against the effective threshold. Requests at or below
the threshold proceed normally; requests above it require compaction. The rebuilt
request must fit the budget before the summary is committed. If summarization
fails, is cancelled, has no usable removable prefix, or leaves an oversized tail,
the chat stops with an error and preserves committed context and usage. Raw
history still records the attempted user input and any completed tool work.
The CLI reports the error and accepts further input; Ctrl+C exits. Oversized
individual messages or tool exchanges may require smaller inputs or outputs.
There is no automatic retry after a provider context-overflow error.

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

### Web search

Add the following to your Workspace's `config.user.yaml` to enable `websearch`:

```yaml
websearch:
  provider: brave
  api_key: YOUR_BRAVE_SEARCH_API_KEY
```

`provider` defaults to `brave`; other providers are rejected. Omit `websearch`
or set it to `null` to leave the tool disabled. Credentials come only from the
Workspace configuration, with no environment-variable fallback. Keep keys in
your ignored local Workspace.

The tool accepts a string `query`. It sends a GET request to
`https://api.search.brave.com/res/v1/web/search` with `q`, `count=10`,
`Accept: application/json`, and `X-Subscription-Token`. Brave's `description`
becomes the normalized result's `snippet`; missing title, URL, or description
defaults to an empty string. Results retain their order and use this format:

```text
1. **Result title**
   https://example.com/page
   Result snippet
```

Results are separated by blank lines. Empty results return `No results found.`
Request failures return `Error executing tool: ...` to the model for continuation.
HTTP errors include the status code; transport error wording follows Node.js
rather than Python httpx. There are no automatic retries or redirects.
Requests have a 30-second overall deadline, including response-body consumption;
this differs from httpx's timeout per network operation. Ctrl+C cancels an
in-flight search through the Agent's cancellation signal.

An optional `websearch.api_base` is an extension to the reference configuration.
It overrides the complete HTTP(S) search endpoint, allowing controlled local
services in offline Agent and CLI tests. Ordinary tests explicitly select local
endpoints and fixture credentials, even when real credentials exist in the
environment. No live Brave acceptance has been performed by these tests.

### Web page reading

Install Playwright's matching Chromium browser before using `webread` or running
the full ordinary test suite and `verify`:

```sh
npm ci --ignore-scripts
npx playwright install chromium
```

On Linux, install Chromium's system dependencies too:

```sh
npx playwright install --with-deps chromium
```

Browser installation downloads binaries; subsequent tests use only local pages
and controlled HTTP services. Repeat installation after updating Playwright.
No Python runtime is required. The browser lives in Playwright's cache rather
than the repository. If the browser is missing, the read returns an error with
Playwright's installation instructions; ordinary browser tests fail rather than
being skipped. See [Playwright browser installation](https://playwright.dev/docs/browsers).

Enable the tool in `config.user.yaml`:

```yaml
webread:
  provider: crawl4ai
```

The legacy provider name `crawl4ai` preserves the reference configuration;
Playwright and Turndown implement it in Node.js. `webread: {}` uses the same
default. Omit the setting or use `null` to disable the tool. No browser starts
until the model requests `webread` with a string `url`.

Each read launches a fresh headless Chromium instance and closes it before
returning, including after failures or cancellation. It accepts HTTP(S) URLs,
follows redirects, executes page JavaScript, and waits for 500 milliseconds of
network inactivity before taking a snapshot. A 30-second deadline bounds the
browser operation, including launch and navigation. Ctrl+C closes an active
browser; cancellation during launch is handled as soon as launch settles.
Pages with continuously active requests can time out. Content added after the
snapshot, including later timers or interactions, is not guaranteed to appear.

The normalized result retains the original requested `url`, page `title`,
Markdown `content`, and a null `error` on success. Failure returns the original
URL, empty title/content, and an error string. The tool supplies success as
`**<title>**` followed by a blank line and Markdown, or failure as
`Error reading <original URL>: <error>`; both return to the model for continuation.
HTTP status codes of 400 or greater are errors, and transport errors use
Playwright's wording. A redirect does not replace the original URL in an error.

Extraction differs from Crawl4AI: it converts the rendered document body with
Turndown, preserving navigation and other body content rather than applying
Crawl4AI's content-cleaning heuristics. It removes scripts, styles, templates,
noscript content, hidden attributes, and elements with computed `display: none`
or `visibility: hidden`. Links and image sources resolve against the rendered
document's base URL. Markdown uses ATX headings, fenced code blocks, and dash
lists; escaping, whitespace, tables, and other formatting can differ from
Crawl4AI. Iframe documents and shadow DOM are not traversed. Service workers
are blocked, and each read starts with a fresh browser session without existing
login cookies.

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
Skills load only when the model requests them. `/skills` and `/skills <id>`
inspect discovered Skills from the CLI without loading them into context; see
[Slash commands](#slash-commands).

### Conversation history

Each CLI launch creates a new Agent session and records it under `history_path`
(the Workspace default is `.history`):

- `index.jsonl` holds one record per session with `id`, `agent_id`, `title`,
  `message_count`, `created_at`, and `updated_at`. The first user message supplies
  the title, truncated to 50 Unicode code points plus `...`. Sessions list most recently
  updated first.
- `sessions/<session_id>.jsonl` appends one record per message with `timestamp`,
  `role`, `content`, `tool_calls`, and `tool_call_id`, plus `reasoning_content` on
  assistant messages that have it.

User input is saved before requesting a model response, including failed or
cancelled turns. Assistant responses are saved before tool execution, and tool
results are saved as they arrive. Active context retains completed tool groups;
failed inputs remain in saved history even when excluded from active context.
The reference Python implementation ignores reasoning content and drops it when
rewriting records; Mybots preserves the original value and never fabricates
reasoning a record lacks. Records written by the reference remain readable.
There is no history-listing or resume command.

### API sources

- [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)
- [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/)
- [DeepSeek model limits](https://api-docs.deepseek.com/quick_start/pricing/)
- [Compaction design and pi sources](docs/adr/0002-token-budgeted-context-compaction.md)
- [Brave Web Search API](https://api-dashboard.search.brave.com/app/documentation/web-search)
- [Playwright browser API](https://playwright.dev/docs/api/class-browser)
- [Turndown HTML-to-Markdown conversion](https://github.com/mixmark-io/turndown)

Compaction deviations from the fixed pi sources: manual compaction retains whole
user turns, while automatic compaction can summarize a long turn's prefix;
token estimates use UTF-8 bytes with a framing margin rather than characters;
and summary state stays in memory instead of persisted checkpoints. Manual and
automatic compaction both support incremental summary updates.

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

Ordinary tests use Vitest in Node.js and do not require credentials. Install
matching Chromium as described in [Web page reading](#web-page-reading)
before browser tests or the full suite. Tests serve all pages and subresources
locally; they do not use real model or search credentials. Run a
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
│   ├── commands.ts        # Slash-command registry and handlers
│   ├── compaction.ts      # Token estimates, retention boundary, and summary input
│   ├── history.ts         # JSONL conversation history and session index
│   ├── messages.ts        # Shared messages and tool protocol types
│   └── skills.ts          # Skill discovery and loading
├── config/workspace.ts    # Workspace and Agent settings
├── providers/deepseek.ts  # DeepSeek request/response conversion
├── providers/brave.ts     # Brave HTTP requests and search-result normalization
├── providers/webread.ts   # Chromium lifecycle, rendered snapshots, and Markdown
├── tools/
│   ├── builtin.ts         # Local tool definitions and execution
│   ├── shell.ts           # Shell execution and cleanup
│   ├── skill.ts           # Dynamic skill tool
│   ├── websearch.ts       # Configured search tool and reference result formatting
│   ├── webread.ts         # Page-read tool and reference success/error formatting
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
