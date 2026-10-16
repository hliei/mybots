# Host configuration

The git checkout is the install root. `bash mybots.sh` writes `.env` and generates
`host.json` from [the CLI/WebSocket example](../examples/host/host.json). Do not
hand-edit the model, gateway, container, or token fields. The host reads `.env`
on every start and those values override the same fields in `host.json`. A
missing `host.json` fails startup and tells the operator to run setup.

Run one host. `--root` defaults to the current directory and `--config FILE`
selects another JSON file. `packages/host/src/index.ts` is the sole host startup
entry point. CLI selects only `--root`; it reads no model or gateway settings.

Operator values live in `.env` (mode `0600`). Names and empty values are listed
in `.env.example`. The host parser reads only named keys, does not copy the file
into `process.env`, and lets a non-empty process value override the file. Blank
assignments are ignored. Containers do not inherit `.env`.

| Name | Meaning |
| --- | --- |
| `ONECLI_URL` | Gateway management URL. Remote access stays on a tunnel or private network. |
| `ONECLI_API_KEY` | Gateway management credential. Host only. |
| `ONECLI_PROJECT_ID` | Optional project id. Written only when already set. |
| `TELEGRAM_BOT_TOKEN` | Bot API token for the host client. Required when `telegram` is enabled. |
| `MODEL_PROVIDER`, `MODEL_ID` | Model backend and model id. Blank setup fills `deepseek` and `deepseek-chat`. |
| `MODEL_BASE_URL` | HTTPS model endpoint. No userinfo, query, or fragment. |
| `MODEL_CONTEXT_WINDOW`, `MODEL_MAX_TOKENS` | Positive token limits. Blank setup fills `128000` and `4096`. |
| `CONTAINER_IMAGE`, `CONTAINER_NETWORK` | Runner image and internal Docker network. |
| `GATEWAY_PROXY_HOST` | Proxy alias on the internal network. |
| `EGRESS_LOCKDOWN` | Written `true`. Absent or `true` stays locked. Any other value fails startup. |
| `WEB_SEARCH_PROVIDER`, `WEB_SEARCH_ENDPOINT` | Optional search endpoint. Both are required together. |
| `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY` | Optional outbound proxy for the host service, not the runner. |

With no gateway URL configured, setup checks `http://127.0.0.1:10254` and
reuses a healthy local gateway. Otherwise it downloads the OneCLI 1.42.0 Compose
definition into `~/.onecli/` and starts it with Docker Compose. Fresh installs
bind published ports to loopback and do not load a parent `.env` into the gateway.
An existing Compose definition is kept. The local single-user gateway does not
require a management key; a remote gateway requires `ONECLI_API_KEY`.
Setup uses the management HTTP API and does not require the OneCLI CLI.

Each gateway step reconciles the proxy relay, including its running state and
internal-network alias. A local container gateway is reached through its backend
network, so the management port can stay on loopback on Linux too. Remote
gateways must expose their proxy on port `10255` to the relay. The relay restarts
unless explicitly stopped; the gateway and database never join the runner network.

Generated services enable Node's environment-proxy support. `ALL_PROXY` supplies
an HTTP/HTTPS fallback, and loopback addresses always bypass the outbound proxy.

`MYBOTS_MODEL_API_KEY` and `MYBOTS_SEARCH_API_KEY` are unattended prompt inputs.
They are not read from `.env` and are not written back. `MYBOTS_SKIP` names wizard
steps to skip. `MYBOTS_INSTALL_ID` overrides the service slug.

`.env` changes apply after the service restarts. Restart reloads host process
settings and future session provisioning. An existing session's immutable context
stays until the explicit replacement path.

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
- `telegram` means the channel is enabled. The section is `{ "instance": "telegram" }`.
  The token is `TELEGRAM_BOT_TOKEN` in `.env`. Enabled Telegram without that token
  fails startup. Pairing registers one `telegram:<user-id>` owner and the
  `owner-chat` destination in `data/host.db`. The next start merges that record
  over `host.json`. Groups and unpaired private chats produce no Agent work.

Re-running pairing requires the current code even when an owner already exists.
Successful registration records completion for that attempt and disables its code.
The wizard removes the attempt file when it completes or fails.

Omitting a channel section disables its listener. Telegram destinations require
matching Telegram settings. `container.network` must already exist and be internal; the host checks that on
every start and refuses to run when it is missing or open. `EGRESS_LOCKDOWN`
cannot skip the check. `gateway.url` is the host-reachable management endpoint
and `gateway.proxyHost` is the proxy-only hostname reachable on that network.
Management credentials are `ONECLI_API_KEY` and optional `ONECLI_PROJECT_ID` in
`.env`. The management plane and vault do not join the runner network.

## Persistence and configuration changes

The host persists identities, routing and container settings in `data/host.db`.
Restart to load changed host settings. Re-running the service step replaces the
same launchd job, systemd unit, or `start-mybots.sh` and overwrites Environment
that was edited by hand. The default image tag `mybots-agent:mailbox` and network
name `mybots-isolated` are shared across checkouts when that network is already
internal. Rebuilding the image moves the shared tag. The first generated WebSocket
listener is `127.0.0.1:8787`. If that port is in use, startup fails and names the
port; change the preserved websocket port in `host.json` and restart. Setup does
not choose another port. Execution configuration is immutable per
session: a changed model/instruction/resource selection requires stopped execution
and explicit context replacement; a restart alone does not overwrite it. Shared
workspace instruction/Skill files follow the next-query boundary above.
See [host lifecycle](host-runtime.md) for claims and restart recovery.

This configuration has no YAML overlays, configuration watcher, embedded execution
fallback or legacy history import. Real model/search keys belong in the gateway;
channel tokens stay host-side and are never copied into runner context.
