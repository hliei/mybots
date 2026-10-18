# Local client API within the Host process

Status: accepted
Implementation: planned

The Backend API is a module in the persistent Host process. That process serves
the built Web UI and its management, conversation, query, file and event
interfaces on localhost. Frontend code remains a separate client module that
uses those interfaces; the Host owns domain operations, execution coordination
and persistent state.

This preserves the logical client-to-API-to-Host-to-container boundary while
avoiding an additional production backend process or competing authoritative
store. Development servers do not become deployment requirements.

Bind only loopback, serve same-origin UI/API, and validate Host/Origin together
with a locally generated connection credential for management, conversation,
files and live events. The browser may remember the credential after initial
pairing. No account registration or multi-user authentication service is required.
Credential bootstrap/storage remains implementation design within this local
owner boundary.

HTTP operations, queries and files use Host domain services; WebSocket carries
live events. The UI presents messages, tool activity/results, questions/approvals,
task/delegation relationships, artifacts and incremental assistant text. Restore
reconnect state through persistent snapshots and paginated history. Live text
fragments are transient, not completion evidence or guaranteed replay.

Stable correlated Mybots records form the client contract, while Pi retains
original conversation/model-context ownership. Stable client request identity
prevents a transport retry from accepting duplicate management/work operations;
this does not establish exactly-once tool execution. Exact public record and
event fields, and search/export beyond ordinary history, remain interface detail.
