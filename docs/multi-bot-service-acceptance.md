# Multi-Bot actual-service acceptance

Use this procedure for an explicitly selected, owner-participating macOS
deployment pass with the real provider and Telegram. The
[controlled acceptance record](multi-bot-acceptance.md) and older
[runtime acceptance](runtime-acceptance.md) establish their own scopes; neither
establishes this product pass. Ordinary `npm run verify` remains offline.

Recorded outcome: the owner accepted the October 21, 2026 actual-service journey
and its disclosed limits. The Host was stopped as requested; saved results and
the shared gateway/database were retained.

## Prerequisites and evidence

Record the selected installation root and owner-private Telegram chat privately.
The owner must explicitly select actual-service execution before paid calls or
account changes. Enable private-chat Threaded mode through BotFather's Mini App;
the configured token's `getMe` must report `has_topics_enabled: true`, as defined
in the [Telegram API](https://core.telegram.org/bots/api#user). A working
token alone is insufficient. Confirm the paired owner destination and that no
other Host or Telegram poller uses the installation or token.

Use the installed Node.js baseline and run `npm run verify` and
`npm run test:infrastructure` before the live journey. Record these as separate
controlled checks. Update the built Host, client and runner image together. Check
the internal runner network, gateway attachment, TLS trust and model-hostname
credential policy using [configuration](configuration.md) and
[container execution](container-runtime.md). Retain the accepted
[gateway management boundary](adr/0009-direct-gateway-network.md).

If the installation still contains the older multi-session model, follow the
documented [fresh-state transition](../README.md#persistence-and-reliability)
before starting. Never test by starting a competing Host against that database.
After cutover, preserve the newly created state across all acceptance restarts.
Re-establish Telegram pairing when the fresh store has no paired owner.

Keep raw evidence, credentials, account/chat IDs, SDK records and logs private.
Use the evidence handling and version commands in the
[macOS procedure](macos-service-acceptance.md#bounds-and-evidence). Record the
actual Node, npm, macOS, Docker Desktop/Engine, Bun, Pi SDK, OneCLI image/SDK,
runner image and provider/model/endpoint versions. Do not copy expected versions
as observations. Keep only reviewed, non-secret facts in a shared result.

Bound one attempt to 30 minutes, including owner input. Give model/tool
checkpoints 120 seconds and startup/shutdown checkpoints 30 seconds. Stop on the
first failed or blocked checkpoint, retain its evidence and label subsequent
gates not run. Never automatically resend an input after an unknown outcome.
A retry uses a new attempt marker and preserves the earlier result.

## Connected client journey

1. Open the installation's loopback Web UI and pair using its local connection
   credential. Create Researcher and Writer through the client, with different
   roles and Memory. Save Researcher's responsibility to retain source citations
   and Writer's preference for short paragraphs. Record their different Bot and
   Thread identities and inspect the saved settings.
2. Select Researcher and set its directed permission to Writer to
   `ask-each-time`. Leave the reverse direction denied. Prepare a small,
   non-secret source file in Researcher's workspace and record its exact bytes
   and digest. Give the Routine its relative path and Writer's actual Bot ID.
   Instruct Researcher to read that source, delegate a report using only selected
   source text, wait for the child and publish a correlated final summary.
   Instruct Writer to ask the owner which report style to use before writing and
   publishing `report.md` as a delivered artifact. Require the actual scoped
   tools; text that merely claims delegation, a question or publication is not
   evidence of those operations.
3. Through the client, create a one-shot Researcher Routine with an inspectable
   future instant and `Asia/Shanghai` timezone. Record its ID, due time and
   instructions. Disconnect the client and stop the Host before that instant.
   Restart the same installation before the due instant, keeping the client
   disconnected through admission. Once due, reconnect and verify exactly one
   occurrence Task with one Run, linked to that Routine and independent of
   direct-chat background. Keep a checkpoint within the attempt's time budget.
4. Observe the exact delegation approval in Researcher's Task, including target
   and inputs. Confirm the parent waits, the child has not run prematurely, and
   Researcher's Telegram topic receives the decision notice. Restart the Host
   while the approval is pending, reconnect and verify that it remains pending.
   Have the owner inspect and approve it in the local Web UI. Record the actual
   decision; ordinary chat and Telegram replies do not approve it.
5. Inspect Writer's owned child Task/Run and its parent/source links. Observe the
   required style question, Writer's waiting state, and a notice in Writer's
   distinct topic in the same private chat. Reconnect or restart while the
   question is pending. Have the owner answer using its correlated Web control.
   Verify that Writer continues the same Run in a later Attempt, retaining valid
   recorded tool results and the answer rather than repeating known effects.
6. Observe Writer's published summary and report, child completion, and
   Researcher's continuation in its original Run with a later Attempt. Confirm
   the root completes only after owned children and necessary decisions settle.
   Inspect Attempts and runtime activity for serial execution within each Bot;
   do not infer the global scheduling policy from this one dependency chain.
7. Download the delivered report and record its byte count and SHA-256 digest.
   Change only its working copy, then reconnect/restart and download the same
   delivered artifact again. Compare exact bytes and digests. Inspect paginated
   Thread originals, history search/read, Run input/tool evidence, source links,
   summaries, statuses and saved/effective configuration. Record which history
   operations were actually exercised.
8. Confirm eligible root completion and decision notices reach the matching Bot
   topics. Inspect each notice's delivery outcome separately from Task outcome,
   including attempt count and failure/resend state when applicable. An API
   delivery acknowledgement does not establish human reading or duplicate-free
   delivery. Ordinary child success should aggregate into the root report.

## Failure, cancellation and shutdown

Record actual failure observations and their scope. For supplemental cancellation,
start separate bounded work, stop it in the client and verify confirmed execution
termination, retained evidence and any owned descendant/request settlement.
Do not report rollback of prior file or external effects.

If notification outage testing is selected, disrupt only this installation's
notification access, retain a successful work outcome and observe independent
bounded delivery failure. Restore access and use the client resend control;
record whether the notice is accepted without rerunning successful work. Do not
stop shared gateway/database infrastructure or other account users to induce a
failure. An unexercised failure case remains explicitly unverified; controlled
test coverage is a separate evidence class.

Finish by stopping acceptance-owned execution, clients and the Host within the
shutdown deadline, unless the owner requests continued operation. Confirm the
owned session containers stopped. Retain results and new-model state for owner
inspection; record every retained resource. Keep the shared gateway/database
running. Retain known crash-output gaps, repeated-effect risk, possible duplicate
delivery, owner/external file races and uncertain outcomes as limitations.

## Result form

For each gate use `passed`, `failed`, `blocked` or `not run`, with timestamps,
elapsed time and direct evidence. Retain stable aliases for account identifiers.

| Gate | Required evidence |
| --- | --- |
| P | Owner selection, installation/version identity, provider prerequisites, paired private chat and enabled Topics |
| B | Client-created distinct Bots/Threads, roles/Memory and directed policy |
| R | Routine due time, disconnect/restart and one correlated occurrence Task/Run |
| D | Exact owner approval, owned child, correct topic notice and durable parent wait |
| Q | Durable child question, owner Web answer and same-Run/new-Attempt continuation |
| O | Settled dependencies, parent continuation, serial Bot execution and terminal summaries |
| A | Reconnected history/source/Attempt inspection and identical delivered bytes after working edit |
| N | Correct topics and independently inspected delivery results |
| F | Actual failure/cancel/restart observations, uncertainty and unexercised cases |
| X | Confirmed shutdown, retained results/state and cleanup outcome |

Record overall status and the owner's explicit acceptance with a timestamp and
scope. Missing owner acceptance or any required unverified gate leaves overall
acceptance incomplete. Procedure preparation alone does not resolve acceptance.

## October 21, 2026 initial preflight

Initial status: **blocked before the connected journey**. The topic prerequisite
was subsequently cleared; the connected journey is recorded below.
The owner explicitly selected actual-service work. Read-only Telegram `getMe`
succeeded, but reported private-chat Topics disabled. Owner BotFather setup and
confirmation of the existing private-chat destination were requested. The owner
confirmed that destination; subsequent raw API checks still reported Topics
disabled, so BotFather Mini App setup assistance was provided. No topic
was created, message sent, or paid provider call made during this preflight.

The installed Host was stopped, with a legacy schema 7 store containing two
sessions. No runtime state was deleted or changed. Fresh-state setup, current
provider access, pairing confirmation and every connected-journey gate remain
unverified. Docker and the existing OneCLI containers were running.

Observed environment at 05:55 UTC: macOS 26.3.1 arm64, Node 24.21.0, npm 11.12.1,
Docker Desktop 4.48.0/Engine 28.5.1, Pi coding-agent/AI 1.2.0, OneCLI 1.42.0
with SDK 2.2.1, and Playwright 1.64.1. Configured provider/model is DeepSeek
`deepseek-chat` at `https://api.deepseek.com`; access has not been exercised.
Application base is `1aad2e9b71542079eb4f6d32c795e478a766992c`. The runner was
rebuilt from that source during the controlled infrastructure check; its final
image ID is `sha256:e2ad41e1af0d26d388947a811bfbbc6cfa13265b89b5b05d6b8f5f214376aabd`.
The image reports Bun 1.4.0 when run without networking; no live Agent Attempt
has run. Private preflight metadata and validation logs are retained under the
installation's ignored `workspace/multi-bot-acceptance/` directory.

| Gate | Status | Observed result |
| --- | --- | --- |
| P | Blocked | Owner confirmed the existing private chat; Telegram Topics still disabled in raw getMe checks; old-state transition and current provider access not performed |
| B, R, D, Q, O, A, N | Not run | No live client/Agent/delegation/notification journey started |
| F | Not run | No live failure, cancellation, restart or uncertainty case exercised |
| X | Not run | No live Host/session execution was started; no acceptance topic/message/account resource was created |
| Owner acceptance | Pending | No owner acceptance statement received |

Separate controlled validation on this source:

- `npm run verify`: passed, including 412 ordinary tests in 51 files, workspace
  types/builds, compiled startup checks and 25 Chromium journeys. No live
  provider or Telegram evidence is implied.
- `npm run test:infrastructure`: four tests passed and one failed. At
  `tests/infrastructure/mailbox-gateway.test.ts:610`, the next cron occurrence
  was `null` instead of `2026-10-22T08:00:00.000Z` after an occurrence succeeded.
  This failure was retained for diagnosis; the infrastructure gate did not pass
  on this invocation.
- An unchanged focused rerun with `npx vitest run --config
  tests/infrastructure/vitest.config.ts tests/infrastructure/mailbox-gateway.test.ts`
  passed. The inconsistent outcome remains unexplained; this does not replace a
  successful complete infrastructure run. Both logs are retained. Fixture
  containers/networks were removed, leaving the existing shared OneCLI and
  PostgreSQL containers running and the rebuilt runner image available.
- A subsequent complete `npm run test:infrastructure` invocation passed all
  five tests in four files. This clears the controlled infrastructure
  prerequisite while retaining the earlier inconsistent cron observation for
  follow-up. It does not establish a real-provider or Telegram deployment pass.

## October 21, 2026 actual-service journey

Attempt `MBF-LIVE-20261021-A` started at 06:05:59 UTC on the owner's local
installation. The owner confirmed the existing private chat and enabled Threaded
mode in BotFather's Mini App. A fresh `getMe` returned Topics enabled before
execution. The earlier state was replaced under the fresh-state contract;
configuration, selected owner destination, credentials, client credential and
existing workspaces were retained. The new store reports schema 27. No old Run
or session was imported.

The installed launchd service uses Node 24.21.0 and serves the built client at
`http://127.0.0.1:8787/`. The deployed runner image and versions are recorded in
the preflight above. Actual parent, child and cancellation ledgers each contain
one Pi session file and identify `deepseek/deepseek-chat`; ten assistant responses
were observed across those ledgers. The provider's server build is not exposed.
These were real model requests through the existing OneCLI credential gateway,
not controlled model responses. The selected model-host credential was granted
to the two new Bots without replacing its value.

The source material was deliberately synthetic: 12 apple trees labelled `[S1]`
and 8 pear trees labelled `[S2]`. Researcher read its `source.txt` and passed
selected source text to Writer. Writer did not receive Researcher's workspace;
its final response explicitly distinguished the inline source from an absent
local source file. This pass does not establish live web-research behavior.

| Gate | Observed actual-service evidence |
| --- | --- |
| P | Owner selection, chat confirmation and Topics enablement; service/model/image identities recorded; real DeepSeek execution succeeded |
| B | Client-created Researcher/Writer retained different roles and Memory; Researcher-to-Writer policy was ask-each-time, reverse denied; settings survived restart |
| R | One-shot due at 06:08:51 UTC (14:08:51 Asia/Shanghai); browser disconnected; Host PID changed and was ready at 06:07:42 UTC; exactly one independent occurrence Task/Run admitted |
| D | Real delegate tool requested `orchard-report`; parent waited and Writer had no child before approval; Researcher notice delivered; pending approval and parent Run survived Host restart; owner saw notice and approved in Web UI at 06:12:38 UTC |
| Q | Writer asked `owner-report-style`; its separate topic received the notice; pending question and child Run survived another restart; owner confirmed receipt and answered in Web UI at 06:14:49 UTC |
| O | Writer succeeded at 06:15:01 UTC and Researcher then resumed and succeeded; each retained one Run with two ended Attempts; question answered, approval executed and delegation succeeded before root completion; same-Bot Attempt intervals did not overlap |
| A | Client inspected Run inputs and both Attempt identities; complete public Run history required four parent pages and three child pages; direct-chat original search and surrounding reading passed; report download stayed identical after working-file edit, reconnect and another Host restart |
| N | Researcher approval and root outcome notices delivered in one attempt each; Writer question delivered in one attempt in a distinct topic of the same private chat; ordinary child success produced no separate outcome notice |
| F | Separate real chat Task reached a question wait and was stopped through the client; outcome cancelled and pending question cancelled; source/result evidence retained |
| X | Owner-requested `mbt exit` completed; Host listener/ownership lock and session containers absent; shared gateway/database and saved results retained |
| Owner acceptance | Owner explicitly accepted the tested scope and disclosed unexercised cases, and requested Host shutdown; acceptance/cleanup recorded at 06:23:26 UTC |

The owner's report preference was concise short paragraphs retaining the source
labels. Writer delivered `report.md`, 403 bytes, including the exact total
20 trees. Downloads before and after working-copy modification and restart had
SHA-256 `c7fff43dedf223930daa6692e37652b1d17ac17f1620422dbd14d92d85e6f57f`.
The working copy intentionally contains a later revision; the delivered snapshot
and both downloaded copies retain the original report.

The browser used the installed Playwright/Chromium because the Browser plugin
was unavailable. Desktop 1440-by-1000 and a 390-by-844 viewport rendered the
question control without application errors; the narrow viewport had no
horizontal overflow. Later client download/history/cancel journeys also
reported no application errors. Screenshots remain private local evidence.

Observed limits and diagnostic corrections:

- An inspection helper's first read after an intentional restart reused a stale
  connection and returned `ECONNRESET`. A new authenticated connection confirmed
  the same waiting Run and approval. No mutation or model input was resent.
- An initial helper incorrectly expected background delegation input in direct
  Thread search. That search correctly covers chat originals. Background input
  and tools were inspected in Run history; the independent cancellation Task's
  original was then searched and read through the client. No product change was
  made to blur those scopes.
- Public Run evidence retains paired calls/results. The main journey recorded
  one delegate, one question and one report write, with one result publication
  per main Run. This observation does not establish exactly-once execution.
- No live hard crash, uncertain-effect recovery, notification outage/resend,
  topic deletion/repair or deliberately repeated platform delivery was induced.
  Their controlled coverage remains separate. Notice acceptance is not a human
  read receipt; the owner's receipt confirmations apply only to the two notices
  they explicitly acknowledged.

The procedure used `bin/mbt start` and `bin/mbt exit` for installed-service
lifecycle, the built Web UI for Bot/Memory/policy/Routine creation and decisions,
and authenticated public reads/downloads for retained evidence. Temporary
Playwright helpers drove the real client without replacing execution, the
scheduler, the SDK, containers, the gateway or Telegram. Private metadata,
public snapshots, downloaded reports, SDK metadata counts and lifecycle logs
remain under `workspace/multi-bot-acceptance/`; SDK originals remain in the
new runtime's Run directories. No raw account identifiers, credentials or
model reasoning are included here.

Final outcome: **accepted within the recorded actual-service scope**. The owner
participated in topic setup, receipt checks, approval and question handling, then
explicitly accepted the result. Shutdown completed within its 30-second bound.
The installation retains Researcher/Writer, their directed policy and scoped
gateway grants, private-chat topics, new-model history, original delivered
snapshot, both matching downloads and the deliberately changed working copy.
Only the pre-existing OneCLI and PostgreSQL containers remain running. Temporary
execution and browser resources were closed; private screenshots and the client
procedure were retained with the evidence. No application or test code changed.
