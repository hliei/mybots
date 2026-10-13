# Workspace configuration

`config.user.yaml` supplies operator settings. `config.runtime.yaml` overlays it
and stores runtime updates such as source-to-session bindings. Mappings merge
recursively, while other values replace earlier values, including arrays and
nulls. Missing or empty files contribute an empty mapping. A complete candidate
must validate before replacing the last valid configuration. Null is valid only
for explicitly optional settings, such as disabled web tools or delivery source.

Agent frontmatter model overrides apply after the Workspace merge. The default
Agent and all definitions already loaded by a configuration store are validated
with the candidate. Invalid YAML, configuration fields or Agent definitions
retain the entire prior configuration and definitions; the store's `lastError`
reports the rejection. Agent definitions are reread before a turn, and Skill
content is read when the Skill loads.

## Fields and boundaries

| Fields | Validation/default | Effect |
| --- | --- | --- |
| `llm` | Existing model contract; nonempty API key required | Next turn |
| `web_search`, `fetch_content` | Existing web-tool contracts; omitted/null disables | Next turn |
| Agent frontmatter and instruction body | Existing Agent contract | Next turn |
| `default_agent` | Nonempty ID identifying a valid Agent | New sessions |
| `sources` | Mapping from nonempty source to `{session_id: nonempty string}`; defaults to `{}` | Subsequent inputs |
| `default_delivery_source` | Nonempty source string or null; defaults to null | Subsequent delivery selection |
| `agents_path`, `skills_path`, `history_path` | Nonempty paths; defaults `.agents/bots`, `.agents/skills`, `.history` | Restart |
| `logging_path`, `event_path` | Nonempty paths; defaults `.logs`, `.event` | Restart |
| `channels.enabled` | Boolean; defaults false | Restart |
| `channels.telegram.enabled` | Boolean; defaults false | Restart |
| `channels.telegram.bot_token` | String; nonempty when Telegram is enabled | Restart |
| `channels.telegram.allowed_user_ids` | Array of numeric ID strings; defaults `[]` | Restart |
| `api.enabled` | Boolean; defaults false | Restart |
| `api.host` | Nonempty string; defaults `127.0.0.1` | Restart |
| `api.port` | Integer 1–65535; defaults 8000 | Restart |

All relative directories resolve against the selected Workspace. Configuration
validation itself opens no model or messaging connections. These fields prepare
connection/routing consumers; this configuration module does not start those
consumers. The bot entry point serves `/ws` when `api.enabled` is true and starts
Telegram polling when the channel is enabled; either interface runs independently.
Imports and `--help` start nothing.

Telegram user and chat identifiers are configured and carried as digit strings.
An empty `channels.telegram.allowed_user_ids` allows every user; a nonempty list
allows only the listed user IDs. Channel enablement, the bot token and the
allowlist take effect only after a restart.

A session keeps its Agent ID even when the default changes. Each turn captures
its model, web tools and Agent definition before issuing requests; subsequent
configuration changes do not alter tool continuations or compaction within that
turn. Manual compaction also captures settings before starting. Refreshing a
turn retains context, summaries, original reasoning and completed tool results;
changed request settings invalidate prior token-usage estimates.

## Store ownership and runtime updates

One embedded runtime owns one `WorkspaceConfiguration`. Share that store with
Agents using `Agent.open({configuration, agent})`. Without a supplied store, the
Agent creates its own store and starts watching configuration files; callers
release it with `await agent.close()`. Closing an Agent with a supplied store
does not stop the shared store. The runtime owns its `startWatching()`/`stop()`
lifecycle. Imports and CLI/bot help do not start watchers or connections.

- `config` returns the latest validated configuration.
- `activeConfig` holds startup directory, channel and API values alongside live
  settings. `Agent.config` reports its turn snapshot of these active values.
- `restartRequired` lists changed directory fields and `channels`/`api` groups
  requiring restart. It clears when values are restored to their startup values.
- `snapshot(agentId?)` rereads and validates files, then returns an independent
  configuration and Agent-definition snapshot. Omitting the ID selects the
  current default. Invalid edits yield the prior valid snapshot.
- `reload()` returns whether a candidate was accepted; a rejected candidate
  leaves `lastError` available and preserves previous settings.
- `updateRuntime(patch)` recursively merges a mapping into the latest runtime
  file, preserving unknown extension fields. Reads, validation, writes and
  memory publication serialize within the store. Arrays replace rather than
  append. The serialized candidate is validated before a private temporary
  file is renamed over `config.runtime.yaml`; memory changes only after the
  replacement succeeds. Failed updates reject without publishing their settings.
- `stop()` closes the watcher, skips queued watcher reloads and waits for accepted
  reads/writes to finish. Further snapshots, reloads, writes and watcher starts
  are rejected. Repeated stops are safe.

Watching the parent directory detects edits and common atomic-save replacements
of both configuration files. Watcher errors are reported through `lastError`;
explicit reload and next-turn reads remain available. No cross-process workspace
lock is provided; run only one runtime against a Workspace at a time.
