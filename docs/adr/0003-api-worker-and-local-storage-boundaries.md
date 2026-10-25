# API, worker and local storage boundaries

Status: accepted and implemented.

Separate Web, API and worker applications, with API and worker running as local
processes. The worker alone drives Durable storage; API forwards admission,
history and subscriptions instead of accessing SDK-internal tables. This accepts
one process boundary to keep execution ownership unambiguous.

Use SQLite for product and SDK persistence with separate ownership. A local
single-owner installation needs no database service or distributed queue.
One startup command and API-served Web assets keep operation local; retain
connection credentials, origin checks and host-side model configuration.

See [architecture](../architecture.md).
