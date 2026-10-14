# Runtime acceptance

The CLI embeds the shared event runtime and starts a fresh session per launch.
The bot embeds the same runtime for Telegram and the local `/ws` interface.
Sources retain their Agent session across bot restarts. Follow-ups run in order
within a session; different sessions can run concurrently. Configuration reloads
apply between turns, with directory/channel/listener changes requiring restart.
See [configuration](configuration.md) for precedence and boundaries,
[session recovery](adr/0004-persisted-active-context.md) for append-only context,
and [outbound delivery](adr/0005-durable-outbound-delivery.md) for retry semantics.

## Offline verification

Use Node.js 24 and run `npm run verify`. This runs checks/types, ordinary tests,
build, and both compiled entry-point startup checks. No ordinary test contacts
DeepSeek or Telegram, even when credentials are configured. Watching and verify
exclude `tests/live/` explicitly.

| Contract or fault | Evidence |
| --- | --- |
| Configuration, Agent, Skill, legacy history and original reasoning/tool results | Independent [fixtures](../tests/fixtures/contracts/README.md), workspace-contracts/history tests |
| Event envelopes and persisted source binding | Literal `events.json` through runtime submission, observation and fresh history reader in runtime tests |
| Saved summary, stable IDs, malformed JSON, invalid-compaction fallback, interrupted tools without execution, idempotent repair | Recovery and source-routing tests; combined fresh-runtime case checks exact model input and absence of tool effects |
| Completion/outbound crash, pending projection repair, acknowledgement, chunk recovery, accepted-but-unrecorded duplicate window | Completion/delivery tests with fresh instances and controlled filesystem/transport faults |
| Follow-up ordering, session isolation, next-turn reload, request-only retry and shutdown cleanup | Runtime/configuration-reload/model-retries/CLI tests |
| Delivery exhaustion isolated by session, confirmed chunk boundaries and shutdown cancellation | Delivery/Telegram tests |
| Combined Telegram and WebSocket input | WebSocket integration test holds a Telegram turn, completes another source, then checks ordered Telegram follow-ups, destinations and all broadcasts |
| Local input validation, broadcast to all clients, reconnect affinity and bot lifecycle | WebSocket tests with real local connections; Telegram tests at the transport boundary |

Deterministic local faults establish error behavior. Successful public requests
establish connectivity and actual model continuation; neither replaces the other.

## Separate real-service commands

Configure DeepSeek in a local source Workspace as described in the
[README](../README.md). Set `MYBOTS_ACCEPTANCE_WORKSPACE` to its absolute path;
it defaults to `./workspace`. Each case copies effective model settings into a
fresh temporary Workspace with private configuration permissions. Source Agent
instructions, Skills, runtime data and history are not reused. Cleanup removes
temporary files after success or failure. Keep raw model responses and local
configuration out of published evidence.

Run the model/tool and compaction/restart cases:

```sh
npm run test:live -- tests/live/phase1.test.ts -t 'continues a real thinking|compacts with a real summary'
```

The first case checks fact recall, successful Skill/write/edit/read/bash exchanges,
paired IDs, original saved reasoning and a fresh history reader. The second uses
real archive turns and summary generation, checks append-only compaction and an
unchanged index, reopens the saved session, verifies saved context and IDs, and
recalls a fact from the removed prefix after restart. Thinking is forced on with
an 8,192-token output allowance and a 100,000-token context window.

Run actual DeepSeek through local WebSocket connections:

```sh
npm run test:live -- tests/live/runtime.test.ts -t 'continues real DeepSeek'
```

This executes `printf TOOL_CONFIRMED`, checks the tool result and saved reasoning,
compares inbound/outbound broadcasts received by two clients, restarts the runtime
and listener, reconnects with the same source, and requires fact recall in the
same session with unchanged original messages. WebSocket delivery is acknowledged
only after a connected client accepts the committed envelope.

