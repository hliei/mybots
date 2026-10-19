import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PiProvider } from "../packages/agent-runner/src/providers/pi.ts";
import { WebSocketChannel } from "../packages/host/src/channels/websocket.ts";
import { loadHostSettings } from "../packages/host/src/config/host.ts";
import type { SessionDriver } from "../packages/host/src/drivers/types.ts";
import { Host } from "../packages/host/src/host.ts";
import { waitForCheckpoint } from "./checkpoint.ts";
import { MailboxDriver } from "./host-fixture.ts";
import { type ModelRequest, startPiService } from "./pi-fixture.ts";
import { piRunDriver } from "./pi-run-driver.ts";

let root: string;
let host: Host;
let channel: WebSocketChannel;
let base: string;
let headers: Record<string, string>;
afterEach(async () => {
  await channel?.close();
  await host?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});
async function start(driver: SessionDriver = new MailboxDriver()) {
  root = await mkdtemp(join(tmpdir(), "mybots-background-"));
  const { configuration } = await loadHostSettings("examples/host/host.json");
  host = await Host.start({ root, configuration, driver });
  await listen(configuration);
  return configuration;
}
async function listen(
  configuration: Awaited<ReturnType<typeof loadHostSettings>>["configuration"],
) {
  channel = await WebSocketChannel.listen({ root, host, configuration, port: 0 });
  base = `http://127.0.0.1:${channel.address.port}`;
  headers = {
    Authorization: `Bearer ${(await readFile(join(root, "data", "client-credential"), "utf8")).trim()}`,
    "Content-Type": "application/json",
  };
}
function post(path: string, body: unknown) {
  return fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}
async function get(path: string) {
  const response = await fetch(`${base}${path}`, { headers });
  expect(response.status).toBe(200);
  return response.json();
}
function runByText(
  detail: {
    tasks: {
      runs: {
        id: string;
        state: string;
        backgroundBoundary: number;
        references: unknown;
        inputs: { text: string }[];
      }[];
    }[];
  },
  text: string,
) {
  const run = detail.tasks
    .flatMap((task) => task.runs)
    .find((run) => run.inputs.some((input) => input.text === text));
  if (!run) throw new Error(`Missing run for ${text}`);
  return run;
}

it("captures a later chat background boundary without rewriting queued or active Runs", async () => {
  const driver = new MailboxDriver();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  driver.respond = async (input, _material, signal) => {
    if (input.content === "Before reset") {
      entered.resolve();
      await Promise.race([
        release.promise,
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
      ]);
    }
    return `Final: ${input.content}`;
  };
  const configuration = await start(driver);
  const workspace = join(root, "groups", "personal", "notes.txt");
  await mkdir(join(root, "groups", "personal"), { recursive: true });
  await writeFile(workspace, "Keep this working file\n");
  const path = "/api/bots/personal/thread";
  const active = await (
    await post(`${path}/messages`, { requestId: "active", text: "Before reset" })
  ).json();
  await waitForCheckpoint(entered.promise, "active Run");
  const queued = await (
    await post(`${path}/tasks`, { requestId: "queued", text: "Queued before reset" })
  ).json();
  const reset = await post(`${path}/reset`, { requestId: "boundary" });
  expect(reset.status).toBe(202);
  const captured = await reset.json();
  expect(captured).toMatchObject({
    requestId: "boundary",
    botId: "personal",
    backgroundBoundary: expect.any(Number),
  });
  expect(captured.backgroundBoundary).toBeGreaterThan(0);
  const during = await get(path);
  const activeRun = runByText(during, "Before reset");
  const queuedRun = runByText(during, "Queued before reset");
  expect(activeRun).toMatchObject({
    id: active.runId,
    state: "active",
    backgroundBoundary: 0,
  });
  expect(queuedRun).toMatchObject({
    id: queued.runId,
    state: "queued",
    backgroundBoundary: 0,
  });
  expect(during.thread.backgroundBoundary).toBe(captured.backgroundBoundary);
  expect(JSON.stringify(queuedRun.references)).toContain("Before reset");
  const fresh = await (
    await post(`${path}/tasks`, { requestId: "fresh", text: "After reset" })
  ).json();
  const resetDetail = await get(path);
  const freshRun = runByText(resetDetail, "After reset");
  expect(freshRun).toMatchObject({
    id: fresh.runId,
    state: "queued",
    backgroundBoundary: captured.backgroundBoundary,
  });
  expect(JSON.stringify(freshRun.references)).not.toContain("Before reset");
  expect(JSON.stringify(freshRun.references)).not.toContain("Queued before reset");
  const originals = await get(`${path}/history?query=${encodeURIComponent("Before reset")}`);
  expect(
    originals.messages.some((message: { text: string }) => message.text === "Before reset"),
  ).toBe(true);
  expect((await post(`${path}/reset`, { requestId: "boundary" })).status).toBe(202);
  expect(
    (await post(`${path}/messages`, { requestId: "boundary", text: "different" })).status,
  ).toBe(409);
  release.resolve();
  expect(await readFile(workspace, "utf8")).toBe("Keep this working file\n");
  await channel.close();
  await host.stop();
  host = await Host.start({ root, configuration, driver: new MailboxDriver() });
  await listen(configuration);
  const restored = await get(path);
  expect(restored.thread.backgroundBoundary).toBe(captured.backgroundBoundary);
  expect(runByText(restored, "Before reset").backgroundBoundary).toBe(0);
  expect(runByText(restored, "After reset").backgroundBoundary).toBe(captured.backgroundBoundary);
  expect(
    (await fetch(`${base}${path}/history?query=${encodeURIComponent("Before reset")}`)).status,
  ).toBe(401);
});

