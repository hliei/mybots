import { rm } from "node:fs/promises";

// Remove retired output roots as well as stale modules within each workspace.
await Promise.all(
  [
    "../dist/",
    "../container/agent-runner/dist/",
    "../packages/host/dist/",
    "../packages/client/dist/",
    "../packages/mailbox/dist/",
    "../packages/agent-runner/dist/",
    "../packages/contracts/dist/",
    "../packages/db/dist/",
    "../packages/agent/dist/",
    "../apps/web/dist/",
    "../apps/worker/dist/",
    "../apps/api/dist/",
  ].map((path) => rm(new URL(path, import.meta.url), { recursive: true, force: true })),
);
