# Persistent host and local CLI

The host owns owner identities/role grants, Agent identity and workspace, messaging
destinations, destination-to-Agent wiring, container configuration and persistent
sessions in `data/host.db`. The CLI connects to `data/cli.sock`; it opens no Agent
runtime and reads no model credentials. The production host runs the existing
isolated Pi runner through `DockerDriver` and `OneCliGateway`.

## Start and configure

Use Node.js 24.21.0. Copy the credential-free example into an ignored local root:

```sh
mkdir -p workspace
cp examples/host/host.json workspace/host.json
npm run dev:host -- --root ./workspace
# In another terminal:
npm run dev:cli -- --root ./workspace
```

For built programs run `npm run build`, then `npm run start:host -- --root
./workspace` and `npm run start:cli -- --root ./workspace`. Both commands default
to the current directory. The host accepts `--config FILE` to select another JSON
file; CLI only selects the installation root. `--help` requires no configuration
or service. Missing/invalid configuration fails before opening the host.

`owner` is a namespaced platform identity; the local example uses `cli:local`.
`agent` selects the Agent's ID, name, shared folder, instructions and explicit
model configuration. The execution harness is Pi; the model backend is specified
separately by `model.provider` and `model.id`. The central store saves the model
selector as `provider/id` plus its endpoint and token limits. Endpoints must use
HTTPS without URL credentials. Host configuration and gateway management material
are outside runner mounts.

Each `destinations` entry names a messaging group with `id`, `channelType`,
`platformId` and `instance`. It is wired to the personal Agent with shared session
mode, no threads and owner-only sender authorization. The `cliDestinationId` must
select a `cli` destination with platform ID `local`. Additional configured
messaging destinations can use the same Agent workspace and different sessions
through the host API; their channel adapters are separate deliveries.

`container.image` and `container.network` select an existing runner image and
internal Docker network. `gateway.url` is the host's OneCLI management endpoint;
`gateway.proxyHost` is the proxy-only hostname visible on the isolated runner
network. Optional `MYBOTS_ONECLI_API_KEY` and `MYBOTS_ONECLI_PROJECT_ID` are host-only
management settings. Put real model credentials and scoped policies in OneCLI,
not the JSON file. See [container execution](container-runtime.md) for gateway
provisioning, mounts and network requirements. Dependencies are checked when a
session starts; a driver failure is observable and leaves accepted input saved.

Configuration is loaded at host startup and persisted to host entities. Existing
destination IDs retain their channel/platform/instance meaning. Session context
is immutable once provisioned: changing model/instructions for an existing
session requires stopped execution and explicitly replacing its context; dynamic
Agent resource updates are not included in this slice.

## Conversations and delivery

Concurrent first inputs for an Agent/destination resolve to one saved session
through a central transaction and a unique active-session index. The host writes
the input mailbox before waking the driver. A reconnected terminal or fresh host
uses that saved session. The runner opens the exact provider-qualified Pi
continuation from its outbound mailbox; the host builds no model context.

Session-private mailboxes and Pi state live beneath
`data/sessions/<agent_group_id>/<session_id>/`. Shared materials live under
`groups/<folder>/`. Different destinations share that workspace while retaining
separate conversations. Host shutdown stops its running session containers;
restarting and sending a new input recreates execution for the same session.

The host mirrors terminal processing acknowledgements into inbound status and
independently delivers persisted outbound rows to their original destination.
`Host.inspect(sessionId)` reports input, output, continuation and delivery state.
An output with a missing input correlation or changed reply address is rejected.
Completion does not imply output persistence or delivery. Basic channel failure
is terminal for this slice; retry accounting and interrupted-execution recovery
are separate policies. Accepted loss windows are described in
[ADR 0008](adr/0008-mailbox-completion-and-recovery.md).

The CLI wire format is one JSON line each way: input `{"text":"hello"}` and
reply `{"text":"answer"}`. The data directory is mode 0700 and socket is mode
0600. Only one chat client is active: a new client claims the slot on its first
valid input, sends the previous client `[superseded by a newer client]` and closes
it. Merely connecting does not replace the active terminal. Disconnecting does
not cancel host Agent work. With no active terminal, CLI delivery is a no-op;
the outbound row remains persisted but is marked delivered. Reconnecting sees
subsequent replies, without guaranteed replay of disconnected output.

Blank terminal lines are ignored. `quit`, `exit`, `q` and EOF disconnect with
status 0; Ctrl+C disconnects with 130. Startup, host-disconnect and terminal
failures return 1. Slash input is sent as ordinary Agent text in this slice.

## Public lifecycle and verification

`Host.start({ root, configuration, driver })`, `accept`, `sessions`, `inspect`,
`observe`, `attachChannel` and `stop` are the host boundary. The driver accepts
session material and an abort signal and returns an awaited stop/exit handle.
`CliChannel.listen` and `close` own the local listener and its connected sockets.
Importing these modules starts no services. Observers cannot prevent persistence;
channels must settle delivery on shutdown cancellation.

`SIGINT`/`SIGTERM` closes the production CLI listener, aborts polling and delivery,
stops session resources and closes the central store. Host shutdown has a default
10-second bound and reports a failure if a driver ignores cancellation. Exclusive
`data/host.lock` prevents two hosts from owning the same state. Clean shutdown
removes it. After an abnormal host termination, first verify the old process and
session containers have stopped before removing a stale lock; automatic abandoned
execution recovery is not included here.

`npm run demo:host` builds and runs compiled host/CLI modules with the controlled
mailbox driver fixture. It shows an input/reply, CLI reconnect and host restart
with one saved session and its exact continuation. `verify` includes the same
bounded demonstration and executable help/configuration-failure checks. Host
integration tests use real central/session SQLite and the same driver boundary.
These checks do not establish Docker, gateway, CA or live provider behavior. The
opt-in infrastructure suite and actual-service acceptance remain separate.

The bot entry point still uses its embedded runtime while its adapters are being
moved to the host. It has separate configuration and storage; see the embedded
runtime sections in [README](../README.md).
