import { fork } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

test.each(["SIGINT", "SIGTERM"] as const)("worker closes cleanly on %s", async (signal) => {
  const root = await mkdtemp(join(tmpdir(), "mybots-worker-shutdown-"));
  await mkdir(join(root, "data"));
  await writeFile(join(root, "models.json"), "[]", { mode: 0o600 });
  const child = fork(new URL("../apps/worker/src/index.ts", import.meta.url), [root], {
    execArgv: ["--conditions=mybots-source"],
    silent: true,
  });
  let errors = "";
  child.stderr?.on("data", (chunk) => {
    errors += chunk;
  });
  const exited = new Promise((resolve, reject) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const ready = await Promise.race([
      new Promise((resolve) => child.once("message", resolve)),
      exited.then(() => {
        throw new Error(`Worker failed to start: ${errors}`);
      }),
    ]);
    expect(ready).toMatchObject({ type: "ready" });
    child.kill(signal);
    expect(await exited).toEqual({ code: 0, signal: null });
    expect(errors).toBe("");
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    await rm(root, { recursive: true, force: true });
  }
});
