import { fork } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

test.each(["SIGINT", "SIGTERM"] as const)("worker closes cleanly on %s", async (signal) => {
  const root = await mkdtemp(join(tmpdir(), "mybots-worker-shutdown-"));
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

test("default startup keeps configuration and state in one data directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "mybots-default-root-"));
  await mkdir(join(root, "data"), { mode: 0o700 });
  const child = fork(new URL("../apps/api/src/index.ts", import.meta.url), ["--port", "0"], {
    cwd: root,
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
    const { url } = await Promise.race([
      new Promise<{ url: string }>((resolve) =>
        child.once("message", (value) => resolve(value as { url: string })),
      ),
      exited.then(() => {
        throw new Error(`Default startup failed: ${errors}`);
      }),
    ]);
    const credential = (await readFile(join(root, "data", "client-credential"), "utf8")).trim();
    const response = await fetch(new URL("api/bots", url), {
      headers: { Authorization: `Bearer ${credential}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      bots: [],
      models: expect.arrayContaining([
        expect.objectContaining({ id: "deepseek/deepseek-flash", available: false }),
      ]),
    });
    child.kill("SIGTERM");
    expect(await exited).toEqual({ code: 0, signal: null });
    expect(errors).toBe("");
    expect(await readdir(root)).toEqual(["data"]);
    const files = await readdir(join(root, "data"));
    expect(files).toEqual(
      expect.arrayContaining([
        "providers",
        "client-credential",
        "product.sqlite",
        "durable.sqlite",
        "worker-owner.sqlite",
      ]),
    );
    expect(files).not.toContain("data");
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    await rm(root, { recursive: true, force: true });
  }
});
