# Isolated Agent session execution

The container runner consumes persisted input and produces a persisted reply
through directional SQLite mailboxes. `provisionSession` prepares the selected
Agent session; `DockerDriver.start` launches its Pi runner with a `OneCliGateway`.
The persistent host uses these boundaries for CLI, Telegram and WebSocket sessions.
See [host runtime](host-runtime.md) for entity routing, startup and the local
socket client. `packages/host/src/index.ts` composes all host-side channel services.

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

## Mailbox package resolution

Both host and runner depend on `@mybots/mailbox` by package name; no consumer
imports mailbox internals. The root entry and explicit `/node` and `/bun` entries
use the same export arrangement:

| Consumer | Export selection | Files |
| --- | --- | --- |
| TypeScript checking and compilation | `types` | `packages/mailbox/src/*.ts` |
| Source host and offline tests | `mybots-source` | `packages/mailbox/src/*.ts` |
| Built host and Node demos | default | `packages/mailbox/dist/*.js` |
| Production Bun runner | `mybots-source`, explicit `/bun` | `packages/mailbox/src/*.ts` |

`npm run dev` passes `--conditions=mybots-source` to Node. Vitest selects the
same condition and passes it to spawned source processes through `NODE_OPTIONS`.
The container passes the condition directly to Bun. The source CLI and `bin/mbt`
need no condition because they depend only on Node built-ins and CLI modules.
No global resolver hooks or TypeScript path aliases are used.

The root build cleans output and compiles mailbox, host and runner in workspace
order. Each package emits only its own source into its own `dist/`; package imports
remain package imports. The mailbox's `types` entries let clean-checkout type
checking and compilation read source without requiring generated declarations.
The host project enables Node types and never imports the Bun entry; mailbox and
runner projects pin `@types/bun` 1.4.0 for their Bun API checks. A Node smoke check
also verifies that the Bun entry fails instead of falling back to Node SQLite.

The production image installs only runner production dependencies from the root
lockfile. It copies `packages/agent-runner` and `packages/mailbox` source into the
same workspace paths, preserves npm's package symlinks, and runs
`/app/packages/agent-runner/src/index.ts` with Bun 1.4.0. Host source, host-only
dependencies, repository tools and compiled artifacts stay out of that image.
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
declares the local Docker gateway container and alias, plus HTTP/HTTPS proxy configuration, the gateway-issued scoped proxy
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
runner image. The driver connects the OneCLI container directly to this network
with the configured proxy alias before startup and adoption, repairing attachment
after gateway recreation. The gateway must be running and retain a separate
backend network; PostgreSQL remains exclusively on that backend network. The
production gateway container is named `onecli`. Remote gateways that depended on
a local relay are unsupported. Runtime, gateway, image and mount failures stop
execution; there is no embedded or direct-network fallback.

Both the proxy and management listeners are reachable from session containers.
OneCLI local mode grants unauthenticated management requests `local-admin`
permissions, including changes to credential configuration and grants. The scoped
proxy identity governs proxy requests, not management requests. Although real
model/search keys are not placed in runner mounts or environment, the session
network is no longer a barrier to gateway administration. This accepted tradeoff
is recorded in [ADR 0009](adr/0009-direct-gateway-network.md). Host loopback port
publishing does not protect listeners from same-network containers.

## Persistence and mount ownership

| Host path | Container path | Ownership / access |
| --- | --- | --- |
| `data/sessions/<agent_group_id>/<session_id>/` | `/session` | Current session material; runner writes output and Pi state |
| The session's `inbound.db` | `/session/inbound.db` | Host writes; overlaid read-only for runner |
| `groups/<folder>/` | `/workspace/group` | Shared writable Agent working materials |
| `data/task-attachments/<bot_id>/<task_id>/` | `/workspace/group/.task-attachments` | Read-only inputs for Runs of that Task. Omitted when the session is not a Run. Other Tasks do not receive this mount. |
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

Production execution receives immutable Run context with source-message identity,
captured background boundary and bounded original Thread references. Each Run
mounts only its own SDK ledger and directional mailboxes. Later Attempts reopen
that same ledger; new Runs use independently initialized SDK state.