For actual Telegram acceptance, create a bot through Telegram's
[BotFather](https://core.telegram.org/bots/features#botfather), save its token as
`channels.telegram.bot_token` in the local source configuration, and open a test
chat with it. A Telegram account alone does not supply a bot token. Use a bot and
chat you control, determine your numeric user/chat IDs, and stop other processes
polling that bot. The acceptance harness reads the token but admits only the
explicit test user/chat and challenge text, ignoring outer whitespace and an
optional final ASCII period. It does not start the production poller or process
unrelated messages. Polling can advance past unrelated updates,
so use a dedicated test bot.

```sh
MYBOTS_ACCEPTANCE_TELEGRAM_CHAT_ID=<test-chat-id> \
MYBOTS_ACCEPTANCE_TELEGRAM_USER_ID=<test-user-id> \
npm run test:live -- tests/live/runtime.test.ts -t 'receives actual Telegram'
```

Follow the two printed prompts in the test chat. Send the first exact challenge
to remember a generated fact. After its reply is accepted and acknowledged, the
harness restarts the runtime and prints the second prompt. Send that prompt only
then. Acceptance requires the same source/session, recalled fact, successful real
`sendMessage` responses and no remaining pending replies at each checkpoint.
The receive loop uses real `getUpdates` and passes the selected update through
`TelegramChannel.dispatch`, the same boundary used by the production poller.
The overall receive deadline is four minutes. Missing token or IDs fails the case
before contacting Telegram; it does not become a passing skip.

`npm run test:live` runs all live cases, including the earlier search/HTTP cases
and the interactive Telegram case. Focused passes establish only their named
coverage. They do not establish a completed real-service gate.

## Executed evidence: October 14, 2026

Commands below ran using `npm exec --yes --package=node@24.21.0 --` as the command
prefix. Evidence contains no keys, chat identifiers, user identifiers, raw
reasoning or source configuration.

Offline validation is recorded separately from live validation. Telegram
acceptance remains outstanding: the source Workspace has no bot token and the
user has not created a test bot or selected a test destination. No Telegram API
was contacted and no Telegram message was sent by this delivery.

Live checkpoints:

- The old compaction case failed because it asserted that compaction leaves the
  entire log unchanged. The implementation correctly appended its compaction
  record. The assertion now verifies the unchanged prefix and one appended
  compaction, plus recovery after restart.
- The updated raw-history assertion initially compared JSON property order;
  it now compares the original fields structurally without printing reasoning.
- A model generated an unsolicited relative file during an early archive run.
  That generated file was removed. Acceptance instructions now require explicit
  tool requests, absolute temporary paths and no tools during archive/recall.
  This checkpoint does not count as the final successful acceptance run.
- `npm run test:live -- tests/live/runtime.test.ts -t 'continues real DeepSeek'`
  passed: 1 case passed, 1 Telegram case filtered out, 3.80 seconds. Actual model
  tool continuation, two-client broadcast and restart/reconnect affinity passed.

The final offline and focused model results are recorded after completion below.

- Final focused model command:
  `npm run test:live -- tests/live/phase1.test.ts -t 'compacts with a real summary|continues a real thinking'`.
  Result: **2 passed, 2 filtered out**, exit 0. The cases took 10.11 and 14.96
  seconds. Model: `deepseek-flash`, endpoint origin `https://api.deepseek.com`.
  The successful run verified tools/Skills, original reasoning/results, actual
  summary generation, unchanged log prefix/index and fact recall after reopening.
- `npm run test:live -- tests/live/runtime.test.ts -t 'receives actual Telegram'`
  failed with the explicit missing-token/test-ID diagnostic, exit 1, before any
  Telegram request. This is an outstanding acceptance item, not a service pass.

Final offline command: `npm run verify` passed **482 tests in 21 files**, checks
and types, build, and both compiled CLI/bot startup smoke checks (exit 0).
Focused runtime/source-routing tests passed 49 cases; source-routing/WebSocket
checks passed 42 cases before the final recovery assertion refinement. Relative
documentation links and `git diff --check` passed. Temporary acceptance Workspace
inspection found zero leftovers. Search/HTTP checks were not rerun in this
delivery; their earlier live evidence remains in the separate acceptance record.

Overall runtime acceptance is **incomplete pending a successful complete Telegram
input/restart run**. The configured-service checkpoints below establish real
single-turn send/receive, with the restart checkpoint still outstanding. Delivered behavior and passing offline/model checks
do not waive that requirement.

Independent Standards and Spec reviews of the delivery found zero actionable
findings on each axis. The reviewers retained the missing actual Telegram flow
as an explicit acceptance limitation. The earlier acceptance guide's current
command and compaction description were updated to match persistence/restart;
its dated historical execution evidence remains intact.

## Configured Telegram checkpoints: October 14, 2026

The user configured the token and explicitly requested continued Telegram
acceptance. A real `getMe` succeeded. A user-sent setup message selected the
explicit test user/chat; identifiers remain in ignored local data and are omitted
here. No other local bot polling process was running. The source configuration
was read without modification, and acceptance used temporary runtime data.

The focused command used Node.js 24.21.0 and the source Workspace, with explicit
test user/chat IDs supplied as environment variables from ignored local data:

```sh
npm run test:live -- tests/live/runtime.test.ts -t 'receives actual Telegram'
```

- First configured run: real Telegram input reached DeepSeek; the ACK reply was
  accepted by Telegram and its durable acknowledgement cleared pending delivery.
  The runtime restarted successfully. The case then reached its four-minute
  deadline while waiting for an exact second input. Result: exit 1, 1 failed,
  1 unrelated case filtered out, 240.72 seconds.
- After the user requested a fresh attempt, the second run reached its deadline
  while waiting for an exact first input. Result: exit 1, 1 failed, 1 unrelated
  case filtered out, 240.74 seconds. This run adds no successful round trip.

These are input-wait timeouts, with no Telegram API or model error reported in
either run. The harness filters by the selected user/chat and exact challenge
text, so the evidence establishes absence of a matching input, rather than
proving no message was sent. Neither run passes the complete Telegram case.
Both processes exited and cleanup left no temporary acceptance Workspaces.
The earlier 482-test offline verification and focused DeepSeek/WebSocket passes
remain separate evidence; they were not rerun for this documentation update.

### Input-matching diagnosis

The user supplied the unacknowledged first challenge text. It omitted the final
ASCII period after `Reply ACK only`; the harness previously required exact text
equality and silently ignored that input. The receive predicate now trims outer
whitespace and permits the final period to be omitted, while retaining the same
user/chat and challenge-marker checks. This changes acceptance input handling,
not production Telegram routing. Ordinary verify after the change passed 482
tests in 21 files, checks/types, build and both compiled startup checks.
