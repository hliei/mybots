# Runtime acceptance

The default commands run one persistent host with CLI, owner-only Telegram and
owner-local WebSocket channels. Session containers run Pi and share the Agent's
working materials while retaining separate conversation histories.

## Ordinary offline verification

Use Node.js 24.21.0 and run `npm run verify`. Checks include formatting/lint,
host and runner types, all ordinary offline tests, both builds and compiled
host/CLI/runner startup checks. Controlled streaming services exercise the
real Pi SDK. Ordinary discovery excludes infrastructure and live test directories;
credentials in the environment never enable live traffic.

| Contract | Evidence |
| --- | --- |
| Three entry channels, overlapping inputs, shared files, observer/sender ownership and restart affinity | `tests/host-channels.test.ts` with real host/channels/mailboxes and a controlled execution boundary |
| Actual SDK tools, FIFO exchanges, explicit continuation, resource loading, compaction, cancellation and model failure | `tests/pi-provider.test.ts`, `tests/pi-resources.test.ts`, `tests/pi-web-tools.test.ts` with real Pi and controlled HTTP/SSE |
| Early completion and crash loss windows, repeated tool effects | `tests/mailbox-runner.test.ts` |
| Persisted output, finite delivery attempts, duplicate window and failure isolation | `tests/host-delivery.test.ts` with fresh host instances |
| Container adoption, fencing, bounded crash/stall recovery and exhaustion | `tests/host-recovery.test.ts`, `tests/reconcile-session.test.ts` |
| Owner rejection, protocol, reconnect and cleanup | `tests/host-telegram.test.ts`, `tests/websocket-channel.test.ts`, `tests/cli.test.ts` |
| Import safety, configuration failure and listener startup rollback | `tests/startup.test.ts`, compiled startup smoke checks |

## Controlled infrastructure

Run `npm run test:infrastructure` separately with Docker Desktop and `openssl`.
It exercises the actual Bun runner, mounted directional SQLite, Pi tool execution,
OneCLI proxy/TLS and scoped synthetic credential injection, including configured
web search. It also reopens the selected SDK conversation after container
recreation. See [container execution](container-runtime.md) for the topology,
fixture cleanup and trust exception. This is separate from ordinary verification.

## Actual-service acceptance

Use the [macOS actual-service procedure](macos-service-acceptance.md) for the
explicitly requested real DeepSeek/OneCLI/Docker/Telegram deployment pass. It
provides bounded input/reply checkpoints, CLI and WebSocket commands, read-only
continuation/delivery queries, credential-boundary checks, cleanup and an evidence
form. This is a manual opt-in procedure; no `test:live` command is provided.

### Completed acceptance: October 16, 2026

The required macOS actual-service gates are **passed**. A follow-up from 10:17
to 10:27 Asia/Shanghai completed the remaining Telegram reply and host-restart
continuity checks on the same saved installation and unchanged application code.
Together with the initial attempt below, this establishes P/M/K/C/T/W/H/X for
the inspected deployment. Earlier refused instructions, matching failures and
input deadlines remain recorded; they are not reclassified as successful checks.

The owner confirmed receipt of the first follow-up reply with the correct shared
file contents. SDK inspection showed that reply reused previously known content
without a new read tool call. To distinguish fresh reading from recall, CLI then
wrote a new random public value into the shared file. Host-side bytes were checked,
and the new value was verified absent from Telegram's pre-restart SDK history.
The conversation-only label was retained without writing it into the workspace.

After a clean host shutdown and restart, the owner's actual Telegram input asked
for the file contents and the previously supplied label, without including either
answer. The reply contained both the new file value and original label. The exact
received input and successful new `read` result were verified in the saved Pi
conversation. Host session ID and full Pi continuation were unchanged, the session
container ID was different, and output correlation, private-chat destination and
independent durable `delivered` acknowledgement all matched.

The guided input's final sentence terminator was omitted when copied. The strict
helper did not match it, producing bounded matching timeouts even though the
actual inbound/outbound pair was observed. Requested and received text were
preserved separately, and their only difference was verified to be that final
terminator. Validation used the exact received SDK input and its correlated
output; no message was resent to produce a pass. Future helper matching permits
outer whitespace and omission of that final terminator while preserving routing,
message correlation and the actual input. No model-output prefix is a protocol
requirement. The earlier `TG=` format failures remain in the initial record.

The follow-up used the same runner image and dependency lock as the initial
attempt: Node 24.21.0, Bun 1.4.0, Pi SDK 1.2.0 and OneCLI 1.42.0/SDK 2.2.1.
All 6 new gateway requests returned HTTP 200 with one scoped credential injection
for `api.deepseek.com:443`, with upstream TLS verification enabled. A further
scan of 18 persisted files, the live container configuration and diagnostic log
found neither the real model key nor the Telegram token. No additional ordinary
tests were needed for the documentation-only follow-up; the initial offline and
controlled infrastructure results below remain applicable to unchanged code.

