# Isolated Agent session execution

The container runner consumes persisted input and produces a persisted reply
through directional SQLite mailboxes. `provisionSession` prepares the selected
Agent session; `DockerDriver.start` launches its Pi runner with a `OneCliGateway`.
The persistent host uses these production boundaries for its CLI sessions.
See [host runtime](host-runtime.md) for entity routing, startup and the local
socket client. The bot remains on its embedded runtime until channel integration.

## Runtime and configuration

Build the image from the repository root:

```sh
docker build -t mybots-agent:mailbox -f container/Dockerfile .
```

The host uses Node.js 24.21.0. The runner uses Bun 1.4.0, pinned by image digest.
Its Pi SDK dependencies are installed from the root npm lockfile in a separate
image stage. No host credentials or runtime data enter the build context. The
mailbox npm workspace exposes explicit runtime entries: `@mybots/mailbox/node`
uses a static `node:sqlite` import, and `@mybots/mailbox/bun` uses a static
`bun:sqlite` import. The root entry exports protocol types and lock cleanup
without loading either SQLite driver. Both runtime entries share the schema,
mailbox operations and per-database concurrency protection.

The runner declares Bun 1.4.0 and pins `@types/bun` 1.4.0 as a development
dependency. Only its TypeScript project enables `types: ["bun"]`; the host keeps
`types: ["node"]` and excludes the Bun entry from its source discovery and build.
Host compilation emits the Node entry and shared mailbox code alongside host
output. The container executes TypeScript source with Bun; npm installs its
runtime dependencies, while the image supplies Bun and its built-in SQLite.
See [Bun TypeScript definitions](https://bun.sh/docs/typescript) and
[SQLite](https://bun.sh/docs/runtime/sqlite) for the native API contracts.

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
model operation. Enable web search by adding a provider credential connection
scoped to the configured search endpoint's hostname; the runner sends a
placeholder and never receives the real search key. The adapter does not create
credentials, broaden credential host patterns, or approve policy holds. Provision
those policies in the gateway before using the driver. No provider catalogue
grants network permission.

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
`session_state` and `container_state` in `outbound.db`, and touches the
session-local `.heartbeat` file on activity so the host has an observable
liveness signal. Each operation opens and
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

The poll loop queues inputs arriving during active execution as FIFO follow-ups.
Each input remains a separate exchange with its own reply correlation and address;
it does not steer the current exchange. A follow-up is acknowledged completed
as soon as the query accepts it into Pi's queue. A hard crash can therefore lose
that work even before a reply exists. Input refused by a closing query remains
pending for the next query.

Pi's synchronous Agent queue admits one follow-up at a time. Successful
tool-free `turn_end` events follow SDK persistence and identify exchange results;
tool rounds and low-level `agent_end` events do not. Errors and truncated
attempts wait for SDK recovery, the next user input, or prompt settlement before
becoming results. An ordinary failed exchange gets an error notice at its own
address; later queued exchanges retain their own results. A query that ends or
throws with unfinished work produces separate failure notices for those inputs.
Request-level SDK recovery does not redeliver the whole task or repeat completed
tools. Raw provider diagnostics are not reply content.

Cancellation closes query admission, stops follow-up polling, awaits SDK cleanup
and discards late results. The initial unfinished processing claim remains for
host recovery; early-completed follow-ups remain completed. Initial-result
acknowledgement deliberately precedes output persistence, so a crash between
them can lose the reply. The runner does not repair these accepted loss windows
or add atomic completion. The host reschedules or fails an abandoned claim under
its bounded policy; see [host runtime](host-runtime.md#interrupted-execution-recovery).

Stop a session with its handle's awaited `stop()` before re-provisioning or
replacing immutable context. Re-provisioning identical context is idempotent;
a changed model/instruction/resource-selection context fails explicitly. The caller owns session
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
recreates the session container and reopens the exact SDK conversation. A second
case adds a separately scoped search connection, runs the `web_search` Pi tool
against a controlled search route and verifies that only its host receives the
search credential.
Runtime observation additionally verifies adoption without duplicate containers
and observed termination. A separate
mounted storage regression exercises one thousand writes in each direction with
concurrent opposite-side readers. The suite also
checks read-only context/trust/input mounts, forbidden host paths, credential
absence from runner-visible material, and separate processing/delivery state.
Containers, temporary state and fixture credentials are removed on completion.
The infrastructure images are pinned by digest; the OneCLI management SDK is
locked at 2.2.1.

The fixture permits an unverified upstream certificate only for `model.test` and
`search.test`, which use an ephemeral self-signed certificate. Pi still verifies
the gateway's
MITM certificate against its mounted public CA. This fixture exception must not
be applied to a real model or search endpoint. The check makes no real provider
calls and
is excluded from ordinary `test`, `test:watch`, and `verify`. Passing it establishes
container, mailbox, proxy, CA and scoped gateway-target integration; DeepSeek and
channel acceptance
require separate explicitly requested live checks.

## Agent resources and reset controls

Immutable context carries optional non-secret `resources.skills` IDs,
`resources.tools` built-in or web tool names, and the matching `web` provider and
endpoint selection. Pi loads only the shared Agent's `AGENTS.md`
and explicitly selected `skills/<id>/SKILL.md` on a new query. It uses in-memory
settings and credentials; host Skills, login files, private settings, extensions,
themes and prompt templates are not discovered. No new host mounts are required.
See [host resources](host-runtime.md#shared-instructions-and-skills) for formats.

The runner registers `web_search` and `fetch_content` as Pi custom tools only for
the operations the Agent selected. Search sends requests to the explicit provider
endpoint through the gateway proxy with a placeholder credential; the provider
credential is gateway-owned. Content fetching and HTML extraction execute inside
the container with a 30-second deadline and a streamed 5 MiB response limit per
item, at most five items and three concurrent requests per call. Tool outcomes,
including per-item errors, return to the model for continuation; cancellation
stops active requests and awaited disposal releases their readers.

A `reset` input is a runner control rather than model text. Follow-up admission
stops at that row, leaving it and all later input pending until SDK query cleanup
(including compaction) finishes. The runner creates a new SDK SessionManager,
records the owner's reset action through its public message API, stores the new
continuation and acknowledges/replies through the usual independent records.
The control message makes Pi persist its otherwise empty conversation; no model
request or custom JSONL writer is used. Reset preserves earlier logs and shared
files. Automatic compaction and context restoration remain owned by Pi.
