import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HostMailbox, RunnerMailbox } from "@mybots/mailbox/node";
import { afterEach, expect, it, vi } from "vitest";
import { PiProvider } from "../packages/agent-runner/src/providers/pi.ts";
import { WebSocketChannel } from "../packages/host/src/channels/websocket.ts";
import { loadHostSettings } from "../packages/host/src/config/host.ts";
import type { ObservingSessionDriver, SessionDriver } from "../packages/host/src/drivers/types.ts";
import { Host } from "../packages/host/src/host.ts";
import { waitForCheckpoint } from "./checkpoint.ts";
import { MailboxDriver } from "./host-fixture.ts";
import { startPiService } from "./pi-fixture.ts";
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
  root = await mkdtemp(join(tmpdir(), "mybots-chat-"));
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

it("provides one direct Thread per Bot and retires owner-created sessions", async () => {
  const configuration = await start();
  const first = await get("/api/bots/personal/thread");
  expect(first).toMatchObject({ thread: { botId: "personal" }, tasks: [], messages: [] });
  expect(
    (await post("/api/sessions", { requestId: "old", botId: "personal", name: "Old" })).status,
  ).toBe(404);
  await channel.close();
  await host.stop();
  host = await Host.start({ root, configuration, driver: new MailboxDriver() });
  await listen(configuration);
  expect(await get("/api/bots/personal/thread")).toEqual(first);
});

