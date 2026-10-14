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
Resource discovery is disabled in this exchange slice. ModelRuntime is supplied
explicitly; the fixture uses in-memory credentials and disables network catalog
refresh so normal checks do not read personal auth or contact public providers.

The root `typecheck` and `build` commands include the runner npm workspace. The
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
HTTP service. The compiled startup smoke also verifies that the isolated runner
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
recreation. It owns temporary Compose resources and generated fixture keys;
no personal or paid services are used. See [container runtime](../container-runtime.md)
for pins, prerequisites and the fixture-only upstream trust exception.

Infrastructure evidence and actual-service evidence are separate. A passing
container check does not establish a live DeepSeek or Telegram deployment.

## Persistent host and CLI

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

`tests/cli.test.ts` uses actual local Unix sockets and CLI/host child processes
for input/reply, reconnect, first-input client replacement, malformed input,
owner-local permissions, Ctrl+C, singleton listener and SIGTERM cleanup. Startup
tests import modules without initialization and reject invalid host settings and
an unavailable host without credentials. The compiled `scripts/host-cli-demo.mjs`
is included in `verify` and separately runnable with `npm run demo:host`. It uses
the same controlled mailbox driver and removes its processes, sockets and state.
The replaced embedded CLI tests are retired; embedded Agent, bot, tools and
context behavior retain their own tests until their responsibilities move.
