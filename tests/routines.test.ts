import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerMailbox } from "@mybots/mailbox/node";
import { afterEach, expect, it, vi } from "vitest";
import { PiProvider } from "../packages/agent-runner/src/providers/pi.ts";
import { WebSocketChannel } from "../packages/host/src/channels/websocket.ts";
import { loadHostSettings } from "../packages/host/src/config/host.ts";
import type { SessionDriver } from "../packages/host/src/drivers/types.ts";
import { Host, type HostConfiguration } from "../packages/host/src/host.ts";
import { MailboxDriver } from "./host-fixture.ts";
import { startPiService } from "./pi-fixture.ts";
import { piRunDriver } from "./pi-run-driver.ts";

let root: string;
let host: Host;
let channel: WebSocketChannel;
let base: string;
let headers: Record<string, string>;
let now: number;
let configuration: HostConfiguration;
afterEach(async () => {
  await channel?.close();
  await host?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});
async function listen(driver: SessionDriver) {
  host = await Host.start({ root, configuration, driver, now: () => now, reconcileMs: 36000000 });
  channel = await WebSocketChannel.listen({ root, host, configuration, port: 0 });
  base = `http://127.0.0.1:${channel.address.port}`;
  headers = {
    Authorization: `Bearer ${(await readFile(join(root, "data/client-credential"), "utf8")).trim()}`,
    "Content-Type": "application/json",
  };
}
async function start(driver: SessionDriver = new MailboxDriver()) {
  root = await mkdtemp(join(tmpdir(), "mybots-routines-"));
  now = Date.parse("2026-10-20T00:00:00Z");
  configuration = (await loadHostSettings("examples/host/host.json")).configuration;
  await listen(driver);
}
function post(path: string, body: unknown) {
  return fetch(`${base}/api/bots/personal/${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}
async function get(path: string) {
  const response = await fetch(`${base}/api/bots/personal/${path}`, { headers });
  expect(response.status).toBe(200);
  return response.json();
}
const definition = {
  requestId: "morning",
  text: "Read the archive",
  runAt: "2026-10-20T09:00:00+08:00",
  timezone: "Asia/Shanghai",
};
it("creates a durable one-shot and admits one independent occurrence after an overdue restart", async () => {
  const first = new MailboxDriver();
  await start(first);
  await post("thread/messages", { requestId: "chat", text: "Private chat background" });
  await vi.waitFor(async () =>
    expect((await get("thread")).tasks[0].runs[0].state).toBe("succeeded"),
  );
  const response = await post("routines", definition);
  expect(response.status).toBe(201);
  const created = await response.json();
  expect(created).toMatchObject({
    runAt: "2026-10-20T01:00:00.000Z",
    nextOccurrence: "2026-10-20T01:00:00.000Z",
    timezone: "Asia/Shanghai",
    source: { kind: "owner" },
  });
  expect((await post("routines", definition)).status).toBe(201);
  expect((await get("routines")).routines).toHaveLength(1);
  expect(first.launches).toHaveLength(1);
  await channel.close();
  await host.stop();
  now += 2 * 3600000;
  const second = new MailboxDriver();
  await listen(second);
  await vi.waitFor(async () => expect((await get("thread")).tasks).toHaveLength(2));
  await vi.waitFor(async () =>
    expect((await get("thread")).tasks[1].runs[0].state).toBe("succeeded"),
  );
  const task = (await get("thread")).tasks[1];
  expect(task.origin).toBe("routine");
  expect(task.routine).toMatchObject({
    id: created.id,
    text: definition.text,
    runAt: created.runAt,
  });
  expect(task.runs[0].references).toEqual([]);
  expect(task.runs[0].outcome.reply).toBe("Reply: Read the archive");
  expect(task.runs[0].admissionClass).toBeNull();
  expect(second.launches).toHaveLength(1);
  const context = JSON.parse(
    await readFile(second.launches[0]?.material.contextFile as string, "utf8"),
  );
  expect(context.runContext.references).toEqual([]);
  expect((await get("routines")).routines[0]).toMatchObject({
    nextOccurrence: null,
    taskId: task.id,
  });
  await host.reconcile();
  await channel.close();
  await host.stop();
  await listen(new MailboxDriver());
  expect((await get("thread")).tasks).toHaveLength(2);
});

it("creates an own-Bot Routine through the fenced runner, deduplicates lookup and survives source cancellation", async () => {
  const driver = new MailboxDriver();
  const entered = Promise.withResolvers<void>();
  driver.respond = async (_input, _material, signal) => {
    entered.resolve();
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    return "Stopped";
  };
  await start(driver);
  const sent = await (
    await post("thread/messages", { requestId: "source", text: "Tomorrow read the archive" })
  ).json();
  await entered.promise;
  const mailbox = new RunnerMailbox(driver.launches[0]?.material.directory as string);
  async function ask(
    id: string,
    operation: string,
    input: unknown,
    incarnation = mailbox.executionIncarnation(),
  ) {
    mailbox.requestHistory({ id, operation, input, incarnation });
    return vi.waitFor(() => {
      const response = mailbox.historyResponse(id);
      expect(response).toBeDefined();
      return response as { result?: Record<string, unknown>; error?: string };
    });
  }
  const created = await ask("morning", "create_routine", definition);
  expect(created.result).toMatchObject({
    text: definition.text,
    source: { kind: "run", taskId: sent.taskId, runId: sent.runId, attemptId: expect.any(String) },
  });
  expect(
    (await ask("morning", "create_routine", { ...definition, text: "Changed" })).result,
  ).toEqual(created.result);
  expect((await ask("lookup", "read_operation", { requestId: "morning" })).result).toMatchObject({
    state: "recorded",
    routine: { id: created.result?.id },
  });
  expect(
    (await ask("forged", "create_routine", { ...definition, requestId: "forged", botId: "writer" }))
      .error,
  ).toContain("Forged execution identity");
  expect(
    (
      await ask(
        "stale",
        "create_routine",
        { ...definition, requestId: "stale" },
        mailbox.executionIncarnation() + 1,
      )
    ).error,
  ).toContain("no longer active");
  expect((await post(`runs/${sent.runId}/stop`, { requestId: "stop-source" })).status).toBe(202);
  await vi.waitFor(async () => expect((await get("thread")).tasks[0].runs[0].state).toBe("closed"));
  expect((await get("routines")).routines).toHaveLength(1);
  driver.respond = async () => "Independent archive result";
  now += 2 * 3600000;
  await host.reconcile();
  await vi.waitFor(async () =>
    expect((await get("thread")).tasks[1].runs[0].outcome.reply).toBe("Independent archive result"),
  );
});

it("rejects unresolved or invalid schedules and unauthorized creation", async () => {
  await start();
  for (const input of [
    { ...definition, runAt: "tomorrow morning" },
    { ...definition, runAt: "2026-10-20T09:00:00" },
    { ...definition, runAt: "2026-02-30T09:00:00Z" },
    { ...definition, timezone: "Unknown/Zone" },
    { ...definition, timezone: "+08:00" },
    { ...definition, text: " " },
    { ...definition, botId: "writer" },
    { ...definition, selectedMessageIds: ["missing"] },
  ])
    expect((await post("routines", input)).status).toBe("selectedMessageIds" in input ? 404 : 400);
  expect(
    (
      await fetch(`${base}/api/bots/personal/routines`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(definition),
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await fetch(`${base}/api/bots/personal/routines`, {
        headers: { ...headers, Origin: "https://other.example" },
      })
    ).status,
  ).toBe(403);
  expect((await get("routines")).routines).toEqual([]);
  expect((await post("routines", definition)).status).toBe(201);
  expect((await post("routines", { ...definition, text: "Other" })).status).toBe(409);
});

it("keeps queued and active additions on the occurrence while ordinary chat creates chat work", async () => {
  const driver = new MailboxDriver();
  const release = Promise.withResolvers<void>();
  driver.respond = async (input, _material, signal) => {
    if (input.content === "Hold chat")
      await Promise.race([
        release.promise,
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
      ]);
    return `Result: ${input.content}`;
  };
  try {
    await start(driver);
    const chat = await (
      await post("thread/messages", { requestId: "hold", text: "Hold chat" })
    ).json();
    await vi.waitFor(() => expect(driver.launches).toHaveLength(1));
    const routine = await (
      await post("routines", { ...definition, runAt: "2026-10-20T00:00:00Z" })
    ).json();
    const queued = (await get("thread")).tasks[1];
    expect(queued).toMatchObject({
      origin: "routine",
      runs: [{ state: "queued", admissionClass: "background" }],
    });
    await post(`tasks/${queued.id}/inputs`, { requestId: "extra", text: "Only shelf 3" });
    expect((await get("thread")).tasks[0].runs[0].inputs).toHaveLength(1);
    expect(
      (await get("thread")).tasks[1].runs[0].inputs.map((row: { text: string }) => row.text),
    ).toEqual(["Read the archive", "Only shelf 3"]);
    expect((await get("routines")).routines[0].text).toBe(definition.text);
    release.resolve();
    await vi.waitFor(async () =>
      expect((await get("thread")).tasks[1].runs[0].state).toBe("succeeded"),
    );
    const next = await (
      await post("thread/messages", { requestId: "after", text: "Ordinary chat" })
    ).json();
    expect(next.taskId).not.toBe(queued.id);
    expect(next.taskId).not.toBe(chat.taskId);
    expect((await get("routines")).routines[0].id).toBe(routine.id);
    await host.reconcile();
    expect(
      (await get("thread")).tasks.filter((task: { origin: string }) => task.origin === "routine"),
    ).toHaveLength(1);
  } finally {
    release.resolve();
  }
});

it("keeps occurrence bodies out of ordinary Thread background and exposes linked work summaries", async () => {
  await start();
  await post("routines", { ...definition, runAt: "2026-10-20T00:00:00Z" });
  await vi.waitFor(async () =>
    expect((await get("thread")).tasks[0].runs[0].state).toBe("succeeded"),
  );
  await post("thread/messages", {
    requestId: "chat-after-routine",
    text: "Continue ordinary conversation",
  });
  await vi.waitFor(async () =>
    expect((await get("thread")).tasks[1].runs[0].state).toBe("succeeded"),
  );
  expect((await get("thread")).tasks[1].runs[0].references).toEqual([]);
  const history = await get("thread/history");
  expect(
    history.messages.every(
      (message: { text: string }) => !message.text.includes("Read the archive"),
    ),
  ).toBe(true);
});

it("resolves natural-language creation through real Pi and steers the active independent occurrence", async () => {
  const modelEntered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const service = await startPiService(async (request) => {
    const body = JSON.stringify(request.messages);
    if (body.includes("Private source request")) {
      const tools = request.messages.filter((row) => row.role === "tool");
      if (!tools.length) return { tool: "create_routine", arguments: definition };
      if (tools.length === 1)
        return { tool: "read_operation", arguments: { requestId: definition.requestId } };
      return { text: "Scheduled for 09:00 Asia/Shanghai" };
    }
    modelEntered.resolve();
    await release.promise;
    return {
      text: body.includes("Only shelf 3") ? "Archive limited to shelf 3" : "Archive inspected",
    };
  });
  try {
    await start(
      piRunDriver(new PiProvider({ modelRuntime: service.runtime, model: service.model })),
    );
    await post("thread/messages", {
      requestId: "source-sdk",
      text: "Private source request: tomorrow at nine inspect the archive",
    });
    await vi.waitFor(async () =>
      expect((await get("thread")).tasks[0].runs[0].state).toBe("succeeded"),
    );
    expect(
      service.requests[0]?.tools?.some((tool) => tool.function.name === "create_routine"),
    ).toBe(true);
    expect((await get("routines")).routines).toHaveLength(1);
    now += 2 * 3600000;
    await host.reconcile();
    await modelEntered.promise;
    const occurrence = (await get("thread")).tasks[1];
    expect(occurrence.runs[0].references).toEqual([]);
    expect(JSON.stringify(service.requests.at(-1)?.messages)).not.toContain(
      "Private source request",
    );
    expect(
      (
        await post(`tasks/${occurrence.id}/inputs`, {
          requestId: "active-steering",
          text: "Only shelf 3",
        })
      ).status,
    ).toBe(202);
    release.resolve();
    await vi.waitFor(async () =>
      expect((await get("thread")).tasks[1].runs[0].state).toBe("succeeded"),
    );
    const completed = (await get("thread")).tasks[1].runs[0];
    expect(completed.inputs).toHaveLength(2);
    expect(
      completed.inputs.every((row: { recordedAt: string | null }) => row.recordedAt !== null),
    ).toBe(true);
    expect(completed.outcome.reply).toBe("Archive limited to shelf 3");
    expect((await get("routines")).routines[0].text).toBe(definition.text);
  } finally {
    release.resolve();
    await host?.stop();
    await service.close();
  }
}, 20000);

it("retains failure and cancellation without replaying an occurrence", async () => {
  const driver = new MailboxDriver();
  driver.respond = async () => ({ error: "Archive unavailable" });
  await start(driver);
  await post("routines", { ...definition, runAt: "2026-10-20T00:00:00Z" });
  await vi.waitFor(async () => expect((await get("thread")).tasks[0].runs[0].state).toBe("failed"));
  expect((await get("routines")).routines).toHaveLength(1);
  driver.respond = async (_input, _material, signal) => {
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    return "Late reply";
  };
  await post("routines", { ...definition, requestId: "cancelled", runAt: "2026-10-20T00:00:00Z" });
  await vi.waitFor(() => expect(driver.launches).toHaveLength(2));
  const cancelled = (await get("thread")).tasks[1].runs[0];
  await post(`runs/${cancelled.id}/stop`, { requestId: "cancel-occurrence" });
  await vi.waitFor(async () => expect((await get("thread")).tasks[1].runs[0].state).toBe("closed"));
  await channel.close();
  await host.stop();
  const restarted = new MailboxDriver();
  await listen(restarted);
  await host.reconcile();
  expect((await get("thread")).tasks).toHaveLength(2);
  expect((await get("routines")).routines).toHaveLength(2);
  expect(restarted.launches).toHaveLength(0);
});

it("holds an acknowledged uncertain occurrence across restart and permits unrelated chat after confirmed stop", async () => {
  const driver = new MailboxDriver();
  let effects = 0;
  driver.respond = async (input, material, signal) => {
    if (input.content === definition.text) {
      effects += 1;
      new RunnerMailbox(material.directory).acknowledge(input.id, "completed");
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    }
    return "Chat result";
  };
  await start(driver);
  await post("routines", { ...definition, runAt: "2026-10-20T00:00:00Z" });
  await vi.waitFor(() => expect(effects).toBe(1));
  const occurrence = (await get("thread")).tasks[0];
  const ordinary = await (
    await post("thread/messages", { requestId: "unrelated", text: "Unrelated conversation" })
  ).json();
  expect(ordinary.taskId).not.toBe(occurrence.id);
  expect((await get("thread")).tasks[1].runs[0].state).toBe("queued");
  expect((await get("thread")).tasks[0].runs[0].inputs).toHaveLength(1);
  await post(`runs/${occurrence.runs[0].id}/stop`, { requestId: "stop-gap" });
  await vi.waitFor(async () =>
    expect((await get("thread")).tasks[0].runs[0]).toMatchObject({
      state: "uncertain",
      held: true,
    }),
  );
  await vi.waitFor(async () =>
    expect((await get("thread")).tasks[1].runs[0].state).toBe("succeeded"),
  );
  await channel.close();
  await host.stop();
  await listen(driver);
  now += 86400000;
  await host.reconcile();
  expect((await get("thread")).tasks).toHaveLength(2);
  expect((await get("thread")).tasks[0].runs[0].state).toBe("uncertain");
  expect(effects).toBe(1);
});

it("retains only explicitly selected inputs in distinct occurrence contexts", async () => {
  await start();
  const chat = await (
    await post("thread/messages", { requestId: "selected", text: "Selected archive code 42" })
  ).json();
  await vi.waitFor(async () =>
    expect((await get("thread")).tasks[0].runs[0].state).toBe("succeeded"),
  );
  await post("routines", { ...definition, selectedMessageIds: [chat.messageId] });
  await post("routines", { ...definition, requestId: "separate", text: "Inspect another archive" });
  now += 2 * 3600000;
  await host.reconcile();
  await vi.waitFor(async () =>
    expect((await get("thread")).tasks[2].runs[0].state).toBe("succeeded"),
  );
  const tasks = (await get("thread")).tasks;
  expect(new Set(tasks.map((task: { id: string }) => task.id)).size).toBe(3);
  expect(new Set(tasks.map((task: { runs: { id: string }[] }) => task.runs[0]?.id)).size).toBe(3);
  expect(tasks[1].runs[0].references).toEqual([
    expect.objectContaining({ id: chat.messageId, text: "Selected archive code 42" }),
  ]);
  expect(tasks[2].runs[0].references).toEqual([]);
});

it("lets a Run reread an explicitly selected Routine result without exposing it in default Thread history", async () => {
  let selected = "";
  const driver = new MailboxDriver();
  driver.respond = async (input, material) => {
    if (input.content !== "Read selected result")
      return `Earlier Routine result: ${"detail ".repeat(400)}`;
    const mailbox = new RunnerMailbox(material.directory);
    mailbox.requestHistory({
      id: "selected-original",
      operation: "read_history",
      input: { messageId: selected, textOffset: 2000 },
      incarnation: mailbox.executionIncarnation(),
    });
    const result = await vi.waitFor(() => {
      const response = mailbox.historyResponse("selected-original");
      expect(response).toBeDefined();
      return response as {
        error?: string;
        result?: { messages: { id: string; textOffset: number; text: string }[] };
      };
    });
    if (result.error) return `History lookup failed: ${result.error}`;
    expect(result.result?.messages).toEqual([
      expect.objectContaining({
        id: selected,
        textOffset: 2000,
        text: expect.stringContaining("detail"),
      }),
    ]);
    return "Recovered selected original";
  };
  await start(driver);
  await post("routines", { ...definition, runAt: "2026-10-20T00:00:00Z" });
  await vi.waitFor(async () =>
    expect((await get("thread")).tasks[0].runs[0].state).toBe("succeeded"),
  );
  selected = (await get("thread")).tasks[0].runs[0].inputs[0].outcome.resultId;
  expect(typeof selected).toBe("string");
  expect((await get("thread/history")).messages).toEqual([]);
  await post("routines", {
    ...definition,
    requestId: "read-selected",
    text: "Read selected result",
    runAt: "2026-10-20T00:00:00Z",
    selectedMessageIds: [selected],
  });
  await vi.waitFor(async () =>
    expect((await get("thread")).tasks[1].runs[0].state).toBe("succeeded"),
  );
  expect((await get("thread")).tasks[1].runs[0].outcome.reply).toBe("Recovered selected original");
  expect((await get("thread/history")).messages).toEqual([]);
});
