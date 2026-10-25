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
  implementations. Keep internal Agent, Conversation, and routing logic real where
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
- When adding message handling, test Bot/Thread mapping, conversation
  separation, and reply destinations.
- Define and test what happens when messages overlap in the same Conversation;
  distinguish Conversation ordering from limits on concurrent agent executions.
- When adding persistence, verify recovery using a new instance reading the
  saved state, not only the instance that wrote it.
- When implementing retries or delivery recovery, test failures and the agreed
  duplicate-handling behavior. Keep these expectations explicit rather than
  assuming exactly-once delivery.

## Running and reporting

Run every new or modified test file and iterate until it passes. Use focused
runs during development, then follow the delivery checks in
[Development](development.md#validation-and-completion).

Ordinary tests use one test worker to limit contention among application processes,
SDK fixtures, and SQLite operations during local and CI verification.

Run live-service checks only when explicitly requested. Keep credentials out of
fixtures and output, and report live checks separately from ordinary validation.
An offline suite passing does not establish that a real provider or platform
connection works.
Missing human inputs or credentials leave actual-service acceptance open.

## Architecture verification

The following scenarios are covered through the current application boundaries.
Keep controlled-model, Docker and actual-provider evidence separate. Retire tests
with their obsolete contracts; do not preserve old mechanisms just to maintain
test counts.

Use the public API with real worker, Pi Durable and SQLite for integration.
Control model responses at the HTTP/stream boundary rather than mocking the
SDK scheduler or transcript. Use the built browser for owner-visible behavior
that lower boundaries cannot prove.

| Scenario | Required evidence |
| --- | --- |
| Startup and chat | Compiled startup, stable Bot/Thread association, streaming, reload and reconnect |
| Context and history | Actual model inputs show bounded background, valid current tool pairs, native compaction and original retrieval before/after reopen |
| Skills and memory | Public edits and real tool calls affect later context with the correct scopes |
| Computer | Real Docker shell/file agreement, persistent workspace through container replacement, concurrent Bots and export/import round trip |
| Steering, Stop and recovery | Native input behavior, visible withdrawn input, worker restart and actual command termination without stopping another Bot |

Prove context selection with native compaction and reopen before broad migration.
A request hook alone is insufficient. Verify cancellation against the actual
Docker process, not only a rejected host-side promise.

Ordinary checks need neither Docker nor personal credentials. Invoke Docker
integration separately with temporary resources and reliable cleanup; run it
for relevant provider changes. Real-provider end-to-end acceptance is a separate
opt-in gate. Record revision, model, commands, observed results and remaining
failures without secrets. Keep controlled, Docker and real-provider evidence
separate; old acceptance results do not establish the new architecture.

Install Chromium with `npx playwright install chromium` (or
`npx playwright install --with-deps chromium` on Linux). `npm run test:browser`
builds and checks the browser; `npm run verify` includes browser checks.
