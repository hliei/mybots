import { rm } from "node:fs/promises";

// Remove stale modules before compiling the active workspaces.
await Promise.all(
  [
    "../packages/contracts/dist/",
    "../packages/db/dist/",
    "../packages/agent/dist/",
    "../packages/sandbox/dist/",
    "../apps/web/dist/",
    "../apps/worker/dist/",
    "../apps/api/dist/",
  ].map((path) => rm(new URL(path, import.meta.url), { recursive: true, force: true })),
);
