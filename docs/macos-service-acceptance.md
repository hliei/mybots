# macOS actual-service acceptance

For the current Bot/Thread/Task/Run product gate, use the
[Multi-Bot actual-service procedure](multi-bot-service-acceptance.md). The
CLI/Telegram conversation checks below cover the earlier single-Agent runtime;
Telegram now receives notifications and does not admit ordinary conversation
or approval decisions. Those earlier checks cannot establish current product
acceptance.

This procedure validates the owner's deployed host, Docker runner, OneCLI,
DeepSeek and Telegram, with CLI and local WebSocket access. It is opt-in: run
it only after an explicit request to use the real services and send messages to
the selected owner's private chat. Ordinary `npm run verify` never runs it.
There is no `test:live` command. A procedure delivery is not a deployment pass.

Use [host setup](host-runtime.md), [configuration](configuration.md), and
[container execution](container-runtime.md) for the deployed configuration.
Use an owner-approved installation root and private test chat. A dedicated fresh
root is preferable; restarting an existing installation interrupts its clients.
Never run a second host or Telegram poller for the same root or bot.

## Bounds and evidence

Allow 30 minutes for one attempt, including operator input. Each model/tool
checkpoint has a 120-second deadline; each exact Telegram input has 120 seconds
for the human to send it followed by 120 seconds for its reply. Allow 30 seconds
for a listener connection or shutdown.
When matching guided human input, permit outer whitespace and an omitted final
sentence terminator only. Preserve requested and received text separately, and
verify the exact received input in SDK history plus output correlation. A format
mismatch must not be reported as absence of all Telegram traffic. Use a visible timer and stop at the first
failure or deadline. Do not resend timed-out inputs automatically: execution may
have completed or effects may already exist. Record failure, blocked prerequisites,
and unattempted gates separately. A later retry is a new attempt with new markers.

Keep private notes in the ignored `workspace/` directory with mode 0700 and files
mode 0600 (`umask 077`). Do not publish raw configuration, Docker inspection,
process environments, gateway responses, mailbox dumps, Pi transcripts, chat/user
IDs, proxy identities, credentials, or reasoning. Collect only bounded metadata
and the synthetic challenge/result facts below. Review any log before sharing.

Copy this evidence form into the private notes before starting; use `not run`,
`blocked`, `failed`, or `passed` for each gate. A failure needs its checkpoint,
UTC timestamp, elapsed time, sanitized diagnostic and cleanup outcome. Missing
credentials, authorization or exact human input are blocked gates, not passes.

```text
Attempt / UTC start / UTC finish:
Explicit live-service authorization and selected private-chat confirmation:
Repository commit / clean or modified / package-lock.json SHA-256:
macOS version / architecture / Node / npm:
Docker Desktop version / Docker engine version:
Runner image ID / repo digest (or local build commit) / Bun version:
OneCLI version / immutable image ID or digest / SDK version:
Pi SDK version / configured DeepSeek model ID and endpoint origin:
Gate                         Status     Elapsed   Sanitized evidence or reason
P prerequisites
M model and workspace tools
K credential and mount boundary
C container recreation and continuation
T Telegram reply and conversation separation
W WebSocket input, events and delivery ownership
H host restart and all destination affinities
X cleanup
Private session aliases: CLI=A, Telegram=B, WebSocket=C
For each alias before/after: same host session? same pi: continuation?
For each reply: input/output aliases, correlation correct, delivery state:
Failures / unverified gates / follow-up owner:
Overall: incomplete until every required gate passes in this deployment
Accepted limits: early-completed queued work/final reply can be lost;
unfinished retries can repeat tool effects; delivery can duplicate.
```

Record actual versions rather than copying expected versions. From the checkout,
these local commands collect non-secret version metadata:

```sh
sw_vers
uname -m
node --version
npm --version
git rev-parse HEAD
shasum -a 256 package-lock.json
docker version --format '{{.Server.Version}}'
docker image inspect mybots-agent:mailbox --format '{{.Id}} {{json .RepoDigests}}'
npm ls @earendil-works/pi-coding-agent @earendil-works/pi-ai @onecli-sh/sdk
```

Record Docker Desktop's version from its About dialog and OneCLI's deployed
version/image identity from the operator's deployment record. Record Bun with
`docker exec "$ACCEPT_CONTAINER" bun --version` once a runner exists. Current
repository baselines are Node 24.21.0, Bun 1.4.0, Pi SDK 1.2.0 and OneCLI SDK
2.2.1; the controlled gateway fixture uses OneCLI 1.42.0. An unrecorded dependency
version leaves P incomplete.

