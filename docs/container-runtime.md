# Isolated Agent session execution

The container runner consumes persisted input and produces a persisted reply
through directional SQLite mailboxes. `provisionSession` prepares the selected
Agent session; `DockerDriver.start` launches its Pi runner with a `OneCliGateway`.
These are reusable production boundaries. CLI and bot still use their existing
runtime while host routing and channel integration are being delivered.

## Runtime and configuration

Build the image from the repository root:

```sh
docker build -t mybots-agent:mailbox -f container/Dockerfile .
```

The host uses Node.js 24.21.0. The runner uses Bun 1.4.0, pinned by image digest.
Its Pi SDK dependencies are installed from the root npm lockfile in a separate
image stage. No host credentials or runtime data enter the build context. The
mailbox npm workspace shares its native TypeScript implementation between Node
and Bun, using each runtime's SQLite bindings. Host compilation also emits the
mailbox source alongside the host output.

Provisioning takes an installation root, Agent group ID, session ID, workspace
folder and explicit model configuration (`provider`, `id`, HTTPS `baseUrl`,
`contextWindow`, `maxTokens`). The current runner supports the OpenAI-completions
transport, including DeepSeek-compatible endpoints. It registers only the
selected model with an in-memory credential store and the `gateway-managed`
placeholder. It does not discover personal login files or refresh model catalogs.

Configure the OneCLI adapter with its management `url`, optional host-only
`apiKey` and `projectId`, the proxy hostname visible on the runner network, and
`<root>/data/gateway-trust` as its trust directory. The validated contribution
contains only HTTP/HTTPS proxy configuration, the gateway-issued scoped proxy
identity, and a public CA path. Management credentials and real model credentials
stay outside runner material. Harness-specific credential stubs are unsupported.

The gateway must hold the model credential with bearer-header injection scoped
to the selected endpoint's exact hostname, and its policy must permit the chosen
model operation. The adapter does not create credentials, broaden credential
host patterns, or approve policy holds. Provision those policies in the gateway
before using the driver. No provider catalogue grants network permission.

The driver requires an existing **internal** Docker network and an existing
runner image. Put a proxy-only endpoint on this network; keep gateway management,
credential storage, host services and other sessions off it. An all-in-one
gateway can use a TCP relay exposing only its proxy port. The opt-in fixture
shows this topology. Runtime, gateway, image and mount failures stop execution;
there is no embedded or direct-network fallback.

## Persistence and mount ownership

| Host path | Container path | Ownership / access |
| --- | --- | --- |
| `data/sessions/<agent_group_id>/<session_id>/` | `/session` | Current session material; runner writes output and Pi state |
| The session's `inbound.db` | `/session/inbound.db` | Host writes; overlaid read-only for runner |
| `groups/<folder>/` | `/workspace/group` | Shared writable Agent working materials |
| `data/sessions/<agent_group_id>/.context/<session_id>.json` | `/run/mybots/context.json` | Immutable host-owned context, read-only |
| `data/gateway-trust/<digest>.pem` | `/run/gateway/ca.pem` | Public trust certificate, read-only |

The root filesystem is read-only, `/tmp` is ephemeral, Linux capabilities are
dropped, and the process runs with the host account's numeric UID/GID. The driver
admits only these fixed mounts, validates real paths, and never mounts the central
host database, channel credentials, mount policy or Docker socket. No arbitrary
mounts or inherited host environment are passed to the runner.

`HostMailbox` writes `messages_in`, `session_routing`, and `delivered` in
`inbound.db`. `RunnerMailbox` writes `messages_out`, `processing_ack`,
`session_state` and `container_state` in `outbound.db`. Each operation opens and
closes its connection, disables mmap, and uses DELETE journaling for writes.
Readers open the opposite side read-only. An atomic directory lock per database
serializes one read/write operation across the host and VM; their kernel advisory
locks alone can expose an in-progress journal or inconsistent pages. This is not
a workspace lock or a completion transaction. Lock waits are bounded at five
seconds. Bootstrap and confirmed runtime termination clear orphan locks only
when the session is quiescent; callers must exclusively admit stopped sessions.
Bootstrap creates schema version 1
only for missing files, before execution; reopening existing files is read-only.
Later schema changes must explicitly evolve this version.

Input sequences are even; output sequences are odd. Output keeps the input's
`in_reply_to`, channel, platform and thread routing. Processing acknowledgements,
continuation, tool activity and delivery acknowledgements are separate records.
SDK logs remain under the session's `pi/sessions/`; a saved `pi:` continuation
selects one exact conversation at the stable container path after recreation.

The poll loop executes one persisted input at a time. Inputs arriving during a
query remain in the mailbox until it ends; active SDK follow-up queue integration
is subsequent work. Ordinary provider failures become failed processing plus an
error output. Cancellation awaits the query's cleanup and leaves an unfinished
processing claim for host recovery. Initial-result acknowledgement deliberately
precedes output persistence, so a crash between them can lose the reply. The
runner does not repair that accepted loss window or add atomic completion.

Stop a session with its handle's awaited `stop()` before re-provisioning or
replacing immutable context. Re-provisioning identical context is idempotent;
a changed model/instruction context fails explicitly. The caller owns session
admission and the lifetime of the returned handle. `wait()` observes runtime
termination; cancellation requests stop and removal. Stop failures are reported
and must be resolved before reusing the session material.

## Controlled infrastructure check

With Docker Desktop running and `openssl` available:

```sh
npm run test:infrastructure
```

This command builds the production image and launches disposable, uniquely named
OneCLI 1.42.0, PostgreSQL 18.0, a proxy-port relay and a controlled TLS/SSE model
service. It generates ephemeral fixture credentials, stores the model key in
OneCLI, runs workspace tools through Pi, reads persisted output on the host,
recreates the session container and reopens the exact SDK conversation. A separate
mounted storage regression exercises one thousand writes in each direction with
concurrent opposite-side readers. The suite also
checks read-only context/trust/input mounts, forbidden host paths, credential
absence from runner-visible material, and separate processing/delivery state.
Containers, temporary state and fixture credentials are removed on completion.
The infrastructure images are pinned by digest; the OneCLI management SDK is
locked at 2.2.1.

The fixture permits an unverified upstream certificate only for `model.test`,
which has an ephemeral self-signed certificate. Pi still verifies the gateway's
MITM certificate against its mounted public CA. This fixture exception must not
be applied to a real model endpoint. The check makes no real provider calls and
is excluded from ordinary `test`, `test:watch`, and `verify`. Passing it establishes
container, mailbox, proxy and CA integration; DeepSeek and channel acceptance
require separate explicitly requested live checks.
