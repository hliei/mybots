# Architecture

Status: accepted target; implementation pending.

## Product boundary

One owner-local Space contains multiple Bots and one shared Team Computer.
Each Bot has one direct Thread associated with one stable Pi Durable Conversation.
Bot identity, conversation and Bot memory remain separate even when files are shared.

The Web interface retains its current desktop appearance and provides Bot
configuration, direct chat, streaming replies, tool activity, history, Stop,
unprocessed inputs, shared Skills and scoped memory editing.

Scheduling, delegation, dedicated question/approval workflows, attachments,
artifact management and Telegram are outside this release. So are multiple
Spaces/users, Private Computers, mobile UI, a file browser, graphical provider
setup and desktop/browser control. Ordinary questions remain part of chat.

## Process and package boundaries

```text
Web → API → worker → Pi Durable
               └──→ SandboxProvider → Docker Team Computer
```

| Location | Responsibility |
| --- | --- |
| `apps/web` | Owner interface |
| `apps/api` | Built Web assets, local access checks, product operations and forwarding |
| `apps/worker` | Sole driver of Durable storage, execution, history and subscriptions |
| `packages/contracts` | Shared request, response and event types |
| `packages/db` | Product records and SQLite access |
| `packages/agent` | Durable integration, context policy and tools |
| `packages/sandbox` | Computer lifecycle, commands, files and workspace transfer |

API and worker are separate local processes. One command will start the system
on macOS with Docker; its exact invocation belongs to implementation. Browser
access stays on loopback with connection credentials and Host/Origin validation.
Model credentials and endpoints stay in host installation configuration, outside
browser assets, logs and Computer files. Packages are created only when used.

## Authoritative state

| State | Owner |
| --- | --- |
| Space, Bots, Threads, Conversation association and Computer configuration | Product SQLite |
| Shared Skills and scoped Markdown memory | Product SQLite |
| Submissions, transcript, model/tool execution, compaction and supported recovery | Pi Durable, accessed through worker |
| Working files | Persistent Team Computer workspace |

API obtains Durable admission, history and subscriptions through worker; it does
not query SDK-internal tables. Display projections are not a second transcript.
There is no distributed queue or application Task/Run/Attempt state machine.

## Transition

Incompatible code and identified old runtime data may be retired without
migration. Temporary separate entry points may support incremental delivery;
final cutover leaves one supported runtime without dual writes or a fallback
engine. Unrelated owner files and ignored local planning remain intact. The new
Computer workspace persists across normal shutdowns.

See [conversation execution](conversation-execution.md),
[Computer and resources](computer-and-resources.md), and the [decision index](README.md#decisions).