## P: prerequisites and startup

1. Confirm macOS, Docker Desktop availability and the approved live request.
   Complete `npm ci`, `npm run verify` and the separate controlled
   `npm run test:infrastructure` before the live attempt; record their results
   separately. Neither result establishes any live gate.
2. Build the runner with `docker build -t mybots-agent:mailbox -f
   container/Dockerfile .`. Connect the local OneCLI container directly to
   the runner's internal network with its configured proxy alias. Check `docker network inspect mybots-isolated
   --format '{{.Internal}}'` returns `true` if using the example network name.
   Keep PostgreSQL on its separate backend network. Accept and record the
   [management access boundary](adr/0009-direct-gateway-network.md). The infrastructure
   fixture is disposable controlled infrastructure, not a real-account deployment.
3. In the owner's private gateway administration interface, configure the
   DeepSeek bearer credential for exactly the configured model endpoint hostname,
   with policy permitting the selected model operation. Do not disable upstream
   TLS verification for the real endpoint. Do not copy real keys into `host.json`,
   Agent instructions, shared files, environment inherited by the runner, or chat.
   Missing credentials/policies/topology block P; account provisioning is separate.
4. Use `examples/host/host.json` as a fresh-root configuration reference. Configure
   the chosen DeepSeek model, `read`, `write` and `bash` tools, CLI `terminal`,
   WebSocket `desktop`, and Telegram `owner-chat` destinations. Follow the exact
   owner identity, private `platformId`, and instance contracts in
   [Telegram setup](host-runtime.md#telegram-private-chat). Put `TELEGRAM_BOT_TOKEN`
   and optional `ONECLI_API_KEY` / `ONECLI_PROJECT_ID` in the install-root `.env`.
   The host reads that file itself. Do not print their values or put them in
   shell command arguments or history.
5. In each terminal set `ACCEPT_ROOT` to the same absolute approved installation
   path. Run `npm start -- --root "$ACCEPT_ROOT"` in a foreground terminal; retain
   that terminal for shutdown. Within 30 seconds verify the CLI socket and local
   WebSocket connection below. Keep the CLI connected while awaiting its replies:
   `npm run mbt -- --root "$ACCEPT_ROOT"`. Do not pipe one message followed by EOF;
   disconnected CLI output has no guaranteed replay.

## M and K: actual model, tools and credential boundary

Choose new random synthetic values for `CLI_PRIVATE` and `SHARED_VALUE`, and a
unique relative filename such as `acceptance-<attempt>.txt`. Substitute placeholders
before sending. Do not reuse historical challenge values. These are public synthetic fixtures,
never real passwords, keys or other secrets. Explain that distinction to the
model if needed, and record any refused instruction as a failed checkpoint.
In CLI send:

```text
Remember CLI_PRIVATE=<random value> only in this conversation; never write it
into a file or command. Use write to save exactly <SHARED_VALUE> in
/workspace/group/acceptance-<attempt>.txt, then use bash to read that file.
Reply with exactly FILE=<SHARED_VALUE>. Do not access any other files or network.
```

Send the multiline text as one line in the CLI. Pass M only when the actual
DeepSeek operation succeeds through OneCLI, the Pi transcript privately confirms
the requested tool round, the host-side shared file has the exact contents and
the CLI receives the expected final response. Correlate the gateway's successful
model operation with this attempt using sanitized time/status metadata. Do not
record gateway headers, full request/response bodies or raw reasoning.

Find this CLI session and its container using the read-only metadata queries
below. Inspect its fixed mounts and security configuration privately against
[the mount contract](container-runtime.md#persistence-and-mount-ownership).
The central host database, host config, Telegram token, gateway management key
and Docker socket must be absent. The runner has only its session, shared Agent
workspace, immutable context and public CA mounts, and an internal proxy route.
Its model authentication is the `gateway-managed` placeholder plus scoped proxy
authentication; the provider's real key remains gateway-owned.

For K, the owner must also compare the actual model credential privately against
runner-visible environment, mounted files (including context/mailboxes/Pi state),
image contents and diagnostics, using a trusted host-side inspection. Never ask
the model to search for or print a key, or copy the key into `docker exec` or a
runner file to perform that comparison. Store only match/no-match and inspected
surfaces. Mount/environment-name inspection alone does not establish key absence;
if the owner cannot complete the comparison, leave K unverified. A match fails K:
stop acceptance, revoke the exposed key through its owner, and retain no secret
in the evidence.

## Read-only checkpoint metadata

Use the system `sqlite3` with read-only access; never edit the live stores. These
queries omit message content and platform IDs. Session IDs and continuations stay
in private notes; publish stable aliases and equality results only.

```sh
sqlite3 -readonly -cmd '.timeout 5000' "$ACCEPT_ROOT/data/host.db" \
  'SELECT id,agent_group_id,messaging_group_id,container_status FROM sessions ORDER BY messaging_group_id;'
