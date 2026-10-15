import { rm } from "node:fs/promises";

// Remove stale emitted modules when source files have been retired.
await Promise.all(
  ["../dist/", "../container/agent-runner/dist/"].map((path) =>
    rm(new URL(path, import.meta.url), { recursive: true, force: true }),
  ),
);