The poll loop queues active Run additions with SDK steering. Queue insertion
alone does not acknowledge completion. Input identity is recorded in the SDK
user message, and a later awaited Agent listener publishes recording evidence
only after coding-agent's persistence listener. Final settled results correlate
all consumed additions to their input addresses. Unconsumed steering remains
pending for another query in the same Run.

Context selection drops older quoted references before required live instructions.
A conservative UTF-8 byte bound reserves model output, system and tools; input
that cannot fit fails visibly. Pi retains its tool loop, resources and automatic
compaction. Reopening uses existing tool/result pairs without replay to reconstruct
context. A recorded final answer can repair missing output evidence; incomplete
tool evidence fails visibly rather than replaying a partial tool stack.

Cancellation closes admission, stops polling and awaits SDK cleanup. Host recovery
retains pending inputs and bounded unfinished claims. Acknowledgement still precedes
output persistence, so an acknowledged result can remain uncertain after a crash.
These records do not establish atomic tool effects or exactly-once completion.

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
OneCLI 1.42.0, PostgreSQL 18.0 and a controlled TLS/SSE model
service. It generates ephemeral fixture credentials, stores the model key in
OneCLI, runs workspace tools through Pi, reads persisted output on the host,
recreates the session container and reopens the exact SDK conversation. A second
case adds a separately scoped search connection, runs the `web_search` Pi tool
against a controlled search route and verifies that only its host receives the
search credential.
The suite verifies the alias resolves directly to OneCLI, unauthenticated local
management access, blocked direct Internet/database connections, and recovery
after gateway recreation while preserving its CA and encryption material in a
disposable volume. Runtime observation additionally verifies attachment repair
during adoption without duplicate containers and observed termination. A separate
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
`resources.skillRevisions` content hashes for owner-activated revisions,
`resources.tools` built-in or web tool names, and the matching `web` provider and
endpoint selection. Pi loads only the shared Agent's `AGENTS.md`
and explicitly selected `SKILL.md` files on a new query. Activated revisions
load from `/session/skills/<id>/SKILL.md`, a read-only mount backed by Host-owned
`data/protected-skills/<botId>/<runId>/` outside writable session/workspace paths. It uses in-memory
settings and credentials; host Skills, login files, private settings, extensions,
themes and prompt templates are not discovered. Skill proposals in the writable
workspace cannot replace activated revisions.
See [host resources](host-runtime.md#shared-instructions-and-skills) for formats.

The runner registers `web_search` and `fetch_content` as Pi custom tools only for
the operations the Agent selected. Search sends requests to the explicit provider
endpoint through the gateway proxy with a placeholder credential; the provider
credential is gateway-owned. Content fetching and HTML extraction execute inside
the container with a 30-second deadline and a streamed 5 MiB response limit per
item, at most five items and three concurrent requests per call. Tool outcomes,
including per-item errors, return to the model for continuation; cancellation
stops active requests and awaited disposal releases their readers.

`/reset` and the Thread reset operation capture a new chat background boundary
for later conversational Runs. Existing Run ledgers stay in place. Earlier
messages enter a new Run only when the owner selects them.
Automatic Run compaction and context restoration remain owned by Pi.

## Original-history mailbox operations

The Host writes the current executor incarnation and correlated history responses
to `host_operation_state` in runner-read-only `inbound.db`. The runner captures
that incarnation at startup and writes `request:<id>` entries to its own
`outbound.db` session state for `search_history`/`read_history`. The Host checks
current ownership and the actual executor generation before deriving history
scope from that mailbox. Adoption preserves the running executor token; a newly
started executor receives a new incarnation only after prior stop is confirmed.
Requests have a bounded, abortable thirty-second wait and responses retain the
same correlation ID. This read-only operation bridge grants no Host database,
Docker, source-path or cross-Bot access.

`evidence:<SDK-entry/block-id>` records contain product input, assistant text and
complete tool calls/results, independently of SDK compaction. `live:current`
contains a bounded accumulated preview and current tool. Hidden reasoning,
provider-only payloads and system prompts are excluded. Thread text originals,
Run recording and transient progress remain distinct; none of the preview or
operation-transport acknowledgements establishes a completed Run outcome.
