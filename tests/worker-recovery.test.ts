import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { startApi } from "../apps/api/src/server.ts";
import { apiFixture } from "./durable-api-fixture.ts";

async function spawns(root: string): Promise<number[]> {
  return (await readFile(join(root, "worker-spawns"), "utf8")).trim().split("\n").map(Number);
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("worker recovery exhausts three serialized attempts and leaves an actionable failure", async () => {
  const fixture = await apiFixture(undefined, { workerFaults: true });
  try {
    await writeFile(join(fixture.root, "worker-fault"), "crash");
    await fixture.crashWorker();
    await expect
      .poll(() => fixture.request("worker"), { timeout: 12000 })
      .toMatchObject({
        state: "failed",
        error: expect.stringContaining("Automatic recovery stopped"),
      });
    const pids = await spawns(fixture.root);
    expect(pids).toHaveLength(4);
    expect(pids.map(alive)).toEqual([false, false, false, false]);
    const response = await fetch(new URL("api/providers", fixture.url), {
      headers: { Authorization: `Bearer ${fixture.credential}` },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("restart the application"),
    });
  } finally {
    await fixture.close();
  }
}, 15000);

test.each(["backoff", "startup"])(
  "shutdown during recovery %s leaves no worker or respawn",
  async (stage) => {
    const fixture = await apiFixture(undefined, { workerFaults: true });
    try {
      await writeFile(join(fixture.root, "worker-fault"), "hold");
      await fixture.crashWorker();
      expect(await fixture.request("worker")).toMatchObject({ state: "recovering" });
      if (stage === "startup")
        await expect.poll(async () => (await spawns(fixture.root)).length).toBe(2);
      await fixture.shutdown();
      const pids = await spawns(fixture.root);
      expect(pids.length).toBeLessThanOrEqual(stage === "backoff" ? 1 : 2);
      expect(pids.map(alive)).toEqual(pids.map(() => false));
      // Reopen the root to prove shutdown also released exclusive ownership.
      await writeFile(join(fixture.root, "worker-fault"), "");
      await fixture.reopen();
      expect(await fixture.request("worker")).toEqual({ state: "ready" });
    } finally {
      await fixture.close();
    }
  },
);

test("plain chat and its worker recovery never need a Docker executable", async () => {
  const previous = process.env.PATH;
  process.env.PATH = "/mybots-no-executables";
  let fixture: Awaited<ReturnType<typeof apiFixture>>;
  try {
    fixture = await apiFixture();
  } finally {
    process.env.PATH = previous;
  }
  try {
    const bot = await fixture.request("bots", {
      name: "No Docker",
      instructions: "",
      model: "deepseek/deepseek-flash",
    });
    await fixture.request(`bots/${bot.id}/send`, { text: "Hello", requestId: "without-docker" });
    await expect.poll(async () => (await fixture.request(`bots/${bot.id}/chat`)).busy).toBe(false);
    await fixture.crashWorker();
    await expect
      .poll(() => fixture.request("worker"), { timeout: 10000 })
      .toEqual({ state: "recovered" });
    expect((await fixture.request(`bots/${bot.id}/chat`)).messages.at(-1)?.text).toBe(
      "Persistent answer",
    );
  } finally {
    await fixture.close();
  }
});

test("an IPC request interrupted by worker death settles without transport replay", async () => {
  const fixture = await apiFixture(undefined, { workerFaults: true });
  try {
    await writeFile(join(fixture.root, "worker-fault"), "request-crash");
    const response = await fetch(new URL("api/providers", fixture.url), {
      headers: { Authorization: `Bearer ${fixture.credential}` },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("Check chat before retrying input"),
    });
    await expect
      .poll(() => fixture.request("worker"), { timeout: 10000 })
      .toEqual({ state: "recovered" });
    expect(await spawns(fixture.root)).toHaveLength(2);
    expect(fixture.service.requests).toHaveLength(0);
  } finally {
    await fixture.close();
  }
});

test.each(["abort", "deadline"])(
  "initial worker startup %s releases processes without a restart loop",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "mybots-startup-recovery-"));
    const signal = new AbortController();
    const previous = process.env.NODE_OPTIONS;
    await writeFile(join(root, "worker-fault"), "hold");
    process.env.NODE_OPTIONS = `${previous ?? ""} --import=${new URL("./worker-fault.mjs", import.meta.url).pathname}`;
    const opening = startApi(root, 0, signal.signal);
    const failed = expect(opening).rejects.toThrow(
      mode === "deadline" ? "startup timed out" : /Worker unavailable|aborted/,
    );
    try {
      await expect.poll(async () => (await spawns(root).catch(() => [])).length).toBe(1);
      process.env.NODE_OPTIONS = previous;
      if (mode === "abort") signal.abort();
      await failed;
      const pids = await spawns(root);
      expect(pids).toHaveLength(1);
      expect(pids.map(alive)).toEqual([false]);
    } finally {
      if (previous === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previous;
      signal.abort();
      await opening.then(
        (api) => api.close(),
        () => {},
      );
      await rm(root, { recursive: true, force: true });
    }
  },
  20000,
);