```

Set `ACCEPT_SESSION` to one returned session ID and `ACCEPT_AGENT` to its returned
Agent group ID. Record the destination-to-session mapping. All three sessions
must have the same Agent group and different session IDs. In fresh example
configuration the Agent group is `personal`. Set the mailbox path and query:

```sh
ACCEPT_SESSION_DIR="$ACCEPT_ROOT/data/sessions/$ACCEPT_AGENT/$ACCEPT_SESSION"
sqlite3 -readonly -cmd '.timeout 5000' "$ACCEPT_SESSION_DIR/outbound.db" \
  "SELECT value FROM session_state WHERE key='continuation';"
sqlite3 -readonly -cmd '.timeout 5000' "$ACCEPT_SESSION_DIR/outbound.db" \
  'SELECT id,in_reply_to,kind,channel_type FROM messages_out ORDER BY seq;'
sqlite3 -readonly -cmd '.timeout 5000' "$ACCEPT_SESSION_DIR/inbound.db" \
  'SELECT id,status FROM messages_in ORDER BY seq; SELECT message_out_id,status FROM delivered;'
docker ps --filter "label=mybots-session=$ACCEPT_SESSION" --format '{{.ID}}'
```

Set `ACCEPT_CONTAINER` to that single container ID. Repeat the queries for each
checkpoint/session. An inbound completion is not a delivered reply. Require the
matching output's `delivered` row with status `delivered`, its correct channel
and `in_reply_to`, and actual client/chat receipt. If an operation is busy, wait
within the checkpoint deadline, then fail rather than disabling mailbox locks.

## C: container recreation without host restart

After the CLI reply, wait until all inputs and outputs have settled; no active
tool/query may be interrupted for this normal-continuation gate. Record A's host
session ID, exact `pi:` continuation and container ID. Stop only that confirmed
container with `docker stop --time 5 "$ACCEPT_CONTAINER"`. Within 30 seconds
verify it is stopped. Keep the host running. Send this exact substituted CLI input:

```text
Without using tools, reply with only the CLI_PRIVATE value I gave you earlier.
```

Within 120 seconds require the original private value, the same host session and
same exact continuation, a different running container ID, and correct reply
correlation/delivery. Do not supply the value again or retrieve it from the shared
file. A successful new conversation or file read cannot pass C.

## T and W: Telegram and WebSocket

Before sending Telegram input, open the bounded local observer in a terminal.
The following Node client prints event content and routing metadata into private
terminal output. It closes after eight minutes or Ctrl+C.
Do not run it on an installation carrying unrelated private traffic.

```sh
node --input-type=module <<'JS'
const socket = new WebSocket('ws://127.0.0.1:8787/ws');
const deadline = setTimeout(() => socket.close(), 480_000);
socket.addEventListener('open', () => {
  console.log('connected');
  socket.send(JSON.stringify({ type: 'input', destination: 'desktop',
    content: 'Without tools, reply with exactly WS_OK.' }));
});
socket.addEventListener('message', event => console.log(event.data));
socket.addEventListener('error', () => {
  console.error('WebSocket connection failed');
  process.exitCode = 1;
  socket.close();
});
socket.addEventListener('close', () => clearTimeout(deadline));
process.once('SIGINT', () => socket.close());
JS
```

Adjust only the configured loopback port/path/destination if needed. Within
120 seconds require `inbound` then correlated `outbound` for `desktop` with
`WS_OK`, `kind=message`, correct session/destination/channel and persisted delivery.
Record actual frame fields against [the protocol](host-runtime.md#local-websocket-interface).
An `error`, `failure` or `kind=error` is a failed checkpoint. Frames contain
private routing IDs; do not publish the raw terminal transcript.

In the configured owner's bot private chat, send this exact substituted text
within 120 seconds (single message, no punctuation changes):

```text
These are public synthetic acceptance fixtures, not credentials or secrets.
Remember the conversation label <different random label> for a later continuity
check; keep it in this conversation, not in a workspace file. Please use read to
read /workspace/group/acceptance-<attempt>.txt and report its contents.
```

Within another 120 seconds require the exact `SHARED_VALUE` in the reply in that same private chat,
Telegram inbound/outbound observations with correct correlation and destination,
and a durable `delivered` row for that Telegram output. The WebSocket observation
is evidence of observation only; Telegram receipt and its mailbox acknowledgement
are required independently. Its session B must differ from CLI A and WebSocket C.
In CLI, ask for `CLI_PRIVATE` again without tools; require its original value.
Privately inspect each Pi conversation's user inputs: A must not contain the
Telegram challenge and B must not contain the CLI challenge. This and the shared
file read establish separate conversations accessing deliberately shared material.
Do not judge isolation solely by a model claiming it cannot recall another chat.
Require an actual successful `read` tool result in B's Pi transcript, rather than
only a claim that the file was read. Natural prose containing the exact expected
file contents is sufficient; no protocol requires a model-generated reply prefix.
If a previous format check failed, retain that result separately and announce
these content/tool expectations before attempting a new checkpoint.

Record C's continuation too. In the next WebSocket query, request that it remember
a third random `WS_PRIVATE` without tools/files and reply `WS_SAVED`; use the same
client snippet with only `content` changed. Complete that reply before H.
Reconnect the observer if its eight-minute bound expires; there is no event replay.

## H: new host and saved conversations

1. After every reply is delivered, use CLI to write a new random public
   `RESTART_SHARED_VALUE` into the same shared file. Verify the host-side bytes
   exactly, and confirm this new value is absent from Telegram's prior SDK
   messages. Keep Telegram's conversation-only label unchanged. This makes the
   next read distinguishable from a model repeating previously known contents.
   Record A/B/C session IDs and exact continuations. Quit CLI. Ctrl+C the host in its own terminal; require process exit, closed
   listeners and stopped session containers within 30 seconds. This is a clean
   restart test. Do not kill during an active query or delete any persistent state.
2. Run `npm start -- --root "$ACCEPT_ROOT"` again with the same private host
   environment/configuration. Reconnect CLI and the observer. The observer snippet
   submits a new `WS_OK` turn; this is live traffic, not replay.
3. In CLI send exactly `Without using tools, reply with only the CLI_PRIVATE value I gave you earlier.`
   In Telegram send exactly `Please read /workspace/group/acceptance-<attempt>.txt, report its contents, and tell me the public conversation label I gave you earlier. Do not change any files.`
   Each must arrive within its 120-second input/reply bounds at its original entry.
   Substitute only the filename, not the expected values, in these inputs.
   Telegram must return both the original random label and exact new
   `RESTART_SHARED_VALUE`, with a new successful read tool result; file reading alone cannot
   establish conversation recall. CLI must return its original private value.
4. Use the WebSocket snippet with `content` set to `Without using tools, reply with only the WS_PRIVATE value I gave you earlier.`
   Require its original value and correlated frames within 120 seconds. Compare
   A/B/C host IDs and exact `pi:` continuations against the pre-stop records;
   all must be unchanged. Confirm new containers and each output's own channel,
   correlation, destination receipt and durable delivery acknowledgement.

Only post-restart exact recall plus persisted identity/correlation evidence can
pass H. A pre-restart reply, offline fixture, new session, marker supplied again,
or reading the shared file is insufficient. On timeout record the exact expected
synthetic input, whether it was observed, and the last completed checkpoint.

## X: cleanup and completion

Disconnect CLI/observers and stop the acceptance-owned host, waiting up to 30
seconds. Inspect remaining containers for the recorded session IDs only; resolve
failed cleanup before reusing the root. Do not prune Docker or stop other services.
Remove only this attempt's shared file after inspection. Keep private evidence
and session state for diagnosis unless the owner approved deleting a disposable
root. Leave owner-managed OneCLI, Docker networks, bot settings and credentials
under their existing lifecycle. Record any remaining resource and its owner.

Mark the deployment accepted only when P/M/K/C/T/W/H/X have actual evidence for
the same deployment. Missing human inputs or credentials leave acceptance open.
This clean-continuation pass provides no stronger hard-crash guarantees:
[ADR 0008](adr/0008-mailbox-completion-and-recovery.md) permits loss of
already-completed queued work or a final reply, retries of unfinished work may
repeat tool effects, and platform delivery may duplicate around acknowledgement.
Do not test crash recovery with irreversible tool effects.
