# Multi-Bot controlled acceptance

This record covers the built client, public Host API, real SQLite/mailbox state,
real Pi SDK, and production Docker runner against controlled upstream services.
It does not establish actual provider or Telegram deployment acceptance.

## Reproduce the integrated journey

Use Node.js 24.21.0, install dependencies with `npm ci`, run `npm run prepare`,
and install Chromium with `npx playwright install chromium`. From the repository
root:

```sh
npm run build
npx playwright test tests/browser/product-acceptance.spec.ts
npm run verify
bash tests/workflow.sh
npm run test:infrastructure
```

The last command additionally requires Docker and `openssl`. It builds the
production image and creates temporary networks, gateway/database services,
synthetic credentials and controlled model/search upstreams. Tests remove their
temporary state, processes, listeners, containers, networks and volumes.
The built runner image remains available for another run.

The integrated browser flow uses
[`product-acceptance.spec.ts`](../tests/browser/product-acceptance.spec.ts) and
[`client-acceptance-host.mjs`](../scripts/client-acceptance-host.mjs). It:

1. Pairs with the Host and creates Researcher and Writer through rendered forms,
   with different roles and persistent Memory files.
2. Creates a one-shot Routine in Asia/Shanghai, disconnects the browser and
   restarts the Host after its due time. Exactly one occurrence Task/Run appears,
   with no implicit Thread background.
3. Requests an owned Writer delegation through the production runner mailbox.
   Researcher waits for an exact owner approval; Writer has no Task before it.
   A fresh Host restores the pending card, and the owner approves in the client.
4. Inspects source/target Bot and parent/child Task/Run links. Writer asks an owner
   question and waits. Another Host restart restores that question; answering
   continues the same child Run in a second Attempt.
5. Publishes a report, edits the working file, completes the child and resumes the
   same parent Run. The client inspects original inputs and both parent Attempts.
6. Observes approval and question notices sent through the real Telegram HTTP
   adapter to different Bot topics. A controlled HTTP 503 leaves the successful
   Routine outcome unchanged with its notice pending. A later Host restores and
   delivers that notice after backoff. The child's ordinary completion produces
   no redundant notice.
7. Reconnects after a fourth Host restart and downloads the original delivered
   report bytes, despite the later working-file edit. No duplicate occurrence is
   created. Desktop and narrow-screen checks retain usable controls and no
   horizontal overflow.

The browser and public API establish usable product coordination. This fixture
controls external execution with `MailboxDriver`; its placeholder continuation is
not SDK context evidence. Actual SDK recording, durable steering consumption,
same-Run reopening and complete tool results are established separately below.
Browser tests use loopback URLs with temporary ports and roots. Expected initial
unauthorized requests and intentional disconnect errors are distinguished from
application errors. Browser plugin not available; verification uses the existing
Playwright workflow with Chromium at 1280 × 900 and 390 × 844.

## Functional coverage matrix

All entries refer to executable tests, not claims inferred from fixture replies.
The ordinary suite includes controlled HTTP/SSE services; it requires no real
provider or personal-account credentials. Paths below are relative to `tests/`.

