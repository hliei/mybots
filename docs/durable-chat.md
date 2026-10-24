# Persistent local chat

The isolated chat entry runs the API and Durable worker as separate local
processes. It supports Bot creation and saved name, instructions and model,
one persistent Thread per Bot, streamed answers, native steering and Stop.
The existing default entry remains available until the full runtime cutover.

Use Node.js 24.21.0 and install with `npm ci`, then `npm run prepare` and
`npm run build`. The new Web build reuses the delivered client stylesheet;
its Markdown renderer and reading-position behavior live in `apps/web`.

## Host configuration and startup

Create `workspace/durable-chat/models.json` with a JSON array of host-configured
OpenAI Chat Completions compatible models. For example, replace the endpoint,
model and credential placeholders with your installation values:

```json
[
  {
    "id": "personal",
    "name": "Personal model",
    "modelId": "your-model-id",
    "baseUrl": "https://your-provider.example/v1",
    "apiKey": "your-provider-credential",
    "contextWindow": 32768,
    "maxTokens": 4096
  }
]
```

Keep this file readable only by the owner (`chmod 600`); the default installation
root is ignored by Git. Use an empty array to check startup without a configured
provider. The model endpoint and credentials stay in the worker; the browser
receives only model choice IDs and display names. Each choice ID must be unique.
Restart the application after changing host model configuration. A Bot whose
saved choice was removed remains editable with its original Thread; choose an
available model in Bot settings before sending new input.

Start both processes and serve the built Web with one command:

```sh
npm run start:durable
```

Open `http://127.0.0.1:4173`. Connect using the credential in
`workspace/durable-chat/data/client-credential`. The HttpOnly connection cookie
survives reload; Host, Origin and cross-site checks apply to local requests.
Create a Bot, select a configured model and send a message. Enter sends;
Shift+Enter adds a line. A message sent while busy uses native steering.
Stop aborts current work and withdraws queued inputs; withdrawn inputs remain
visible with a Resend control that restores their text to the composer.

Use a different fresh root or port with:

```sh
npm run start:durable -- --root /absolute/path/to/new-installation --port 4174
```

The selected root must contain its own `models.json`. Do not point the new entry
at legacy runtime data. The source entry is `npm run dev:durable` with the same
arguments and requires built Web assets. Ctrl+C shuts down both processes;
normal shutdown retains all data. A second worker cannot open the same root.
If startup fails, check the model file, its required fields and data-root
ownership before retrying.

## Persistence and context

Product SQLite stores the default Space, Bots and each Bot's stable
Thread/Conversation association. Only the worker opens the separate Durable
SQLite store. There is no application transcript or execution queue. A send
returns its SDK submission identity only after native admission and a
non-model-visible SDK receipt; retries reuse the same request ID. That receipt
lets withdrawn text remain visible after the SDK removes it from its inbox.

Reload and reconnect read committed SDK originals and live state. The initial
chat view contains the latest 200 SDK entries. Earlier originals remain in SDK
storage; comprehensive history browsing and retrieval are a subsequent slice.

Each model request receives the current Bot instructions, at most two previous
user-message groups fitting within 12,000 serialized characters, and the
current execution's complete remaining exchanges. Whole background groups are
dropped rather than splitting tool calls from their results. Current execution
is identified from native live inputs, including after reopen, without a saved
application execution record.

Native automatic compaction remains enabled, with 1,024 reserved tokens and
2,048 recent tokens retained. Background compaction is disabled. The SDK checks
compaction before the request-selection hook: it may summarize older original
context, including current execution when necessary. Selection then runs over
that native context, preserving the summary when it replaces current execution.
It does not rewrite stored originals or build a separate summary. Actual model
usage reflects the selected request and participates in native token estimation.
These are fixed implementation defaults, with no tuning interface.

## Verification

`npm run verify` covers both entries: formatting, lint, source/test/configuration
types, offline tests, compiled startup and built-browser checks. The new fixture
uses the real SDK and SQLite against a controlled HTTP model service, including
native automatic compaction, current tool pairs, originals after reopen,
transport deduplication, credential checks and Stop. Browser checks cover send,
streaming, reload, Bot editing and Thread separation.

No Docker operation or actual provider request is required by these checks.
Computer tools, shared Skills/memory, comprehensive original-history controls,
full interruption/recovery combinations and default cutover remain subsequent
slices. Controlled-model success does not establish actual-provider acceptance.
