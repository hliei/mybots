# Testing

## Framework and layout

Use Vitest with TypeScript in the Node.js environment. Put ordinary tests in
`tests/`, named `*.test.ts`, grouped by behavior or module as needed. Import test
APIs explicitly from `vitest`. Tests normally import application source;
compiled entry points are checked by the startup smoke checks defined in
[Development](development.md#command-contract).

Keep live-service tests under `tests/live/` and exclude that directory explicitly
from ordinary test discovery. Use a separate configuration and command when
introducing these tests. Ordinary tests must remain offline even when credentials
or endpoint environment variables are present.

## Behavior and test-first development

- Test public behavior through module interfaces. Derive expected results from
  requirements and known examples rather than repeating implementation logic.
- For new application behavior, write one failing test, observe the expected
  failure, implement the smallest change that passes, then continue with the
  next behavior. A broken import, missing dependency, or type error is not a
  behavior failure.
- For a bug fix, add a regression test that demonstrates the reported failure
  before changing the implementation.
- Refactoring must preserve existing behavior tests. Configuration and
  documentation changes use relevant command or content checks rather than
  tests that merely repeat their contents.
- Assert meaningful results and externally observable state. Check internal
  calls only when the interaction itself is part of the contract.
- Choose tests for success, failure, and relevant boundary cases. Coverage
  reports can identify gaps; a percentage alone is not a completion criterion.

## Dependencies and isolation

- Replace live model responses and platform connections with controlled test
  implementations. Keep internal agent, session, and routing logic real where
  practical, including tests that exercise those components together.
- Use a local controlled server when testing HTTP or WebSocket behavior.
  Ordinary tests must not contact public services or consume paid tokens.
- Keep test state independent. Use a fresh temporary directory for filesystem
  and persistence tests; avoid developer workspaces and credentials.
- Restore modified environment variables, mocks, timers, and shared state after
  each test. Close connections and remove temporary files even after failure.
- Use deterministic inputs. Control time and randomness when they affect the
  asserted behavior.

## Asynchronous and persistent behavior

- Wait for explicit completion signals or observable results instead of fixed
  sleeps. Keep waits bounded so failures terminate with useful output.
- Verify startup, cancellation, and shutdown for background workers. Await
  cleanup so tests do not leave connections, timers, or tasks running.
- When adding message handling, test source-to-session mapping, session
  isolation, and reply destinations.
- Define and test what happens when messages overlap in the same session;
  distinguish session ordering from limits on concurrent agent executions.
- When adding persistence, verify recovery using a new instance reading the
  saved state, not only the instance that wrote it.
- When implementing retries or delivery recovery, test failures and the agreed
  duplicate-handling behavior. Keep these expectations explicit rather than
  assuming exactly-once delivery.

## Running and reporting

Run every new or modified test file and iterate until it passes. Use focused
runs during development, then follow the delivery checks in
[Development](development.md#validation-and-completion).

Run live-service checks only when explicitly requested. Keep credentials out of
fixtures and output, and report live checks separately from ordinary validation.
An offline suite passing does not establish that a real provider or platform
connection works.

## Pi Agent session exchanges

`tests/pi-provider.test.ts` exercises the production provider query contract with
Pi coding-agent SDK 1.2.0 and its real SessionManager. The controlled HTTP/SSE
model service in `tests/pi-fixture.ts` replaces only model responses. Tests cover
workspace read/write/edit/bash effects, tool-result continuation, one final reply,
explicit reopening despite a newer unrelated session, cancellation, provider
failure and invalid continuation. State lives in fresh temporary directories;
SDK resources and local servers are closed and awaited.

The real SDK tests also hold a model request while admitting multiple follow-ups,
check one result per input after tool continuation, distinguish an ordinary
failed exchange from later queued work, and exercise automatic request recovery
without repeating a completed tool effect. Abort rejects further input and
abandons queued SDK work. A local streaming failure exercises SDK recovery;
ordinary HTTP errors exercise the separate terminal error path.

Conversation files stay SDK-owned in the session-local `pi/sessions/` directory.
Resource discovery uses only explicitly selected Agent Skills and the shared workspace's `AGENTS.md`; ancestor and personal resource discovery stay disabled. ModelRuntime is supplied
explicitly; the fixture uses in-memory credentials and disables network catalog
refresh so normal checks do not read personal auth or contact public providers.

The root `typecheck` and `build` commands include all three npm workspaces.
Offline tests resolve the mailbox source condition, including spawned source
processes; compiled startup checks use its default JavaScript exports. The
root `verify` also runs its compiled provider through the bounded offline demo
in `scripts/check-startup.mjs`. Run `npm run demo:pi` for visible tool/reopening
evidence. These checks establish the Node.js package boundary; Docker mounts,
gateway proxy/TLS, paid providers and real messaging require separate acceptance.

## Directional mailbox execution

`tests/mailbox.test.ts`, `tests/mailbox-runner.test.ts`, `tests/gateway.test.ts`
and `tests/container-driver.test.ts` cover persisted ordering/correlation,
completion before output, the accepted final-reply crash gap, provider failure,
cancellation, tool state, constrained gateway contributions and immutable
provisioning. They use temporary state, real SQLite and a controlled management
HTTP service. The compiled startup smoke also starts and stops the built host with native TypeScript disabled, verifies
the root mailbox export without loading either SQLite driver, and verifies that the isolated runner
refuses loading the Bun SQLite entry under the unsupported host runtime without
fallback. Ordinary mailbox tests use the Node entry; actual container tests use
the Bun entry with the same persisted protocol and concurrency protection.

`npm run test:infrastructure` uses `tests/infrastructure/vitest.config.ts`.
Ordinary discovery explicitly excludes `tests/infrastructure/`. The opt-in suite
runs actual Docker, the production Bun runner, OneCLI, mounted mailboxes and a
controlled TLS streaming upstream. A mounted stress regression additionally
checks both directions under concurrent reads and one thousand writer operations.
It checks a tool round, credential injection,
forbidden/read-only mount behavior and exact Pi continuation after container
recreation. A separate case enables `web_search`, registers a second gateway
connection scoped to the controlled search hostname and verifies that the runner
receives the injected search credential only at that target.
Runtime observation also verifies adoption without duplicate containers and
observed termination.
The suite owns temporary Compose resources and generated fixture keys;
no personal or paid services are used. See [container runtime](../container-runtime.md)
for pins, prerequisites and the fixture-only upstream trust exception.

Infrastructure evidence and actual-service evidence are separate. A passing
container check does not establish a live DeepSeek or Telegram deployment.

## Persistent host and CLI

Recovery regressions cover concurrent fresh/stale-lock acquisition, uncertain
runtime observation/adoption, failed container termination with preserved claims,
and input arriving during replacement. A controlled Docker executable at the
process boundary verifies that failed termination can be retried successfully.

`tests/host.test.ts` uses the public host input, observation, session inspection
and lifecycle interfaces with real `data/host.db` entities and session mailbox
stores. `tests/host-fixture.ts` replaces only isolated execution at the session
driver boundary: it reads runner-permitted input, writes processing/output and
continuation, and owns its abortable loop. It is a mailbox fixture, not evidence
of actual Pi, Docker or gateway behavior. Tests cover concurrent first routing,
owner denial, separate destinations sharing one Agent workspace, restart affinity,
explicit continuation, persisted output and independent completion/delivery state,
configuration failure, blocked delivery cancellation and bounded shutdown failure.

Runner tests additionally cover early follow-up completion before any output,
FIFO results across distinct reply addresses, ordinary versus thrown/missing
results, late success after cancellation, awaited cleanup and the accepted
queued-work loss window. Host tests hold both execution and channel delivery
at explicit checkpoints while another session writes shared materials and replies.
All waits are bounded; no live credentials or workspace-wide lock are required.

`tests/reconcile-session.test.ts` covers the recovery policy directly: the
doubling waits before five bounded retries, exhaustion to a failed state, and
stall decisions from heartbeat age, claim age and a tool's declared timeout
against a real mailbox. `tests/host-recovery.test.ts` drives the public host
lifecycle with a controlled clock and real stores: adopting an observed running
container instead of starting another, adopting an abandoned host lock,
recovering an abandoned claim across restart through the exact wait sequence,
leaving completed and provider-failed input terminal, bounding repeated crashes
that happen before any claim, replacing a container whose
claim went silent, fencing a superseded handle's late exit, and upgrading an
existing version-2 store. `tests/mailbox-runner.test.ts` adds the repeated
tool-effect retry: a controlled effect performed before an interruption occurs
again on recovery, and neither the test nor the reply claims exactly-once
execution. These fixtures use controlled external execution, not Pi, Docker or
gateway behavior.

`tests/host-delivery.test.ts` drives persisted outbound delivery through
controlled channels against real central/session stores. It covers a successful
send with cleared attempt bookkeeping, a poisoned send retried exactly three
times before terminal `failed` state, prior-life attempt rows restored by a fresh
host instance that still delivers once, exhaustion across host restarts that is
never sent again, the platform-acceptance/acknowledgement gap that duplicates a
reply, later replies continuing while an earlier reply fails in the same session,
an independent session delivering while another destination fails, and no replay
of output already accepted with no connected client. Attempt rows are read from
the real host-coordination store; no live platform is contacted.

`tests/cli.test.ts` uses actual local Unix sockets and CLI/host child processes
for input/reply, reconnect, first-input client replacement, malformed input,
owner-local permissions, Ctrl+C, singleton listener and SIGTERM cleanup. Controlled
socket peers also exercise fragmented/coalesced replies, text validation,
unexpected disconnect, EOF and superseded-client exit status through the actual
CLI process. An isolated npm prefix exercises the real linked `mbt` executable
from different directories, shared session affinity, Ctrl+C and missing-host
failure without creating a host. Source command startup is checked with `dev`
and `mbt`; compiled smoke executes `npm start` and the built CLI. Startup
tests import modules without initialization and reject invalid host settings and
an unavailable host without credentials. The compiled `scripts/host-cli-demo.mjs`
is included in `verify` and separately runnable with `npm run demo:host`. It uses
the same controlled mailbox driver and removes its processes, sockets and state.
All replaced embedded execution, context, routing and delivery tests are retired.
Current contracts use host/channel and real Pi SDK tests. Independent Bot API
normalization and transport cases remain in `tests/telegram-api.test.ts`.

`tests/host-telegram.test.ts` connects `TelegramChannel` and `runHost` to the real
host/store/mailbox path with a controlled Bot API. It covers owner routing,
unknown-sender and non-private/unconfigured-chat rejection, ordered message
splitting at the Telegram limit, polling-offset advance and ignored updates,
cancellation and bounded shutdown, Telegram/CLI separation within one shared
workspace, restart affinity with exact continuation, token containment outside
runner material, coherent `telegram` settings and entry-point start/stop. The
`createTelegramApi` boundary is exercised separately with a mock `fetch`; no test
contacts Telegram or uses a real token. Live Telegram acceptance remains part of
the separate actual-service pass.

`tests/websocket-channel.test.ts` binds the owner-local WebSocket channel to a
real host, central store and per-session mailboxes with the controlled mailbox
driver and actual local sockets. It verifies validated input and rejection,
correlated inbound/outbound envelopes with destination meaning, separate
WebSocket/CLI conversations sharing one workspace, passive observation of another
channel's undelivered output, slow-peer dropping, reconnect without event replay,
host failure envelopes, loopback-only binding and bounded shutdown.

## Agent resources and conversation controls

`tests/pi-resources.test.ts` uses the real SDK with a controlled streaming service
for selected Skill discovery/read, explicit built-in tool selection, shared Agent
instructions, missing resources, separate conversations reading shared materials,
automatic compaction and exact summary reopening. An explicit reset persists a
fresh SDK conversation without a model request and preserves previous logs.

`tests/host-resources.test.ts` connects the public Host API to the production
mailbox loop and real Pi adapter through an offline driver. It holds a model
request, queues an owner reset and later input, checks the idle/FIFO boundary,
authorization, separate session continuation and shared-file preservation, then
restarts the host to verify the new continuation. This driver bypasses Docker
and gateway transport; it establishes neither mount isolation nor live-provider
compatibility. `tests/host.test.ts` also verifies selected resources and web
configuration persist into each session's immutable runner context after host
restart.

`tests/web-config.test.ts` covers the explicit web provider/endpoint selection,
the web tool names in Agent resource selection, and the host-level requirement
that a selected web tool has matching configuration. It also upgrades existing
schema versions 2 through 4 while preserving delivery and host lifecycle state.
`tests/pi-web-tools.test.ts`
uses the real SDK with a controlled streaming model service, a controlled search
service and a controlled page service. It verifies that a model tool round calls
`web_search` and `fetch_content`, that their JSON results return to the model and
produce one final reply, that unselected web tools stay out of the model tool
list, that provider failure returns a usable per-item error, that cancellation
terminates an active request, and that batches preserve order and reject
ambiguous arguments. No credential reaches the fixture; search requests carry
only the gateway placeholder.
An additional host case runs the production mailbox loop with the real SDK,
search and page services, then verifies the correlated final reply reaches its
host channel and receives persisted delivery acknowledgement.

## Integrated channel operation

`tests/host-channels.test.ts` connects CLI sockets, controlled Telegram and real
local WebSocket clients to one host. It checks overlapping conversations, shared
working material, a blocked Telegram send observed without acknowledgement by
WebSocket, independent progress and preserved affinity after host restart.
`tests/startup.test.ts` also exercises listener-bind startup rollback and verifies
that the host entry point requires host settings even if old YAML settings are
present.
The former live harness was retired with embedded execution; a current live
harness is separate acceptance work. No ordinary fixture invokes that engine.

`tests/pi-web-content.test.ts` preserves independent extraction coverage at the
production Pi-tool boundary: ordered partial failures, Unicode continuation,
hidden-content removal and relative-link resolution. No embedded Agent fixture
is retained for these contracts.