| Contract | Owning evidence | Outcomes and boundaries |
| --- | --- | --- |
| Pairing, local credential, Host/Origin and scoped reads/live events | `local-client.test.ts`, `browser/local-client.spec.ts` | Unauthorized access, cross-origin/Host rejection, reload and fresh-Host persistence |
| Independent Bot identity, role and durable configuration | `managed-bots.test.ts`, `bot-configuration.test.ts` | Invalid/duplicate requests, distinct same-name identities, no bootstrap overwrite |
| One Thread per Bot and append-or-subsequent Task admission | `thread-execution.test.ts`, `browser/local-client.spec.ts` | Completion/lost-response races, stable request identity, targeted queued additions, no implicit retry |
| Durable steering and Run context | `run-sdk.test.ts`, `thread-execution.test.ts` | Real SDK tool-boundary recording, queue-before-record crash, takeover, independent new Run, same-Run reopen, oversized required input rejection |
| Original history and scoped lexical retrieval | `history.test.ts`, `browser/history.spec.ts` | Chinese search, corrections, pages/cursors/offsets, source cutoff, forged scope/stale incarnation rejection, originals after real SDK compaction |
| Prospective chat reset | `chat-background.test.ts`, `browser/reset.spec.ts` | Existing queued/active Run boundaries retained; earlier originals require deliberate selection; workspace/Memory retained |
| Finite configuration barrier and protected Skills | `bot-configuration.test.ts`, `pi-resources.test.ts` | Pre-save steering cutoff, post-save same-Run Attempt, restart, incompatible model/invalid Skill failure, owner-only activation |
| Per-Bot file Memory | `bot-memory.test.ts`, `pi-memory.test.ts`, `browser/local-client.spec.ts` | Stale-save conflict, bounded core/detail access, current owner correction, in-flight request unchanged, compaction/reopening |
| Serial Bot execution and fair global admission | `admission.test.ts`, `thread-execution.test.ts` | One actual Attempt per Bot, four globally, other Bots progress, no preemption, interactive/background fairness, full tool batch before wait release |
| Run budgets and container reclamation | `run-budgets.test.ts`, `browser/budgets.spec.ts` | Sixty active minutes across Attempts/restart/steering, wait excluded, explicit retry budget, confirmed stop and immediate idle reclamation |
| Stop, cancellation and honest uncertainty | `thread-execution.test.ts`, `browser/stop.spec.ts` | Stop failure/restart, retained serial capacity until confirmed stop, unrelated work after confirmation, explicit retry/close and late evidence fencing |
| Scoped progress and selected results | `agent-progress.test.ts`, `browser/agent-progress.spec.ts` | Public result identities, incremental live state, ownership/fencing, complete retained evidence |
| Task attachments and explicit sharing | `task-attachments.test.ts`, `browser/task-attachments.spec.ts` | Task-only scope, deliberate workspace copy, unauthorized/path/size rejection, 25 MiB ceiling |
| Immutable delivered artifacts | `delivered-artifacts.test.ts`, `browser/delivered-artifacts.spec.ts` | Real SDK-created report, identical downloads after working edits and fresh Host, scoped access and configured size bound |
| Durable owner questions | `owner-questions.test.ts`, `browser/owner-questions.spec.ts` | Same-Run/new-Attempt answer, indefinite wait, explicit expiry, cancelled/stale answers, lost response/read-operation recovery, complete tool evidence |
| One-shot/cron Routines and timezone | `routines.test.ts`, `browser/routines.spec.ts` | Overdue once, independent occurrence context, targeted additions, no overlap/backlog, snapshot settings, timezone edits, real SDK commands |
| Routine lifecycle and explicit retry | `routines.test.ts`, `browser/routines.spec.ts` | Pause/resume/run-now/delete, failure/cancellation, held uncertainty, same-Task linked new Run, fresh budget, no retry overlap |
| Owned delegation and exact action approval | `delegations.test.ts`, `browser/delegations.spec.ts` | Directed deny/ask/allow, approval survives restart, denied/expired/stale payloads, parent waits and resumes same Run; real SDK continuation |
| Nested chain bounds and immediate revocation | `nested-delegations.test.ts`, `browser/nested-delegations.spec.ts` | Ancestor/third-edge rejection, eight-chain limit across restart/steering, necessary decisions, descendant cancellation, revoked uncertain work, real SDK revocation |
| Selected cross-Bot file copies | `cross-bot-file-transfers.test.ts`, `browser/cross-bot-file-transfers.spec.ts` | Exact approved attachments/artifacts, no ambient workspace sharing, changed same-size source requires new decision, scoped receiving copy after restart |
| Disablement and logical deletion | `bot-lifecycle.test.ts`, `browser/bot-lifecycle.spec.ts` | Immediate admission denial, confirmed stop/restart, no automatic revival, retained evidence/material, new identity for same-name replacement |
| Independent per-Bot Telegram delivery | `question-notices.test.ts`, `telegram-api.test.ts`, `host-telegram.test.ts`, `browser/question-notices.spec.ts` | Correct private-chat topics, 5s/30s/three-attempt accounting, retry-after, outages/restart, topic repair/resend, stale suppression, no chat/decision ingress |
| Root/collaboration notice policy | `question-notices.test.ts`, `browser/question-notices.spec.ts` | Routine outcome, requesting child attention and source links, child aggregation, ordinary-chat suppression, outcome independent of delivery |
| Mailbox completion, fencing and recovery | `mailbox-runner.test.ts`, `host-recovery.test.ts`, `reconcile-session.test.ts`, `host-delivery.test.ts` | Failed providers, hard-crash output gaps, bounded recovery, repeated tool effects, stale claims/late results and independent delivery |
| Integrated product journey | `browser/product-acceptance.spec.ts` | Built-client creation, Routine, owned approvals/questions, four restarts, same-Run continuation, inspectable links/Attempts, immutable download and notice outage recovery |

