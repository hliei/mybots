# Architecture

Status: implemented; actual-provider acceptance is a separate opt-in gate.

## Product boundary

One owner-local Space contains multiple Bots and one shared Team Computer.
Each Bot has one direct Thread associated with one stable Pi Durable Conversation.
Bot identity, conversation and Bot memory remain separate even when files are shared.

The Web interface retains its current desktop appearance and provides Bot
configuration, direct chat, streaming replies, tool activity, history, Stop,
unprocessed inputs, shared Skills, scoped memory editing and installation-wide
DeepSeek/OpenCode Go provider settings.

Scheduling, delegation, dedicated question/approval workflows, attachments,
artifact management and Telegram are outside this release. So are multiple
Spaces/users, Private Computers, mobile UI, a file browser, arbitrary provider
endpoints and desktop/browser control. Ordinary questions remain part of chat.

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

API and worker are separate local processes. `npm start` starts the system
on macOS; Docker is required only for Computer tools. Browser
access stays on loopback with connection credentials and Host/Origin validation.
Provider keys enter through authenticated Web settings and remain in owner-only
host storage, outside browser persistence, logs and Computer files. The application
owns the supported model/adapter catalog and endpoints; each Bot selects its model
without automatic fallback. Saving keys makes no provider request. Packages are
created only when used.

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

The default entry uses only API/worker and Durable, without dual writes or a
fallback engine. Upgrades preserve current Bots, history, Skills, scoped memory
and Computer files. Normal shutdown preserves the workspace and completed-turn
retained services. Unexpected worker exit triggers bounded restart and cleanup
of interrupted-turn commands before supported SDK recovery. See
[command ownership and service lifetime](adr/0005-command-ownership-and-service-lifetime.md).
Incompatible legacy installations require explicit retirement as described in
[local operation](durable-chat.md#retiring-an-older-installation); startup does
not migrate or delete their records. Unrelated owner files and ignored local
planning remain intact.

See [conversation execution](conversation-execution.md),
[Computer and resources](computer-and-resources.md), and the [decision index](README.md#decisions).