it("keeps stable Thread admissions through completion races, queues independent Tasks and targets additions", async () => {
  const driver = new MailboxDriver();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const seen: string[] = [];
  driver.respond = async (input, _material, signal) => {
    seen.push(input.content);
    if (input.content === "First") {
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
  const initial = { requestId: "first", text: "First" };
  const first = await (await post(`${path}/messages`, initial)).json();
  expect(first.taskId).toEqual(expect.any(String));
  await waitForCheckpoint(entered.promise, "first Task execution");
  const queued = await (
    await post(`${path}/tasks`, { requestId: "independent", text: "Independent" })
  ).json();
  expect(queued.taskId).not.toBe(first.taskId);
  expect(queued.runId).not.toBe(first.runId);
  const added = await (
    await post(`/api/bots/personal/tasks/${first.taskId}/inputs`, {
      requestId: "steer",
      text: "Steering",
    })
  ).json();
  expect(added).toMatchObject({ taskId: first.taskId, runId: first.runId });
  expect(seen).toEqual(["First"]);
  const detail = await get(path);
  expect(detail.tasks[0].runs[0]).toMatchObject({
    state: "active",
    attempts: [{ configurationVersion: 1, endedAt: null }],
  });
  expect(detail.tasks[1].runs[0]).toMatchObject({ state: "queued", attempts: [] });
  release.resolve();
  await vi.waitFor(async () =>
    expect(
      (await get(path)).tasks.map((task: { runs: { state: string }[] }) => task.runs[0]?.state),
    ).toEqual(["succeeded", "succeeded"]),
  );
  expect(seen).toEqual(["First", "Steering", "Independent"]);
  const retry = await (await post(`${path}/messages`, initial)).json();
  expect(retry).toEqual({ ...first, replayed: true });
  const next = await (await post(`${path}/messages`, { requestId: "after", text: "Next" })).json();
  expect(next.taskId).not.toBe(first.taskId);
  expect(
    (
      await post(`/api/bots/personal/tasks/${first.taskId}/inputs`, {
        requestId: "terminal",
        text: "Old",
      })
    ).status,
  ).toBe(409);
});

it("recovers lost-response admissions and queued Task additions through a fresh Host", async () => {
  const driver = new MailboxDriver();
  const entered = Promise.withResolvers<void>();
  driver.respond = async (_input, _material, signal) => {
    entered.resolve();
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    return "Interrupted";
  };
  const configuration = await start(driver);
  const path = "/api/bots/personal/thread";
  const request = { requestId: "lost-response", text: "Held work" };
  const first = await (await post(`${path}/messages`, request)).json();
  await waitForCheckpoint(entered.promise, "held execution");
  const queued = await (
    await post(`${path}/tasks`, { requestId: "queue", text: "Queued work" })
  ).json();
  const addition = { requestId: "queued-addition", text: "Keep my target" };
  const added = await (
    await post(`/api/bots/personal/tasks/${queued.taskId}/inputs`, addition)
  ).json();
  await channel.close();
  await host.stop();
  const recovered = new MailboxDriver();
  host = await Host.start({ root, configuration, driver: recovered, now: () => Date.now() + 6000 });
  await listen(configuration);
  expect(await (await post(`${path}/messages`, request)).json()).toEqual({
    ...first,
    replayed: true,
  });
  expect(
    await (await post(`/api/bots/personal/tasks/${queued.taskId}/inputs`, addition)).json(),
  ).toEqual({ ...added, replayed: true });
  await vi.waitFor(async () =>
    expect((await get(path)).tasks[1].runs[0]).toMatchObject({
      state: "succeeded",
      inputs: [{ text: "Queued work" }, { text: "Keep my target" }],
    }),
  );
  expect(
    recovered.launches.filter((row) => row.material.key.sessionId === queued.runId),
  ).toHaveLength(1);
});

it("retains the Bot slot until actual stop and permits another Bot to progress", async () => {
  const external = new MailboxDriver();
  const stopping = Promise.withResolvers<void>();
  const stop = Promise.withResolvers<void>();
  let firstRun: string | undefined;
  const driver: SessionDriver = {
    start: async (material, signal) => {
      const handle = await external.start(material, signal);
      firstRun ??= material.key.sessionId;
      return {
        wait: handle.wait,
        stop: async () => {
          if (material.key.sessionId === firstRun && !signal.aborted) {
            stopping.resolve();
            await stop.promise;
          }
          await handle.stop();
        },
      };
    },
  };
  await start(driver);
  const first = await (
    await post("/api/bots/personal/thread/messages", { requestId: "one", text: "One" })
  ).json();
  await waitForCheckpoint(stopping.promise, "termination in progress");
  const queued = await (
    await post("/api/bots/personal/thread/tasks", { requestId: "two", text: "Two" })
  ).json();
  const bot = await (
    await post("/api/bots", {
      requestId: "bot",
      name: "Writer",
      instructions: "Write",
      model: { provider: "deepseek", id: "deepseek-chat" },
      tools: [],
    })
  ).json();
  const other = await (
    await post(`/api/bots/${bot.bot.id}/thread/messages`, { requestId: "other", text: "Other" })
  ).json();
  try {
    await vi.waitFor(async () =>
      expect((await get(`/api/bots/${bot.bot.id}/thread`)).tasks[0].runs[0].state).toBe(
        "succeeded",
      ),
    );
    expect((await get("/api/bots/personal/thread")).tasks[1].runs[0]).toMatchObject({
      state: "queued",
      attempts: [],
    });
    expect(external.launches.map((row) => row.material.key.sessionId)).toEqual([
      first.runId,
      other.runId,
    ]);
    stop.resolve();
    await vi.waitFor(async () =>
      expect((await get("/api/bots/personal/thread")).tasks[1].runs[0].state).toBe("succeeded"),
    );
    expect(external.launches.at(-1)?.material.key.sessionId).toBe(queued.runId);
  } finally {
    stop.resolve();
  }
});

it("initializes real independent Run ledgers from bounded originals and preserves input identities in the model prompt", async () => {
  const service = await startPiService((request) => ({
    text: JSON.stringify(request.messages).includes("First task secret")
      ? "First result"
      : "Fresh result",
  }));
  const provider = new PiProvider({ modelRuntime: service.runtime, model: service.model });
  try {
    await start(piRunDriver(provider));
    const path = "/api/bots/personal/thread";
    const first = await (
      await post(`${path}/messages`, { requestId: "sdk-first", text: "First task secret" })
    ).json();
    await vi.waitFor(async () =>
      expect((await get(path)).tasks[0].runs[0].state).toBe("succeeded"),
    );
    const second = await (
      await post(`${path}/messages`, { requestId: "sdk-second", text: "Second task source" })
    ).json();
    await vi.waitFor(async () =>
      expect((await get(path)).tasks[1].runs[0].state).toBe("succeeded"),
    );
    const firstState = await host.inspect(first.runId);
    const secondState = await host.inspect(second.runId);
    expect(firstState.continuation).not.toBe(secondState.continuation);
    expect(await readFile(secondState.continuation?.slice(3) as string, "utf8")).toContain(
      "mybotsReference",
    );
    expect(JSON.stringify(service.requests[1])).toContain("Historical Thread reference");
    expect(JSON.stringify(service.requests[1]).split("Second task source")).toHaveLength(2);
    expect((await get(path)).tasks[1].runs[0].inputs[0]).toMatchObject({
      id: second.messageId,
      recordedAt: expect.any(String),
    });
  } finally {
    await host?.stop();
    await service.close();
  }
});

it("keeps an acknowledged output gap uncertain without blocking new work after confirmed stop", async () => {
  const external = new MailboxDriver();
  const gap = Promise.withResolvers<void>();
  external.respond = async (input, material, signal) => {
    if (input.content === "Gap") {
      new RunnerMailbox(material.directory).acknowledge(input.id, "completed");
      gap.resolve();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    }
    return "Final";
  };
  const configuration = await start(external);
  const path = "/api/bots/personal/thread";
  const first = await (await post(`${path}/messages`, { requestId: "gap", text: "Gap" })).json();
  await waitForCheckpoint(gap.promise, "acknowledged without reply");
  await channel.close();
  await host.stop();
  host = await Host.start({ root, configuration, driver: new MailboxDriver() });
  await listen(configuration);
  expect((await get(path)).tasks[0].runs[0]).toMatchObject({ id: first.runId, state: "uncertain" });
  const next = await (
    await post(`${path}/messages`, { requestId: "unrelated", text: "Unrelated" })
  ).json();
  expect(next.taskId).not.toBe(first.taskId);
  await vi.waitFor(async () => expect((await get(path)).tasks[1].runs[0].state).toBe("succeeded"));
  expect(await (await post(`${path}/messages`, { requestId: "gap", text: "Gap" })).json()).toEqual({
    ...first,
    replayed: true,
  });
});

it("retains SDK-queued steering through Host loss and records it in the same Run on takeover", async () => {
  let hold = true;
  const service = await startPiService(() =>
    hold ? { hold: true } : { text: "Steering recovered" },
  );
  const driver = piRunDriver(
    new PiProvider({ modelRuntime: service.runtime, model: service.model }),
  );
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const configuration = await start(driver);
    const path = "/api/bots/personal/thread";
    const first = await (
      await post(`${path}/messages`, {
        requestId: "before-loss",
        text: "Original live instruction",
      })
    ).json();
    await service.waitForRequest();
    const addition = { requestId: "steering-before-loss", text: "Recover this accepted steering" };
    const steering = await (
      await post(`/api/bots/personal/tasks/${first.taskId}/inputs`, addition)
    ).json();
    expect(steering).toMatchObject({ taskId: first.taskId, runId: first.runId });
    const ledger = (await host.inspect(first.runId)).continuation;
    await channel.close();
    await host.stop();
    hold = false;
    host = await Host.start({ root, configuration, driver });
    await listen(configuration);
    vi.setSystemTime(Date.now() + 6000);
    await host.reconcile();
    expect(
      await (await post(`/api/bots/personal/tasks/${first.taskId}/inputs`, addition)).json(),
    ).toEqual({ ...steering, replayed: true });
    await vi.waitFor(async () =>
      expect((await get(path)).tasks[0].runs[0].inputs[1]).toMatchObject({
        id: steering.messageId,
        recordedAt: expect.any(String),
        outcome: { kind: "succeeded", reply: "Steering recovered" },
      }),
    );
    expect((await host.inspect(first.runId)).continuation).toBe(ledger);
    expect((await get(path)).tasks).toHaveLength(1);
    expect((await get(path)).tasks[0].runs[0].attempts).toHaveLength(2);
    expect(JSON.stringify(service.requests.at(-1))).toContain("Recover this accepted steering");
    expect(JSON.stringify(service.requests.at(-1))).toContain("Original live instruction");
  } finally {
    await host?.stop();
    vi.useRealTimers();
    await service.close();
  }
});

it("associates a racing ordinary send once and replays that admission after restart", async () => {
  const external = new MailboxDriver();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const seen: string[] = [];
  external.respond = async (input, _material, signal) => {
    seen.push(input.content);
    if (input.content === "Initial") {
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
  const configuration = await start(external);
  const path = "/api/bots/personal/thread";
  await post(`${path}/messages`, { requestId: "initial-race", text: "Initial" });
  await waitForCheckpoint(entered.promise, "competing terminal");
  const request = { requestId: "racing-send", text: "Racing addition" };
  const submissions = Promise.all(
    Array.from({ length: 4 }, async () => (await post(`${path}/messages`, request)).json()),
  );
  release.resolve();
  const responses = await submissions;
  expect(new Set(responses.map((response) => response.runId)).size).toBe(1);
  expect(new Set(responses.map((response) => response.messageId)).size).toBe(1);
  await vi.waitFor(() => expect(seen).toEqual(["Initial", "Racing addition"]));
  await vi.waitFor(async () =>
    expect((await get(path)).tasks.at(-1).runs[0].state).toBe("succeeded"),
  );
  await channel.close();
  await host.stop();
  host = await Host.start({ root, configuration, driver: new MailboxDriver() });
  await listen(configuration);
  expect(await (await post(`${path}/messages`, request)).json()).toMatchObject({
    runId: responses[0].runId,
    taskId: responses[0].taskId,
    messageId: responses[0].messageId,
    replayed: true,
  });
  expect(
    (await get(path)).messages.filter(
      (row: { content: string }) => row.content === "Racing addition",
    ),
  ).toHaveLength(1);
});

it("enforces authentication, Bot/Task ownership, stable payloads and visible input capacity failures", async () => {
  const service = await startPiService(() => ({ text: "Reply" }));
  try {
    await start(
      piRunDriver(new PiProvider({ modelRuntime: service.runtime, model: service.model })),
    );
    const path = "/api/bots/personal/thread";
    expect((await fetch(`${base}${path}`)).status).toBe(401);
    expect(
      (
        await fetch(`${base}${path}`, {
          headers: { ...headers, Origin: "https://untrusted.invalid" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await post(`${path}/messages`, { requestId: "override", text: "Ignore", model: "other" }))
        .status,
    ).toBe(400);
    expect(
      (await post("/api/bots/missing/thread/messages", { requestId: "missing", text: "Missing" }))
        .status,
    ).toBe(404);
    const huge = "Required instruction ".repeat(1500);
    const admitted = await (
      await post(`${path}/messages`, { requestId: "too-large", text: huge })
    ).json();
    await vi.waitFor(async () =>
      expect((await get(path)).tasks[0].runs[0]).toMatchObject({
        state: "failed",
        outcome: { reply: "Required Run input exceeds model capacity." },
      }),
    );
    expect((await get(path)).tasks[0].runs[0].inputs[0]).toMatchObject({ truncated: true });
    let inputPage = await get(`/api/bots/personal/runs/${admitted.runId}/history?kind=inputs`);
    let original = inputPage.records[0].text;
    while (inputPage.records[0].nextTextOffset !== null) {
      inputPage = await get(
        `/api/bots/personal/runs/${admitted.runId}/history?kind=inputs&recordId=${admitted.messageId}&textOffset=${inputPage.records[0].nextTextOffset}`,
      );
      original += inputPage.records[0].text;
    }
    expect(original).toBe(huge);
    expect(service.requests).toHaveLength(0);
    expect(
      (await post(`${path}/messages`, { requestId: "too-large", text: "Changed" })).status,
    ).toBe(409);
    const other = await (
      await post("/api/bots", {
        requestId: "isolated-bot",
        name: "Writer",
        instructions: "Write",
        model: { provider: "deepseek", id: "deepseek-chat" },
        tools: [],
      })
    ).json();
    expect(
      (
        await post(`/api/bots/${other.bot.id}/tasks/${admitted.taskId}/inputs`, {
          requestId: "cross-bot",
          text: "Forbidden",
        })
      ).status,
    ).toBe(404);
  } finally {
    await host?.stop();
    await service.close();
  }
});

it("recovers admission persisted before mailbox publication without creating a second Task", async () => {
  const configuration = await start();
  const { mkdir, symlink } = await import("node:fs/promises");
  const context = join(root, "data", "sessions", "personal", ".context");
  await mkdir(join(root, "data", "sessions", "personal"), { recursive: true });
  await symlink(root, context);
  const request = { requestId: "admit-before-publish", text: "Retain this admission" };
  expect((await post("/api/bots/personal/thread/messages", request)).status).toBe(503);
  await rm(context);
  await channel.close();
  await host.stop();
  host = await Host.start({ root, configuration, driver: new MailboxDriver() });
  await listen(configuration);
  const recovered = await (await post("/api/bots/personal/thread/messages", request)).json();
  expect(recovered.replayed).toBe(true);
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("succeeded"),
  );
  expect((await get("/api/bots/personal/thread")).tasks).toHaveLength(1);
  expect(
    (await get("/api/bots/personal/thread")).messages.filter(
      (row: { role: string }) => row.role === "user",
    ),
  ).toHaveLength(1);
});

it("presents one original assistant reply for a final result that answers multiple steered inputs", async () => {
  const release = Promise.withResolvers<void>();
  const service = await startPiService(async (request) => {
    if (!request.messages.some((row) => row.role === "tool")) {
      await release.promise;
      return { tool: "read", arguments: { path: "missing.txt" } };
    }
    return { text: "One final answer for the steered work" };
  });
  try {
    await start(
      piRunDriver(new PiProvider({ modelRuntime: service.runtime, model: service.model })),
    );
    const path = "/api/bots/personal/thread";
    const first = await (
      await post(`${path}/messages`, { requestId: "group-source", text: "Inspect" })
    ).json();
    await service.waitForRequest();
    await post(`/api/bots/personal/tasks/${first.taskId}/inputs`, {
      requestId: "group-steering",
      text: "Include this instruction",
    });
    await vi.waitFor(async () => expect((await host.inspect(first.runId)).inputs).toHaveLength(2));
    release.resolve();
    await vi.waitFor(async () =>
      expect((await get(path)).tasks[0].runs[0].state).toBe("succeeded"),
    );
    expect(
      (await get(path)).tasks[0].runs[0].inputs.every(
        (row: { outcome: { kind: string } }) => row.outcome.kind === "succeeded",
      ),
    ).toBe(true);
    expect(
      (await get(path)).messages.filter((row: { role: string }) => row.role === "assistant"),
    ).toHaveLength(1);
  } finally {
    release.resolve();
    await host?.stop();
    await service.close();
  }
});

it("retains original replies when projection is interrupted between input outcome and Thread persistence", async () => {
  await start();
  const checkpoint = new DatabaseSync(join(root, "data", "host.db"));
  try {
    checkpoint.exec(`CREATE TRIGGER interrupted_projection BEFORE INSERT ON thread_messages WHEN NEW.role = 'assistant'
   BEGIN SELECT RAISE(ABORT, 'projection interrupted'); END;`);
    const admitted = await (
      await post("/api/bots/personal/thread/messages", {
        requestId: "projection",
        text: "Original needed",
      })
    ).json();
    await vi.waitFor(async () =>
      expect((await host.inspect(admitted.runId)).outputs).toHaveLength(1),
    );
    await fetch(`${base}/api/bots/personal/thread`, { headers });
    checkpoint.exec("DROP TRIGGER interrupted_projection");
    await vi.waitFor(async () =>
      expect((await get("/api/bots/personal/thread")).messages).toContainEqual(
        expect.objectContaining({ role: "assistant", content: "Reply: Original needed" }),
      ),
    );
  } finally {
    checkpoint.close();
  }
});

it("shows stopping until the selected Run terminates and then retains its history", async () => {
  const external = new MailboxDriver();
  const release = Promise.withResolvers<void>();
  external.respond = async (_input, _material, signal) => {
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return "Final: Stop this work";
  };
  const driver: SessionDriver = {
    start: async (material, signal) => {
      const handle = await external.start(material, signal);
      return {
        wait: handle.wait,
        stop: async () => {
          await release.promise;
          await handle.stop();
        },
      };
    },
  };
  try {
    await start(driver);
    const path = "/api/bots/personal/thread";
    const admitted = await (
      await post(`${path}/messages`, { requestId: "stop-source", text: "Stop this work" })
    ).json();
    await vi.waitFor(async () => expect((await get(path)).tasks[0].runs[0].state).toBe("active"));
    const stopping = await (
      await post(`/api/bots/personal/runs/${admitted.runId}/stop`, { requestId: "stop-work" })
    ).json();
    expect(stopping).toMatchObject({
      requestId: "stop-work",
      runId: admitted.runId,
      taskId: admitted.taskId,
      state: "stopping",
      replayed: false,
    });
    expect((await get(path)).tasks[0].runs[0]).toMatchObject({
      state: "stopping",
      inputs: [{ text: "Stop this work" }],
    });
    expect((await get(path)).messages).toContainEqual(
      expect.objectContaining({ role: "user", content: "Stop this work" }),
    );
    release.resolve();
    await vi.waitFor(async () =>
      expect((await get(path)).tasks[0].runs[0]).toMatchObject({
        state: "closed",
        held: false,
        outcome: { kind: "cancelled", reply: "Stopped before a final result." },
      }),
    );
    expect(
      await (
        await post(`/api/bots/personal/runs/${admitted.runId}/stop`, {
          requestId: "stop-work",
        })
      ).json(),
    ).toMatchObject({ runId: admitted.runId, replayed: true });
    expect((await get(path)).tasks[0].runs).toHaveLength(1);
  } finally {
    release.resolve();
  }
});

it("retains the Bot slot after an unconfirmed stop while another Bot finishes", async () => {
  const external = new MailboxDriver();
  external.respond = async (input, _material, signal) => {
    if (input.content === "Hold")
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    return `Final: ${input.content}`;
  };
  let ownerStops = 0;
  const driver: SessionDriver = {
    start: async (material, signal) => {
      const handle = await external.start(material, signal);
      return {
        wait: handle.wait,
        stop: async () => {
          ownerStops += 1;
          if (ownerStops === 1) throw new Error("Controlled stop failure");
          await handle.stop();
        },
      };
    },
  };
  await start(driver);
  const path = "/api/bots/personal/thread";
  const admitted = await (
    await post(`${path}/messages`, { requestId: "hold-stop", text: "Hold" })
  ).json();
  await vi.waitFor(async () => expect((await get(path)).tasks[0].runs[0].state).toBe("active"));
  expect(
    (await post(`/api/bots/personal/tasks/${admitted.taskId}/stop`, { requestId: "fail-stop" }))
      .status,
  ).toBe(202);
  await vi.waitFor(async () =>
    expect((await get(path)).tasks[0].runs[0]).toMatchObject({
      state: "stopping",
      stopError: "Execution stop unconfirmed; Bot capacity retained",
    }),
  );
  const queued = await (
    await post(`${path}/tasks`, { requestId: "same-bot-queued", text: "After failed stop" })
  ).json();
  const bot = await (
    await post("/api/bots", {
      requestId: "writer-during-stop",
      name: "Writer",
      instructions: "Write",
      model: { provider: "deepseek", id: "deepseek-chat" },
      tools: [],
    })
  ).json();
  await post(`/api/bots/${bot.bot.id}/thread/messages`, {
    requestId: "writer-progress",
    text: "Writer continues",
  });
  await vi.waitFor(async () =>
    expect((await get(`/api/bots/${bot.bot.id}/thread`)).tasks[0].runs[0].state).toBe("succeeded"),
  );
  expect((await get(path)).tasks[1]).toMatchObject({
    id: queued.taskId,
    runs: [{ id: queued.runId, state: "queued", attempts: [] }],
  });
  expect((await get(path)).tasks[0].runs[0].state).toBe("stopping");
  expect(external.launches.map((row) => row.material.key.sessionId)).toContain(admitted.runId);
  expect(external.launches.some((row) => row.material.key.sessionId === queued.runId)).toBe(false);
});

it("releases capacity after confirmed stop, holds the uncertain Run, and retries a linked Run", async () => {
  const external = new MailboxDriver();
  const release = Promise.withResolvers<void>();
  const releaseRetry = Promise.withResolvers<void>();
  let gaps = 0;
  external.respond = async (input, material, signal) => {
    if (input.content === "Gap") {
      gaps += 1;
      if (gaps === 1) {
        new RunnerMailbox(material.directory).acknowledge(input.id, "completed");
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
      } else
        await Promise.race([
          releaseRetry.promise,
          new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          }),
        ]);
    }
    return `Final: ${input.content}`;
  };
  const driver: SessionDriver = {
    start: async (material, signal) => {
      const handle = await external.start(material, signal);
      return {
        wait: handle.wait,
        stop: async () => {
          await release.promise;
          await handle.stop();
        },
      };
    },
  };
  try {
    await start(driver);
    const path = "/api/bots/personal/thread";
    const admitted = await (
      await post(`${path}/messages`, { requestId: "gap-stop", text: "Gap" })
    ).json();
    await vi.waitFor(() => expect(gaps).toBe(1));
    await post(`/api/bots/personal/runs/${admitted.runId}/stop`, { requestId: "confirm-stop" });
    expect((await get(path)).tasks[0].runs[0].state).toBe("stopping");
    release.resolve();
    await vi.waitFor(
      async () =>
        expect((await get(path)).thread.routineHolds).toEqual([
          { taskId: admitted.taskId, runId: admitted.runId },
        ]),
      { timeout: 5000 },
    );
    expect(
      (await post(`/api/bots/personal/runs/${admitted.runId}/stop`, { requestId: "stop-held" }))
        .status,
    ).toBe(409);
    expect((await get(path)).tasks[0].runs[0]).toMatchObject({
      state: "uncertain",
      held: true,
      outcome: { kind: "uncertain", reply: "Final evidence is missing." },
    });
    const unrelated = await (
      await post(`${path}/tasks`, { requestId: "unrelated-after-stop", text: "Unrelated" })
    ).json();
    await vi.waitFor(async () =>
      expect((await get(path)).tasks[1].runs[0]).toMatchObject({
        id: unrelated.runId,
        state: "succeeded",
        outcome: { kind: "succeeded", reply: "Final: Unrelated" },
      }),
    );
    expect((await get(path)).tasks[0].runs[0]).toMatchObject({
      id: admitted.runId,
      state: "uncertain",
      held: true,
    });
    const ordinary = await (
      await post(`${path}/messages`, { requestId: "ordinary-not-retry", text: "Not a retry" })
    ).json();
    expect(ordinary.taskId).not.toBe(admitted.taskId);
    expect((await get(path)).tasks[0].runs).toHaveLength(1);
    const retries = await Promise.all(
      Array.from({ length: 4 }, () =>
        post(`/api/bots/personal/runs/${admitted.runId}/retry`, { requestId: "retry-once" }).then(
          (response) => response.json(),
        ),
      ),
    );
    expect(new Set(retries.map((row) => row.runId)).size).toBe(1);
    expect(retries.filter((row) => row.replayed)).toHaveLength(3);
    const retried = retries[0];
    expect(retried).toMatchObject({ priorRunId: admitted.runId, taskId: admitted.taskId });
    expect(
      (await post(`/api/bots/personal/runs/${admitted.runId}/retry`, { requestId: "retry-again" }))
        .status,
    ).toBe(409);
    releaseRetry.resolve();
    await vi.waitFor(
      async () =>
        expect((await get(path)).tasks[0].runs[1]).toMatchObject({
          id: retried.runId,
          priorRunId: admitted.runId,
          state: "succeeded",
          outcome: { kind: "succeeded", reply: "Final: Gap" },
        }),
      { timeout: 5000 },
    );
    expect((await get(path)).tasks[0].runs[0]).toMatchObject({
      id: admitted.runId,
      state: "closed",
      held: false,
      outcome: { kind: "uncertain", reply: "Final evidence is missing." },
    });
    expect((await get(path)).thread.routineHolds).toEqual([]);
    expect(
      (await get(path)).tasks[0].runs.filter((run: { state: string }) =>
        ["queued", "active", "stopping", "uncertain"].includes(run.state),
      ),
    ).toHaveLength(0);
  } finally {
    release.resolve();
    releaseRetry.resolve();
  }
});

it("closes uncertain work without a new Run and keeps a late result from reviving it", async () => {
  const external = new MailboxDriver();
  external.respond = async (input, _material, signal) => {
    if (input.content === "Cancel me")
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    return `Final: ${input.content}`;
  };
  const release = Promise.withResolvers<void>();
  const driver: SessionDriver = {
    start: async (material, signal) => {
      const handle = await external.start(material, signal);
      return {
        wait: handle.wait,
        stop: async () => {
          await release.promise;
          await handle.stop();
        },
      };
    },
  };
  try {
    await start(driver);
    const path = "/api/bots/personal/thread";
    const admitted = await (
      await post(`${path}/messages`, { requestId: "cancel-me", text: "Cancel me" })
    ).json();
    await vi.waitFor(async () => expect((await get(path)).tasks[0].runs[0].state).toBe("active"));
    const stops = await Promise.all(
      Array.from({ length: 4 }, () =>
        post(`/api/bots/personal/runs/${admitted.runId}/stop`, { requestId: "stop-once" }).then(
          (response) => response.json(),
        ),
      ),
    );
    expect(new Set(stops.map((row) => row.runId)).size).toBe(1);
    expect(stops.filter((row) => row.replayed)).toHaveLength(3);
    expect((await get(path)).tasks[0].runs[0].state).toBe("stopping");
    release.resolve();
    await vi.waitFor(async () => expect((await get(path)).tasks[0].runs[0].state).toBe("closed"));
    const directory = external.launches[0]?.material.directory;
    if (!directory) throw new Error("Stopped run has no mailbox for late evidence");
    const input = new HostMailbox(directory).inputs()[0];
    if (!input) throw new Error("Stopped run has no input to attach late evidence");
    new RunnerMailbox(directory).reply(input, "Late evidence after stop", "message");
    await vi.waitFor(async () =>
      expect((await get(path)).tasks[0].runs[0].lateEvidence).toEqual([
        expect.objectContaining({ text: "Late evidence after stop" }),
      ]),
    );
    expect((await get(path)).tasks[0].runs[0]).toMatchObject({
      state: "closed",
      outcome: { kind: "cancelled" },
    });
    expect((await get(path)).tasks).toHaveLength(1);
    expect(
      (await post(`/api/bots/personal/runs/${admitted.runId}/close`, { requestId: "close-cancel" }))
        .status,
    ).toBe(409);
  } finally {
    release.resolve();
  }
});

it("continues an observed stop after restart until termination is confirmed", async () => {
  const external = new MailboxDriver();
  const release = Promise.withResolvers<void>();
  let gatedRun = "";
  const live = new Map<string, Awaited<ReturnType<MailboxDriver["start"]>>>();
  external.respond = async (input, _material, signal) => {
    if (input.content === "Hold")
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    return `Final: ${input.content}`;
  };
  const driver: ObservingSessionDriver = {
    start: async (material, signal) => {
      const handle = await external.start(material, signal);
      live.set(material.key.sessionId, handle);
      return {
        wait: handle.wait,
        stop: async () => {
          if (material.key.sessionId === gatedRun) await release.promise;
          await handle.stop();
        },
      };
    },
    list: () => external.list(),
    adopt: async (observation, material, signal) => {
      const handle = live.get(observation.key.sessionId);
      if (!handle) return external.adopt(observation, material, signal);
      return {
        ref: observation.ref,
        wait: () => handle.wait(),
        stop: async () => {
          if (observation.key.sessionId === gatedRun) await release.promise;
          await handle.stop();
        },
      };
    },
  };
  const configuration = await start(driver);
  const admitted = await (
    await post("/api/bots/personal/thread/messages", { requestId: "restart-stop", text: "Hold" })
  ).json();
  gatedRun = admitted.runId;
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("active"),
  );
  await post(`/api/bots/personal/runs/${admitted.runId}/stop`, { requestId: "restart-stop-op" });
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("stopping"),
  );
  await channel.close();
  await expect(host.stop({ timeoutMs: 50 })).rejects.toThrow(/timed out/);
  await rm(join(root, "data", "host.lock"), { recursive: true, force: true });
  external.observations = [
    { key: { agentGroupId: "personal", sessionId: admitted.runId }, ref: "still-live" },
  ];
  try {
    host = await Host.start({ root, configuration, driver });
    await listen(configuration);
    await vi.waitFor(async () =>
      expect((await get("/api/bots/personal/thread")).tasks[0].runs[0]).toMatchObject({
        id: admitted.runId,
        state: "stopping",
      }),
    );
    const queued = await (
      await post("/api/bots/personal/thread/tasks", {
        requestId: "queued-after-restart",
        text: "Runs after confirmation",
      })
    ).json();
    const bot = await (
      await post("/api/bots", {
        requestId: "writer-after-restart",
        name: "Writer",
        instructions: "Write",
        model: { provider: "deepseek", id: "deepseek-chat" },
        tools: [],
      })
    ).json();
    await post(`/api/bots/${bot.bot.id}/thread/messages`, {
      requestId: "writer-after-restart-message",
      text: "Other bot",
    });
    await vi.waitFor(async () =>
      expect((await get(`/api/bots/${bot.bot.id}/thread`)).tasks[0].runs[0].state).toBe(
        "succeeded",
      ),
    );
    expect((await get("/api/bots/personal/thread")).tasks[1].runs[0]).toMatchObject({
      id: queued.runId,
      state: "queued",
    });
    release.resolve();
    await vi.waitFor(async () =>
      expect((await get("/api/bots/personal/thread")).tasks[0].runs[0]).toMatchObject({
        id: admitted.runId,
        state: "closed",
        outcome: { kind: "cancelled" },
      }),
    );
    await vi.waitFor(async () =>
      expect((await get("/api/bots/personal/thread")).tasks[1].runs[0]).toMatchObject({
        id: queued.runId,
        state: "succeeded",
      }),
    );
  } finally {
    release.resolve();
  }
});

it("keeps a failed acknowledgement without output uncertain after confirmed stop", async () => {
  const external = new MailboxDriver();
  const release = Promise.withResolvers<void>();
  external.respond = async (input, material, signal) => {
    new RunnerMailbox(material.directory).acknowledge(input.id, "failed");
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return "Final that must not replace the gap";
  };
  const driver: SessionDriver = {
    start: async (material, signal) => {
      const handle = await external.start(material, signal);
      return {
        wait: handle.wait,
        stop: async () => {
          await release.promise;
          await handle.stop();
        },
      };
    },
  };
  try {
    await start(driver);
    const admitted = await (
      await post("/api/bots/personal/thread/messages", { requestId: "failed-ack", text: "Gap" })
    ).json();
    await vi.waitFor(async () =>
      expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("active"),
    );
    await post(`/api/bots/personal/runs/${admitted.runId}/stop`, { requestId: "failed-ack-stop" });
    release.resolve();
    await vi.waitFor(async () =>
      expect((await get("/api/bots/personal/thread")).tasks[0].runs[0]).toMatchObject({
        state: "uncertain",
        held: true,
        outcome: { kind: "uncertain", reply: "Final evidence is missing." },
      }),
    );
  } finally {
    release.resolve();
  }
});

it("confirms a stopped Run on restart when no container remains and closes uncertainty explicitly", async () => {
  const external = new MailboxDriver();
  let gaps = 0;
  external.respond = async (input, material, signal) => {
    if (input.content === "Gap") {
      gaps += 1;
      new RunnerMailbox(material.directory).acknowledge(input.id, "completed");
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    return `Final: ${input.content}`;
  };
  const release = Promise.withResolvers<void>();
  const driver: ObservingSessionDriver = {
    start: async (material, signal) => {
      const handle = await external.start(material, signal);
      return {
        wait: handle.wait,
        stop: async () => {
          await release.promise;
          await handle.stop();
        },
      };
    },
    list: () => external.list(),
    adopt: (observation, material, signal) => external.adopt(observation, material, signal),
  };
  const configuration = await start(driver);
  const admitted = await (
    await post("/api/bots/personal/thread/messages", { requestId: "restart-gap", text: "Gap" })
  ).json();
  await vi.waitFor(() => expect(gaps).toBe(1));
  await post(`/api/bots/personal/runs/${admitted.runId}/stop`, { requestId: "restart-gap-stop" });
  await channel.close();
  await expect(host.stop({ timeoutMs: 50 })).rejects.toThrow(/timed out/);
  await rm(join(root, "data", "host.lock"), { recursive: true, force: true });
  try {
    host = await Host.start({ root, configuration, driver: new MailboxDriver() });
    await listen(configuration);
    await vi.waitFor(async () =>
      expect((await get("/api/bots/personal/thread")).tasks[0].runs[0]).toMatchObject({
        id: admitted.runId,
        state: "uncertain",
        held: true,
      }),
    );
    const closed = await (
      await post(`/api/bots/personal/runs/${admitted.runId}/close`, { requestId: "close-gap" })
    ).json();
    expect(closed).toMatchObject({ runId: admitted.runId, operation: "close", replayed: false });
    expect((await get("/api/bots/personal/thread")).tasks[0].runs[0]).toMatchObject({
      id: admitted.runId,
      state: "closed",
      held: false,
      outcome: { kind: "uncertain", reply: "Final evidence is missing." },
    });
    expect((await get("/api/bots/personal/thread")).tasks[0].runs).toHaveLength(1);
    expect((await get("/api/bots/personal/thread")).thread.routineHolds).toEqual([]);
    const next = await (
      await post("/api/bots/personal/thread/messages", {
        requestId: "after-close",
        text: "After close",
      })
    ).json();
    expect(next.taskId).not.toBe(admitted.taskId);
    await vi.waitFor(async () =>
      expect((await get("/api/bots/personal/thread")).tasks[1].runs[0].state).toBe("succeeded"),
    );
    expect(
      await (
        await post(`/api/bots/personal/runs/${admitted.runId}/close`, { requestId: "close-gap" })
      ).json(),
    ).toMatchObject({ replayed: true, runId: admitted.runId });
  } finally {
    release.resolve();
  }
});

it("requires fresh records for the old execution model while retaining deployment credentials", async () => {
  root = await mkdtemp(join(tmpdir(), "mybots-fresh-cutover-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(root, "data"));
  const old = new DatabaseSync(join(root, "data", "host.db"));
  old.exec(
    "CREATE TABLE sessions (id TEXT PRIMARY KEY); INSERT INTO sessions VALUES ('old-execution'); PRAGMA user_version = 7;",
  );
  old.close();
  await writeFile(join(root, "data", "client-credential"), "preserved-connection-credential");
  await writeFile(join(root, ".env"), "MODEL_CONFIGURATION=preserved\n");
  const { configuration } = await loadHostSettings("examples/host/host.json");
  await expect(Host.start({ root, configuration, driver: new MailboxDriver() })).rejects.toThrow(
    "Fresh execution state required",
  );
  expect(await readFile(join(root, "data", "client-credential"), "utf8")).toBe(
    "preserved-connection-credential",
  );
  expect(await readFile(join(root, ".env"), "utf8")).toBe("MODEL_CONFIGURATION=preserved\n");
});