Normal, failed, cancelled, denied, expired, revoked, uncertain and restarted
outcomes belong to their owning rows. The integrated fixture does not replace
these negative/race tests or claim to exercise every policy through Docker.

## Evidence classes and execution record

Recorded October 21, 2026 on macOS arm64, starting from application base
`58019b4`. Versions: Node 24.21.0, npm 11.12.1, TypeScript 7.0.2,
Vitest 5.0.3, Playwright 1.64.1, Chromium 156.0.8078.4 (revision 1248),
Pi coding-agent/AI SDK 1.2.0, Docker Engine 28.5.1/Desktop 4.48.0,
production Bun 1.4.0, OpenSSL 3.6.3 and gateway 1.42.0 with SDK 2.2.1.
Container images and dependency versions are pinned in the Dockerfile, Compose
fixture and lockfile.

| Evidence class | Command | Outcome | Limit |
| --- | --- | --- | --- |
| Focused built-client flow | `npm run build` then `npx playwright test tests/browser/product-acceptance.spec.ts` | Passed | Controlled execution, real browser/API/SQLite/mailbox/Telegram HTTP; no real SDK or live platform in this fixture |
| Repeated integrated flow | `npx playwright test tests/browser/product-acceptance.spec.ts --repeat-each=3` | Passed: 3 consecutive runs | Expected intentional offline errors are accepted only during restart; application errors still fail |
| Complete offline validation | `npm run verify` | Passed: 412 tests in 51 files; 25 browser journeys | Formatting/lint/types, ordinary offline tests, workspace builds, compiled entry points and real-SDK demonstrations, all built-client browser journeys |
| Git guards | `bash tests/workflow.sh` | Passed | Isolated temporary repositories; no production services |
| Actual Docker/Pi/gateway | `npm run test:infrastructure` | Passed: 5 tests in 4 files | Production mounts, Bun/SQLite, real Pi tools/Run ledger, gateway injection/TLS, replacement/adoption/termination; controlled upstreams |
| Actual provider/Telegram deployment | Separate owner-participating acceptance | **Pending; not run here** | Requires separately selected actual-service work |

The infrastructure suite owns four files: `mounted-sqlite.test.ts` proves
cross-runtime mounted mailbox freshness; `protected-skills.test.ts` proves
read-only active Skill mounts versus writable proposals; `mailbox-gateway.test.ts`
proves tool effects, same-Run reopening, new-Run/cross-Bot separation, original
history calls, budget stop/reclamation, questions and Routine occurrences;
`web-gateway.test.ts` proves scoped search credential injection. All are under
`tests/infrastructure/` and excluded from ordinary discovery.

The initial infrastructure run passed four checks and failed the multi-exchange
model case; an unchanged focused rerun reproduced it. The SDK ledger reported
`Required Run input exceeds model capacity.` after the first exchange. The
controlled upstream recorded two authenticated requests, ruling out a failed
gateway injection or a malformed second upstream reply. That fixture's 32K
window could not retain the current production tool schemas plus earlier tool
evidence. Its declared model window is now 64K; production budgeting is unchanged.
The corrected full case passed, including later container replacement,
cross-Bot/new-Run isolation, questions, cron/one-shot occurrences and termination.
`npx vitest run tests/run-sdk.test.ts` separately retains the real-SDK oversized
input rejection and bounded-reference/steering assertions.

## Accepted limits and remaining deployment gate

Serial Agent execution within a Bot does not prevent owner or external processes
from editing that Bot's files concurrently. Cross-Bot workspace separation does
not provide general conflict-free merging. Durable steering consumption requires
SDK recording evidence, not admission into an in-memory queue.

[ADR 0008](adr/0008-mailbox-completion-and-recovery.md) still permits the separate
SDK/mailbox/output crash windows, uncertain missing final output, repeated tool
effects on recovery and duplicate platform delivery. These checks establish no
atomic completion or exactly-once effects.

[ADR 0009](adr/0009-direct-gateway-network.md) still allows runner access to the
gateway management listener with local administrative authority. Synthetic
credential injection and absent credential mounts do not establish per-Bot
credential-administration isolation. Direct internet/backend-database probes
and mount checks must be interpreted within that accepted gateway access.

Real-provider behavior, paid calls, personal-account topic setup and actual
Telegram receipt remain pending the separate owner-participating deployment
gate. The older single-Agent [runtime acceptance](runtime-acceptance.md) proves
only its recorded scope. It cannot be used as completion evidence for this
Multi-Bot product.
