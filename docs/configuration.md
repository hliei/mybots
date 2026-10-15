# Host configuration

The installation root contains `host.json`. Start with the credential-free
[CLI/WebSocket example](../examples/host/host.json) or
[Telegram example](../examples/host/host-telegram.json). Run one host with
`npm run dev -- --root ./workspace`; `--config FILE` selects another JSON
file. `packages/host/src/index.ts` is the sole host startup entry point.
CLI selects only `--root`; it reads no model or gateway settings.

## Identity, model and resources

| Field | Meaning |
| --- | --- |
| `owners` | The owner's namespaced platform identities; exactly one `cli:` identity, plus `telegram:<user-id>` for a configured chat |
| `agent.id`, `name`, `folder` | Persistent Agent identity and shared `groups/<folder>/` directory |
| `agent.model.provider`, `id` | Model backend and model ID; the execution harness is Pi |
| `agent.model.baseUrl` | HTTPS endpoint without credentials, query or fragment |
| `agent.model.contextWindow`, `maxTokens` | Positive token limits; context window must cover the output allowance |
| `agent.instructions` | Optional instructions appended through Pi's resource loader |
| `agent.resources.skills` | Selected Skill directory IDs; omitted selects none |
| `agent.resources.tools` | Selected Pi built-ins and configured web tools; omitted selects `read`, `write`, `edit`, `bash`; empty disables all tools |
| `agent.web.search` | Optional `{ "provider": "brave" \| "serpapi", "endpoint": "https://..." }` |
| `agent.web.fetch` | Optional `true` to enable content fetching |

Selected web tool names (`web_search`, `fetch_content`) require their matching
`agent.web` operation. Search endpoints are non-secret configuration; the gateway
injects credentials only for the selected hostname. See [host runtime](host-runtime.md)
for full web examples and [container execution](container-runtime.md) for gateway
policy, proxy and trust requirements.

Put shared instructions in `groups/<folder>/AGENTS.md` and selected Skills in
`groups/<folder>/skills/<id>/SKILL.md`. Pi loads only explicitly selected resources;
ancestor/personal resources, extensions and file-backed SDK settings are disabled.
Shared instruction/Skill edits take effect on the next query after SDK cleanup.
An active query and its queued follow-ups keep that query's resources.

## Destinations and listeners

Each `destinations` entry has an `id`, `channelType`, `platformId` and `instance`.
IDs and channel/platform/instance combinations must be unique. Every destination
is wired to the configured personal Agent with a separate persistent session.

- `cliDestinationId` selects the local `cli` destination (`platformId: "local"`).
  The CLI uses `data/cli.sock`, restricted to the host account.
- `websocket` optionally supplies a loopback `host`, `port` and `path` (default
  `/ws`). Its destinations use `channelType: "websocket"` and one common instance.
  The loopback interface trusts processes on the local machine.
- `telegram` supplies `instance` and `botTokenEnv`. Telegram destinations use
  `channelType: "telegram"`, that same instance and the owner's numeric private
  chat ID as `platformId`. The matching `telegram:<id>` owner is required.
  The token is read from the named host environment variable. Unknown senders,
  groups and unconfigured private chats produce no Agent work.

Omitting a channel section disables its listener. Telegram destinations require
matching Telegram settings. `container.image` must name the built runner image;
`container.network` selects an internal Docker network. `gateway.url` is the
host-reachable management endpoint and `gateway.proxyHost` is the proxy-only
hostname reachable on that network. Optional management credentials use host
variables `MYBOTS_ONECLI_API_KEY` and `MYBOTS_ONECLI_PROJECT_ID`.

## Persistence and configuration changes

The host persists identities, routing and container settings in `data/host.db`.
Restart to load changed host settings. Execution configuration is immutable per
session: a changed model/instruction/resource selection requires stopped execution
and explicit context replacement; a restart alone does not overwrite it. Shared
workspace instruction/Skill files follow the next-query boundary above.
See [host lifecycle](host-runtime.md) for claims and restart recovery.

This configuration has no YAML overlays, configuration watcher, embedded execution
fallback or legacy history import. Real model/search keys belong in the gateway;
channel tokens stay host-side and are never copied into runner context.