The follow-up host, CLI/observer, session containers, gateway/database/proxy stack,
acceptance networks and shared test file were cleaned. Original credentials and
private evidence remain local. Receipt confirmation is recorded for the first
follow-up reply; post-restart delivery is established by the Bot API success path
and durable mailbox acknowledgement, without claiming a human read receipt.
The accepted hard-crash loss, repeated-tool-effect and duplicate-delivery limits
in [ADR 0008](adr/0008-mailbox-completion-and-recovery.md) remain unchanged.

### Initial partial attempt: October 16, 2026

The owner explicitly requested execution. The attempt ran from 09:56 to 10:12
Asia/Shanghai on October 16, 2026, against application commit `742e485` with
only documentation corrections in the working tree. It used a dedicated local
installation root and an isolated real-account gateway deployment. At the end of this initial attempt, acceptance was **incomplete**, with Telegram
response-format checks and post-host-restart Telegram continuity unverified or
failed as described below. The completed follow-up above closes the required
service-behavior gates without deleting this evidence.

| Gate | Actual result |
| --- | --- |
| P | Passed: macOS deployment, pinned installation, gateway and owner-private-chat configuration |
| M | Passed: DeepSeek via Pi/OneCLI completed real `write` and `bash` tools; shared file and actual CLI response matched |
| K | Passed for inspected surfaces: no model key in container configuration, 8 mounted-file checks, 22,641 exported container files or diagnostics; final scan of 16 persisted files also found no model key or Telegram token |
| C | Passed: stopped CLI container, same running host, new container, same host session and exact Pi continuation, correct original conversation-only value |
| T | Partial: actual Telegram input/replies, successful SDK `read`, correct shared contents and separate conversation histories passed; prescribed `TG=` response format failed |
| W | Passed: real WebSocket input/correlated output in a separate session; Telegram observations retained their Telegram destination and separate durable delivery acknowledgement |
| H | Partial: new host and new CLI/WebSocket containers retained exact session IDs, Pi continuations and conversation-only values; final exact Telegram input was not observed within 120 seconds |
| X | Passed: host/clients/session containers stopped; acceptance gateway/database/proxy stack and networks removed; shared test file removed |

Actual versions: macOS 26.3.1 arm64, Docker Desktop 4.48.0, Docker engine 28.5.1,
Node 24.21.0, Bun 1.4.0, Pi SDK 1.2.0, OneCLI gateway 1.42.0 and OneCLI SDK 2.2.1.
Model: `deepseek-chat`, endpoint origin `https://api.deepseek.com`. The locally
built runner image ID begins `sha256:dd4523407129`; the gateway image ID begins
`sha256:8d4a3300e915`. Full immutable IDs and the lockfile SHA-256 are retained
in private local evidence. All 12 observed gateway requests targeted
`api.deepseek.com:443`, returned HTTP 200 and recorded one credential injection.
Real upstream TLS verification remained enabled.

Bounded checkpoints and limitations:

- The first Telegram challenge was delivered, but the provider treated its
  synthetic random marker as a credential and refused the requested read/echo.
  The second explicitly public-fixture challenge completed the actual `read`
  tool and returned the correct file contents in prose, while refusing the
  `TG=` prefix. Both replies reached durable `delivered` state. The current
  sender awaits Bot API success without persisting platform message IDs; no
  platform-ID comparison or human read receipt is claimed.
- The final restart checkpoint announced an expected public conversation label
  and shared contents, without requiring a reply prefix. Its exact inbound text
  was not observed before the 120-second input deadline. This is an input-wait
  timeout; it establishes no Telegram post-restart recall and no new provider
  failure. A reply before restart cannot close H.
- An initial acceptance-helper restart failed before launching the new host
  because it parsed an empty optional Telegram secrets file while that channel
  was disabled. The helper was corrected to read secrets only for an enabled
  channel. Subsequent fresh-host CLI/WebSocket recall and persisted identity
  checks passed; the failed helper checkpoint remains recorded separately.
- Inspection of SDK user messages confirmed disjoint CLI/Telegram conversations
  under the same Agent. Telegram's successful read of the CLI-created file
  demonstrated deliberate workspace sharing. Model assertions alone were not
  used to establish either result.

`npm ci` and Node 24.21.0 `npm run verify` passed: checks/types, 154 tests in
20 files, all workspace builds and executable startup smoke checks. The separate
controlled `npm run test:infrastructure` passed 4 tests in 3 files. These results
remain separate from the real-service checkpoints.

Private source credentials and diagnostic session state remain local. Cleanup
removed this attempt's gateway-held credential with its disposable stack, while
preserving the owner's original token and model credential. No raw reasoning,
credential, platform identity or conversation transcript is included here.
This initial attempt required a later bounded Telegram reply and restart
checkpoint, completed above. Normal continuation does not remove the accepted
early-completion loss windows, repeated tool effects or duplicate delivery.

## Historical embedded-runtime evidence

The following dated evidence belongs to the retired execution path. Commands,
configuration and outcomes are historical and do not validate the current runtime.

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

The post-change live run waited for a fresh challenge and timed out before a
matching first input: exit 1, 1 failed, 1 unrelated case filtered out, 240.71
seconds. It adds no live pass or restart evidence. Both independent review axes
reported zero actionable findings for the matching change. The live process
exited and temporary acceptance data was cleaned.