it("adds earlier Thread messages to a new Run only through owner selection", async () => {
  const driver = new MailboxDriver();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  driver.respond = async (input, _material, signal) => {
    if (input.content === "Earlier evidence") {
      entered.resolve();
      await Promise.race([
        release.promise,
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
      ]);
    }
    return `Final: ${input.content}`;
  };
  await start(driver);
  const path = "/api/bots/personal/thread";
  const earlier = await (
    await post(`${path}/messages`, { requestId: "earlier", text: "Earlier evidence" })
  ).json();
  await waitForCheckpoint(entered.promise, "active Run");
  expect((await post(`${path}/reset`, { requestId: "select-boundary" })).status).toBe(202);
  const omitted = await (
    await post(`${path}/tasks`, { requestId: "omit", text: "Without selection" })
  ).json();
  const selected = await post(`${path}/tasks`, {
    requestId: "select",
    text: "With selection",
    selectedMessageIds: [earlier.messageId],
  });
  expect(selected.status).toBe(202);
  const detail = await get(path);
  expect(JSON.stringify(runByText(detail, "Without selection").references)).not.toContain(
    "Earlier evidence",
  );
  expect(JSON.stringify(runByText(detail, "With selection").references)).toContain(
    "Earlier evidence",
  );
  expect(runByText(detail, "With selection").backgroundBoundary).toBe(
    detail.thread.backgroundBoundary,
  );
  expect(
    (
      await post(`/api/bots/personal/tasks/${omitted.taskId}/inputs`, {
        requestId: "steer-selection",
        text: "Do not widen this Run",
        selectedMessageIds: [earlier.messageId],
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await post(`${path}/tasks`, {
        requestId: "missing-selection",
        text: "Missing",
        selectedMessageIds: ["missing-message"],
      })
    ).status,
  ).toBe(404);
  release.resolve();
});

it("applies reset and a new conversational Run as separate admissions", async () => {
  const driver = new MailboxDriver();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  driver.respond = async (input, _material, signal) => {
    if (input.content === "Held") {
      entered.resolve();
      await Promise.race([
        release.promise,
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
      ]);
    }
    return `Final: ${input.content}`;
  };
  await start(driver);
  const path = "/api/bots/personal/thread";
  const held = await (await post(`${path}/messages`, { requestId: "held", text: "Held" })).json();
  await waitForCheckpoint(entered.promise, "held Run");
  const prior = (await get(path)).thread.backgroundBoundary as number;
  const [reset, sent] = await Promise.all([
    post(`${path}/reset`, { requestId: "race-reset" }),
    post(`${path}/tasks`, { requestId: "race-task", text: "Race admission" }),
  ]);
  expect(reset.status).toBe(202);
  expect(sent.status).toBe(202);
  const detail = await get(path);
  const raced = runByText(detail, "Race admission");
  expect(runByText(detail, "Held")).toMatchObject({
    id: held.runId,
    state: "active",
    backgroundBoundary: prior,
  });
  expect([prior, detail.thread.backgroundBoundary]).toContain(raced.backgroundBoundary);
  const seesHeld = JSON.stringify(raced.references).includes("Held");
  if (raced.backgroundBoundary === prior) expect(seesHeld).toBe(true);
  else {
    expect(raced.backgroundBoundary).toBe(detail.thread.backgroundBoundary);
    expect(seesHeld).toBe(false);
  }
  release.resolve();
});

it("keeps old and new Run history tools on the boundary captured at admission", async () => {
  const release = Promise.withResolvers<void>();
  let activePrompt = "";
  let queuedPrompt = "";
  let freshPrompt = "";
  let selectedPrompt = "";
  let activeTool = "";
  let queuedTool = "";
  let freshTool = "";
  let selectedTool = "";
  const prompt = (request: ModelRequest) => JSON.stringify(request.messages);
  const latestUser = (request: ModelRequest) =>
    JSON.stringify(request.messages.filter((message) => message.role === "user").at(-1)?.content);
  const service = await startPiService(async (request) => {
    const latest = latestUser(request);
    const background = prompt(request);
    const tools = request.messages.filter((message) => message.role === "tool");
    const search = () =>
      ({ tool: "search_history", arguments: { query: "alpha-token-old" } }) as const;
    if (latest.includes("active lookup")) {
      if (!tools.length) {
        activePrompt = background;
        return search();
      }
      activeTool = JSON.stringify(tools.at(-1)?.content);
      await release.promise;
      return { text: "Active done" };
    }
    if (latest.includes("queued lookup")) {
      if (!tools.length) {
        queuedPrompt = background;
        return search();
      }
      queuedTool = JSON.stringify(tools.at(-1)?.content);
      return { text: "Queued done" };
    }
    if (latest.includes("fresh lookup")) {
      if (!tools.length) {
        freshPrompt = background;
        return search();
      }
      freshTool = JSON.stringify(tools.at(-1)?.content);
      return { text: "Fresh done" };
    }
    if (latest.includes("selected lookup")) {
      if (!tools.length) {
        selectedPrompt = background;
        return search();
      }
      selectedTool = JSON.stringify(tools.at(-1)?.content);
      return { text: "Selected done" };
    }
    return { text: "Noted" };
  });
  try {
    await start(
      piRunDriver(new PiProvider({ modelRuntime: service.runtime, model: service.model })),
    );
    const path = "/api/bots/personal/thread";
    const old = await (
      await post(`${path}/messages`, { requestId: "old", text: "alpha-token-old" })
    ).json();
    await vi.waitFor(async () =>
      expect((await get(path)).tasks[0].runs[0].state).toBe("succeeded"),
    );
    const active = await (
      await post(`${path}/messages`, { requestId: "active", text: "active lookup" })
    ).json();
    await service.waitForRequest(3);
    expect(activePrompt).toContain("alpha-token-old");
    expect(activeTool).toContain(old.messageId);
    const queued = await (
      await post(`${path}/tasks`, { requestId: "queued", text: "queued lookup" })
    ).json();
    const reset = await (await post(`${path}/reset`, { requestId: "sdk-reset" })).json();
    const fresh = await (
      await post(`${path}/tasks`, { requestId: "fresh", text: "fresh lookup" })
    ).json();
    const selected = await (
      await post(`${path}/tasks`, {
        requestId: "selected",
        text: "selected lookup",
        selectedMessageIds: [old.messageId],
      })
    ).json();
    expect(
      (await get(path)).tasks.find((task: { id: string }) => task.id === queued.taskId).runs[0],
    ).toMatchObject({ state: "queued", backgroundBoundary: 0 });
    release.resolve();
    await vi.waitFor(
      async () => {
        const detail = await get(path);
        expect(runByText(detail, "active lookup").state).toBe("succeeded");
        expect(runByText(detail, "queued lookup").state).toBe("succeeded");
        expect(runByText(detail, "fresh lookup").state).toBe("succeeded");
        expect(runByText(detail, "selected lookup").state).toBe("succeeded");
      },
      { timeout: 20000 },
    );
    expect(queuedPrompt).toContain("alpha-token-old");
    expect(queuedTool).toContain(old.messageId);
    expect(freshPrompt).not.toContain("alpha-token-old");
    expect(freshTool).not.toContain(old.messageId);
    expect(selectedPrompt).toContain("alpha-token-old");
    expect(selectedTool).not.toContain(old.messageId);
    const detail = await get(path);
    expect(runByText(detail, "active lookup")).toMatchObject({
      id: active.runId,
      backgroundBoundary: 0,
    });
    expect(runByText(detail, "fresh lookup").backgroundBoundary).toBe(reset.backgroundBoundary);
    expect(runByText(detail, "selected lookup").backgroundBoundary).toBe(reset.backgroundBoundary);
    expect(fresh.runId).not.toBe(selected.runId);
  } finally {
    release.resolve();
    await service.close();
  }
}, 30000);
