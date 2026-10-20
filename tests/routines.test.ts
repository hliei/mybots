import { mkdtemp, readFile, rm, utimes } from "node:fs/promises";
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
  const edited = await post(`routines/${created.id}`, {
    requestId: "edit-consumed-instant",
    text: "Read shelf 3",
    runAt: "2026-10-21T09:00:00Z",
    timezone: "UTC",
  });
  expect(edited.status).toBe(200);
  expect(await edited.json()).toMatchObject({
    text: "Read shelf 3",
    runAt: "2026-10-21T09:00:00.000Z",
    timezone: "UTC",
    nextOccurrence: null,
  });
  expect((await get("thread")).tasks[1].routine.text).toBe(definition.text);
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

it.each(["one-shot", "cron"])(
  "resolves natural-language %s creation through real Pi and steers only the selected occurrence",
  async (mode) => {
    const modelEntered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const service = await startPiService(async (request) => {
      const body = JSON.stringify(request.messages);
      if (body.includes("Private source request")) {
        const tools = request.messages.filter((row) => row.role === "tool");
        if (!tools.length)
          return {
            tool: "create_routine",
            arguments:
              mode === "cron"
                ? { requestId: definition.requestId, text: definition.text, cron: "0 * * * *" }
                : definition,
          };
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
      if (mode === "cron") {
        await vi.waitFor(async () =>
          expect((await get("routines")).routines[0].nextOccurrence).toBe(
            "2026-10-20T03:00:00.000Z",
          ),
        );
        now += 3600000;
        await host.reconcile();
        await vi.waitFor(async () =>
          expect((await get("thread")).tasks[2].runs[0].state).toBe("succeeded"),
        );
        const second = (await get("thread")).tasks[2];
        expect(second.id).not.toBe(occurrence.id);
        expect(second.runs[0].outcome.reply).toBe("Archive inspected");
        expect(JSON.stringify(service.requests.at(-1)?.messages)).not.toContain("Only shelf 3");
        expect(JSON.stringify(service.requests.at(-1)?.messages)).not.toContain(
          "Private source request",
        );
        expect(second.runs[0].references).toEqual([]);
      }
    } finally {
      release.resolve();
      await host?.stop();
      await service.close();
    }
  },
  20000,
);

it("retains failure and cancellation without replaying an occurrence", async () => {
  const external = new MailboxDriver();
  const entered = Promise.withResolvers<void>();
  const registerListener = Promise.withResolvers<void>();
  let cancelledRunId: string | undefined;
  external.respond = async (input, _material, signal) => {
    if (input.content !== "Cancel archive work") return { error: "Archive unavailable" };
    entered.resolve();
    await registerListener.promise;
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return "Late reply";
  };
  const driver: SessionDriver = {
    start: async (material, signal) => {
      const handle = await external.start(material, signal);
      return {
        ...handle,
        stop: async () => {
          const stopped = handle.stop();
          // Deliver cancellation before the controlled executor registers its listener.
          if (material.key.sessionId === cancelledRunId) registerListener.resolve();
          await stopped;
        },
      };
    },
  };
  try {
    await start(driver);
    await post("routines", { ...definition, runAt: "2026-10-20T00:00:00Z" });
    await vi.waitFor(async () =>
      expect((await get("thread")).tasks[0].runs[0].state).toBe("failed"),
    );
    expect((await get("routines")).routines).toHaveLength(1);
    await post("routines", {
      ...definition,
      requestId: "cancelled",
      text: "Cancel archive work",
      runAt: "2026-10-20T00:00:00Z",
    });
    await entered.promise;
    cancelledRunId = (await get("thread")).tasks[1].runs[0].id;
    await post(`runs/${cancelledRunId}/stop`, { requestId: "cancel-occurrence" });
    await vi.waitFor(async () =>
      expect((await get("thread")).tasks[1].runs[0].state).toBe("closed"),
    );
    await channel.close();
    await host.stop();
    const restarted = new MailboxDriver();
    await listen(restarted);
    await host.reconcile();
    expect((await get("thread")).tasks).toHaveLength(2);
    expect((await get("routines")).routines).toHaveLength(2);
    expect(restarted.launches).toHaveLength(0);
  } finally {
    registerListener.resolve();
  }
});

it.each(["one-shot", "cron"])(
  "holds an acknowledged uncertain %s occurrence across restart and permits unrelated chat after confirmed stop",
  async (mode) => {
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
    await post(
      "routines",
      mode === "cron"
        ? { requestId: "uncertain-cron", text: definition.text, cron: "* * * * *" }
        : { ...definition, runAt: "2026-10-20T00:00:00Z" },
    );
    if (mode === "cron") {
      now += 60000;
      await host.reconcile();
    }
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
  },
);

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

it("creates a validated cron Routine using the Bot timezone fallback and retains request identity", async () => {
  await start();
  const input = { requestId: "daily", text: "Morning archive", cron: "0 9 * * *" };
  const response = await post("routines", input);
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({
    cron: "0 9 * * *",
    timezone: "Asia/Shanghai",
    runAt: "2026-10-20T01:00:00.000Z",
    nextOccurrence: "2026-10-20T01:00:00.000Z",
    occurrences: [],
  });
  expect((await post("routines", input)).status).toBe(201);
  expect((await post("routines", { ...input, cron: "0 10 * * *" })).status).toBe(409);
  for (const cron of ["tomorrow", "0 0 9 * * *", "60 * * * *", "0 0 30 2 *", "@daily", "H * * * *"])
    expect((await post("routines", { ...input, requestId: "invalid", cron })).status).toBe(400);
  expect((await post("routines", { ...input, timezone: "UTC" })).status).toBe(400);
  expect((await post("routines", { ...input, runAt: definition.runAt })).status).toBe(400);
  expect((await get("routines")).routines).toHaveLength(1);
});

it("runs one overdue cron occurrence after restart, skips busy slots and continues after failure", async () => {
  const driver = new MailboxDriver();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  driver.respond = async (_input, _material, signal) => {
    entered.resolve();
    await Promise.race([
      release.promise,
      new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    ]);
    return { error: "Archive unavailable" };
  };
  try {
    await start();
    const created = await (
      await post("routines", { requestId: "hourly", text: "Archive hourly", cron: "* * * * *" })
    ).json();
    await channel.close();
    await host.stop();
    now = Date.parse("2026-10-23T03:30:00Z");
    await listen(driver);
    await entered.promise;
    let tasks = (await get("thread")).tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].routine).toMatchObject({
      id: created.id,
      nextOccurrence: "2026-10-20T00:01:00.000Z",
    });
    now = Date.parse("2026-10-23T03:31:00Z");
    new RunnerMailbox(driver.launches[0]?.material.directory as string).touch();
    const heartbeat = join(driver.launches[0]?.material.directory as string, ".heartbeat");
    await utimes(heartbeat, new Date(now), new Date(now));
    await host.reconcile();
    expect((await get("thread")).tasks).toHaveLength(1);
    release.resolve();
    await vi.waitFor(async () =>
      expect((await get("thread")).tasks[0].runs[0].state).toBe("failed"),
    );
    await vi.waitFor(async () =>
      expect((await get("routines")).routines[0].nextOccurrence).toBe("2026-10-23T03:32:00.000Z"),
    );
    now = Date.parse("2026-10-23T03:32:00Z");
    await host.reconcile();
    await vi.waitFor(async () =>
      expect((await get("thread")).tasks[1].runs[0].state).toBe("failed"),
    );
    tasks = (await get("thread")).tasks;
    expect(tasks).toHaveLength(2);
    expect(tasks[1].id).not.toBe(tasks[0].id);
    expect(tasks[1].runs[0].id).not.toBe(tasks[0].runs[0].id);
    expect(tasks[1].runs[0].references).toEqual([]);
    expect((await get("routines")).routines[0].occurrences).toEqual([
      { taskId: tasks[0].id, dueAt: "2026-10-20T00:01:00.000Z" },
      { taskId: tasks[1].id, dueAt: "2026-10-23T03:32:00.000Z" },
    ]);
    await channel.close();
    await host.stop();
    await listen(new MailboxDriver());
    expect((await get("thread")).tasks).toHaveLength(2);
  } finally {
    release.resolve();
  }
});

it("applies Bot timezone edits immediately to future cron scheduling while admitted definitions and one-shots stay fixed", async () => {
  const driver = new MailboxDriver();
  const release = Promise.withResolvers<void>();
  driver.respond = async (_input, _material, signal) => {
    await Promise.race([
      release.promise,
      new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    ]);
    return "Archive done";
  };
  try {
    await start(driver);
    await post("routines", { requestId: "daily", text: "Daily archive", cron: "0 9 * * *" });
    await post("routines", { ...definition, requestId: "one-shot" });
    expect((await post("timezone", { requestId: "utc", timezone: "UTC" })).status).toBe(200);
    expect(await get("routines")).toMatchObject({
      timezone: "UTC",
      routines: [
        { nextOccurrence: "2026-10-20T09:00:00.000Z", timezone: "UTC" },
        { nextOccurrence: "2026-10-20T01:00:00.000Z", timezone: "Asia/Shanghai" },
      ],
    });
    expect((await post("timezone", { requestId: "utc", timezone: "UTC" })).status).toBe(200);
    expect((await post("timezone", { requestId: "utc", timezone: "Asia/Tokyo" })).status).toBe(409);
    expect((await post("timezone", { requestId: "bad", timezone: "+08:00" })).status).toBe(400);
    now = Date.parse("2026-10-20T09:00:00Z");
    await host.reconcile();
    await vi.waitFor(() => expect(driver.launches).toHaveLength(1));
    const before = (await get("thread")).tasks;
    await post("timezone", { requestId: "ny", timezone: "America/New_York" });
    expect((await get("thread")).tasks).toEqual(before);
    expect((await get("routines")).routines[0]).toMatchObject({
      timezone: "America/New_York",
      nextOccurrence: null,
    });
    release.resolve();
    await vi.waitFor(async () =>
      expect(
        (await get("thread")).tasks.every(
          (t: { runs: { state: string }[] }) => t.runs[0]?.state === "succeeded",
        ),
      ).toBe(true),
    );
    await vi.waitFor(async () =>
      expect((await get("routines")).routines[0].nextOccurrence).toBe("2026-10-20T13:00:00.000Z"),
    );
    await channel.close();
    await host.stop();
    await listen(new MailboxDriver());
    expect((await get("routines")).timezone).toBe("America/New_York");
  } finally {
    release.resolve();
  }
});

it.each([
  ["2026-03-08T00:00:00Z", "30 2 * * *", "2026-03-08T07:30:00.000Z"],
  ["2026-03-08T07:30:00Z", "30 2 * * *", "2026-03-09T06:30:00.000Z"],
  ["2026-11-01T00:00:00Z", "30 1 * * *", "2026-11-01T05:30:00.000Z"],
  ["2026-11-01T05:30:00Z", "30 1 * * *", "2026-11-02T06:30:00.000Z"],
  ["2026-11-01T06:10:00Z", "30 1 * * *", "2026-11-01T06:30:00.000Z"],
])("resolves DST using the pinned parser policy from %s", async (date, cron, expected) => {
  await start();
  now = Date.parse(date);
  await post("timezone", { requestId: "dst-zone", timezone: "America/New_York" });
  const response = await post("routines", { requestId: "dst", text: "DST archive", cron });
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({
    timezone: "America/New_York",
    nextOccurrence: expected,
  });
});

it("holds a cron Routine through queue, question wait and restart while owner additions stay on the selected Task", async () => {
  const driver = new MailboxDriver();
  const release = Promise.withResolvers<void>();
  driver.respond = async (_input, _material, signal) => {
    await Promise.race([
      release.promise,
      new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    ]);
    return "Done";
  };
  try {
    await start(driver);
    await post("thread/messages", { requestId: "hold-chat", text: "Hold chat" });
    await vi.waitFor(() => expect(driver.launches).toHaveLength(1));
    await post("routines", {
      requestId: "wait-cron",
      text: "Archive with question",
      cron: "* * * * *",
    });
    now += 60000;
    await host.reconcile();
    expect((await get("thread")).tasks[1].runs[0].state).toBe("queued");
    now += 60000;
    new RunnerMailbox(driver.launches[0]?.material.directory as string).touch();
    const heartbeat = join(driver.launches[0]?.material.directory as string, ".heartbeat");
    await utimes(heartbeat, new Date(now), new Date(now));
    await host.reconcile();
    expect((await get("thread")).tasks).toHaveLength(2);
    release.resolve();
    await vi.waitFor(async () =>
      expect((await get("thread")).tasks[1].runs[0].state).toBe("succeeded"),
    );
    // The following occurrence requests a durable question through the production mailbox.
    driver.respond = async (_input, material, signal) => {
      const mailbox = new RunnerMailbox(material.directory);
      mailbox.requestHistory({
        id: "archive-question",
        operation: "ask_question",
        input: { requestId: "archive-question", text: "Which shelf?" },
        incarnation: mailbox.executionIncarnation(),
      });
      await vi.waitFor(() => expect(mailbox.historyResponse("archive-question")).toBeDefined());
      mailbox.requestDurableWait("owner-question");
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return "Waiting";
    };
    now += 60000;
    await host.reconcile();
    await vi.waitFor(async () =>
      expect((await get("thread")).tasks[2].runs[0].state).toBe("waiting"),
    );
    const waiting = (await get("thread")).tasks[2];
    await channel.close();
    await host.stop();
    now += 86400000;
    await listen(new MailboxDriver());
    expect((await get("thread")).tasks).toHaveLength(3);
    expect(
      (
        await post(`tasks/${waiting.id}/inputs`, {
          requestId: "waiting-extra",
          text: "Only shelf 3",
        })
      ).status,
    ).toBe(202);
    expect((await get("thread")).tasks[2].runs[0]).toMatchObject({
      state: "waiting",
      inputs: [expect.anything(), expect.objectContaining({ text: "Only shelf 3" })],
    });
    expect((await get("routines")).routines[0]).toMatchObject({
      text: "Archive with question",
      nextOccurrence: null,
    });
  } finally {
    release.resolve();
  }
});

it("rejects retry of an older occurrence while the same Routine has another unfinished Task", async () => {
  const driver = new MailboxDriver();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  driver.respond = async (_input, _material, signal) => {
    if (++calls === 1) return { error: "First failure" };
    await Promise.race([
      release.promise,
      new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    ]);
    return "Second done";
  };
  try {
    await start(driver);
    await post("routines", { requestId: "retry-cron", text: "Archive", cron: "* * * * *" });
    now += 60000;
    await host.reconcile();
    await vi.waitFor(async () =>
      expect((await get("thread")).tasks[0].runs[0].state).toBe("failed"),
    );
    await vi.waitFor(async () =>
      expect((await get("routines")).routines[0].nextOccurrence).not.toBeNull(),
    );
    now += 60000;
    await host.reconcile();
    await vi.waitFor(() => expect(calls).toBe(2));
    const tasks = (await get("thread")).tasks;
    expect(
      (await post(`runs/${tasks[0].runs[0].id}/retry`, { requestId: "old-retry" })).status,
    ).toBe(409);
    expect((await get("thread")).tasks[0].runs).toHaveLength(1);
  } finally {
    release.resolve();
  }
});

it("discards slots missed during an explicit occurrence retry", async () => {
  const driver = new MailboxDriver();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  driver.respond = async (_input, _material, signal) => {
    if (++calls === 1) return { error: "First failure" };
    await Promise.race([
      release.promise,
      new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    ]);
    return "Retried archive";
  };
  try {
    await start(driver);
    await post("routines", { requestId: "retry-gap-cron", text: "Archive", cron: "* * * * *" });
    now += 60000;
    await host.reconcile();
    await vi.waitFor(async () =>
      expect((await get("thread")).tasks[0].runs[0].state).toBe("failed"),
    );
    await vi.waitFor(async () =>
      expect((await get("routines")).routines[0].nextOccurrence).toBe("2026-10-20T00:02:00.000Z"),
    );
    const run = (await get("thread")).tasks[0].runs[0];
    expect((await post(`runs/${run.id}/retry`, { requestId: "retry-before-next" })).status).toBe(
      202,
    );
    await vi.waitFor(() => expect(calls).toBe(2));
    now += 120000;
    await host.reconcile();
    release.resolve();
    await vi.waitFor(async () =>
      expect((await get("thread")).tasks[0].runs[1].state).toBe("succeeded"),
    );
    await vi.waitFor(async () =>
      expect((await get("routines")).routines[0].nextOccurrence).toBe("2026-10-20T00:04:00.000Z"),
    );
    expect((await get("thread")).tasks).toHaveLength(1);
  } finally {
    release.resolve();
  }
});

it("applies Routine edits only to newly admitted occurrences while Bot settings cut over at the Attempt boundary", async () => {
  const driver = new MailboxDriver();
  const release = Promise.withResolvers<void>();
  driver.respond = async (_input, _material, signal) => {
    await Promise.race([
      release.promise,
      new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    ]);
    return "Archive inspected";
  };
  try {
    await start(driver);
    const created = await (
      await post("routines", {
        requestId: "edit-cron",
        text: "Read the archive",
        cron: "0 * * * *",
      })
    ).json();
    now += 3600000;
    await host.reconcile();
    await vi.waitFor(async () =>
      expect((await get("thread")).tasks[0].runs[0].state).toBe("active"),
    );
    const admitted = (await get("thread")).tasks[0];
    expect(admitted.routine).toMatchObject({ text: "Read the archive", cron: "0 * * * *" });
    const version = admitted.runs[0].attempts[0].configurationVersion;
    const edited = await post(`routines/${created.id}`, {
      requestId: "edit-text",
      text: "Read shelf 3",
      cron: "30 * * * *",
    });
    expect(edited.status).toBe(200);
    expect(await edited.json()).toMatchObject({
      id: created.id,
      text: "Read shelf 3",
      cron: "30 * * * *",
      replayed: false,
    });
    expect(
      (
        await post(`routines/${created.id}`, {
          requestId: "edit-text",
          text: "Read shelf 3",
          cron: "30 * * * *",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(`routines/${created.id}`, {
          requestId: "edit-text",
          text: "Different",
          cron: "30 * * * *",
        })
      ).status,
    ).toBe(409);
    expect((await get("thread")).tasks[0].routine.text).toBe("Read the archive");
    expect((await get("routines")).routines[0]).toMatchObject({
      text: "Read shelf 3",
      cron: "30 * * * *",
    });
    const settings = await fetch(`${base}/api/bots/personal/settings`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: "settings-during-occurrence",
        instructions: "Cite every source.",
        model: {
          provider: configuration.agent.model.provider,
          id: configuration.agent.model.id,
        },
        tools: ["read"],
      }),
    });
    expect(settings.status).toBe(201);
    expect((await get("thread")).tasks[0].runs[0].attempts[0].configurationVersion).toBe(version);
    release.resolve();
    await vi.waitFor(async () =>
      expect((await get("thread")).tasks[0].runs[0].state).toBe("succeeded"),
    );
    await vi.waitFor(async () =>
      expect((await get("routines")).routines[0].nextOccurrence).not.toBeNull(),
    );
    const armed = (await get("routines")).routines[0].nextOccurrence as string;
    now = Date.parse(armed);
    await host.reconcile();
    await vi.waitFor(async () => expect((await get("thread")).tasks).toHaveLength(2));
    const next = (await get("thread")).tasks[1];
    expect(next.routine.text).toBe("Read shelf 3");
    expect(next.routine.cron).toBe("30 * * * *");
    expect(next.runs[0].attempts[0].configurationVersion).toBe(version + 1);
    expect((await get("thread")).tasks[0].routine.text).toBe("Read the archive");
  } finally {
    release.resolve();
  }
});

it("pauses automatic starts without cancelling current work and resumes a future cron slot or one overdue one-shot", async () => {
  const driver = new MailboxDriver();
  const release = Promise.withResolvers<void>();
  driver.respond = async (_input, _material, signal) => {
    await Promise.race([
      release.promise,
      new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    ]);
    return "Paused work finished";
  };
  try {
    await start(driver);
    const cron = await (
      await post("routines", { requestId: "pause-cron", text: "Archive hourly", cron: "0 * * * *" })
    ).json();
    const once = await (
      await post("routines", {
        requestId: "pause-once",
        text: "Archive once",
        runAt: "2026-10-20T04:00:00Z",
        timezone: "UTC",
      })
    ).json();
    now = Date.parse(cron.nextOccurrence);
    await host.reconcile();
    await vi.waitFor(async () =>
      expect((await get("thread")).tasks[0].runs[0].state).toBe("active"),
    );
    const paused = await post(`routines/${cron.id}/pause`, { requestId: "pause-cron-now" });
    expect(paused.status).toBe(200);
    expect(await paused.json()).toMatchObject({ id: cron.id, paused: true });
    expect((await post(`routines/${once.id}/pause`, { requestId: "pause-once-now" })).status).toBe(
      200,
    );
    expect((await get("thread")).tasks[0].runs[0].state).toBe("active");
    release.resolve();
    await vi.waitFor(async () =>
      expect((await get("thread")).tasks[0].runs[0].state).toBe("succeeded"),
    );
    now += 3 * 3600000;
    await host.reconcile();
    expect((await get("thread")).tasks).toHaveLength(1);
    await host.reconcile();
    expect(
      (await get("routines")).routines.find((row: { id: string }) => row.id === cron.id),
    ).toMatchObject({
      paused: true,
      nextOccurrence: null,
    });
    expect((await get("thread")).tasks).toHaveLength(1);
    await channel.close();
    await host.stop();
    await listen(new MailboxDriver());
    expect(
      (await get("routines")).routines.find((row: { id: string }) => row.id === cron.id),
    ).toMatchObject({
      paused: true,
      nextOccurrence: null,
    });
    expect((await get("thread")).tasks).toHaveLength(1);
    expect(
      await (await post(`routines/${cron.id}/pause`, { requestId: "pause-cron-now" })).json(),
    ).toMatchObject({ paused: true, replayed: true });
    const resumed = await post(`routines/${cron.id}/resume`, { requestId: "resume-cron" });
    expect(resumed.status).toBe(200);
    const resumedCron = await resumed.json();
    expect(resumedCron.paused).toBe(false);
    expect(Date.parse(resumedCron.nextOccurrence)).toBeGreaterThan(now);
    expect((await post(`routines/${once.id}/resume`, { requestId: "resume-once" })).status).toBe(
      200,
    );
    await vi.waitFor(async () => expect((await get("thread")).tasks).toHaveLength(2));
    expect((await get("thread")).tasks[1].routine.text).toBe("Archive once");
    expect((await get("thread")).tasks).toHaveLength(2);
    now = Date.parse(resumedCron.nextOccurrence);
    await host.reconcile();
    await vi.waitFor(async () => expect((await get("thread")).tasks).toHaveLength(3));
  } finally {
    release.resolve();
  }
});

it("runs a paused Routine once without enabling recurrence or overlapping an unfinished occurrence", async () => {
  const driver = new MailboxDriver();
  const release = Promise.withResolvers<void>();
  driver.respond = async (_input, _material, signal) => {
    await Promise.race([
      release.promise,
      new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    ]);
    return "Manual archive";
  };
  try {
    await start(driver);
    const cron = await (
      await post("routines", {
        requestId: "manual-cron",
        text: "Archive manually",
        cron: "* * * * *",
      })
    ).json();
    expect((await post(`routines/${cron.id}/pause`, { requestId: "manual-pause" })).status).toBe(
      200,
    );
    const started = await post(`routines/${cron.id}/run`, { requestId: "manual-run" });
    expect(started.status).toBe(202);
    expect(await started.json()).toMatchObject({ id: cron.id, paused: true, replayed: false });
    expect((await post(`routines/${cron.id}/run`, { requestId: "manual-run" })).status).toBe(202);
    await vi.waitFor(async () =>
      expect((await get("thread")).tasks[0].runs[0].state).toBe("active"),
    );
    expect((await get("thread")).tasks[0].routine.text).toBe("Archive manually");
    expect((await post(`routines/${cron.id}/run`, { requestId: "manual-again" })).status).toBe(409);
    now += 120000;
    await host.reconcile();
    expect((await get("thread")).tasks).toHaveLength(1);
    expect((await get("routines")).routines[0]).toMatchObject({ paused: true });
    release.resolve();
    await vi.waitFor(async () =>
      expect((await get("thread")).tasks[0].runs[0].state).toBe("succeeded"),
    );
    await host.reconcile();
    expect((await get("thread")).tasks).toHaveLength(1);
    expect((await get("routines")).routines[0].paused).toBe(true);
  } finally {
    release.resolve();
  }
});

it("keeps recurrence after an occurrence stop and retains a deleted Routine without future starts", async () => {
  const driver = new MailboxDriver();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  driver.respond = async (_input, _material, signal) => {
    const call = ++calls;
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return call === 1 ? "Occurrence stopped" : "Deleted occurrence";
  };
  try {
    await start(driver);
    const cron = await (
      await post("routines", {
        requestId: "delete-cron",
        text: "Archive until removed",
        cron: "* * * * *",
      })
    ).json();
    now += 60000;
    await host.reconcile();
    await vi.waitFor(async () =>
      expect((await get("thread")).tasks[0].runs[0].state).toBe("active"),
    );
    expect(
      (
        await post(`runs/${(await get("thread")).tasks[0].runs[0].id}/stop`, {
          requestId: "stop-occurrence",
        })
      ).status,
    ).toBe(202);
    await vi.waitFor(async () =>
      expect(["succeeded", "failed", "closed"]).toContain(
        (await get("thread")).tasks[0].runs[0].state,
      ),
    );
    await vi.waitFor(async () =>
      expect((await get("routines")).routines[0]).toMatchObject({
        paused: false,
        deletedAt: null,
        nextOccurrence: expect.any(String),
      }),
    );
    const armed = (await get("routines")).routines[0].nextOccurrence as string;
    now = Date.parse(armed);
    await host.reconcile();
    await vi.waitFor(async () => expect((await get("thread")).tasks).toHaveLength(2));
    const removed = await post(`routines/${cron.id}/delete`, { requestId: "delete-routine" });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({
      id: cron.id,
      text: "Archive until removed",
      paused: false,
      deletedAt: armed,
    });
    await vi.waitFor(async () =>
      expect(["succeeded", "failed", "closed"]).toContain(
        (await get("thread")).tasks[1].runs[0].state,
      ),
    );
    expect((await get("routines")).routines).toHaveLength(1);
    expect((await get("thread")).tasks[0].routine.text).toBe("Archive until removed");
    now += 5 * 60000;
    await host.reconcile();
    expect((await get("thread")).tasks).toHaveLength(2);
    expect((await post(`routines/${cron.id}/run`, { requestId: "run-deleted" })).status).toBe(409);
    expect((await post(`routines/${cron.id}/pause`, { requestId: "pause-deleted" })).status).toBe(
      409,
    );
  } finally {
    release.resolve();
  }
});

it("retries an uncertain occurrence under the same Task with a new budget and keeps the old outcome", async () => {
  const driver = new MailboxDriver();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  driver.respond = async (input, material, signal) => {
    calls += 1;
    if (calls === 1) {
      new RunnerMailbox(material.directory).acknowledge(input.id, "completed");
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return "Missing final evidence";
    }
    await Promise.race([
      release.promise,
      new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      ),
    ]);
    return "Retried archive";
  };
  try {
    await start(driver);
    const created = await (
      await post("routines", {
        ...definition,
        requestId: "retry-once",
        runAt: "2026-10-20T00:00:00Z",
      })
    ).json();
    await vi.waitFor(() => expect(calls).toBe(1));
    const runId = (await get("thread")).tasks[0].runs[0].id as string;
    expect((await post(`runs/${runId}/stop`, { requestId: "stop-uncertain" })).status).toBe(202);
    await vi.waitFor(async () =>
      expect((await get("thread")).tasks[0].runs[0]).toMatchObject({
        state: "uncertain",
        held: true,
        outcome: { kind: "uncertain", reply: "Final evidence is missing." },
      }),
    );
    now += 86400000;
    await host.reconcile();
    expect((await get("thread")).tasks[0].runs).toHaveLength(1);
    const original = (await get("thread")).tasks[0].runs[0];
    expect((await post(`routines/${created.id}/run`, { requestId: "overlap-run" })).status).toBe(
      409,
    );
    expect(
      (await post(`routines/${created.id}/delete`, { requestId: "delete-uncertain" })).status,
    ).toBe(200);
    expect((await get("thread")).tasks[0].runs[0]).toMatchObject({
      state: "uncertain",
      held: true,
      outcome: original.outcome,
    });
    const retried = await post(`runs/${runId}/retry`, { requestId: "explicit-retry" });
    expect(retried.status).toBe(202);
    await vi.waitFor(() => expect(calls).toBe(2));
    const task = (await get("thread")).tasks[0];
    expect(task.runs).toHaveLength(2);
    expect(task.runs[0]).toMatchObject({
      id: runId,
      state: "closed",
      outcome: original.outcome,
    });
    expect(task.runs[1]).toMatchObject({
      priorRunId: runId,
      budget: { activeMs: 0, exhaustedAt: null },
    });
    expect((await post(`routines/${created.id}/run`, { requestId: "overlap-retry" })).status).toBe(
      409,
    );
    expect((await get("thread")).tasks).toHaveLength(1);
    expect((await get("thread")).tasks[0].runs).toHaveLength(2);
    release.resolve();
    await vi.waitFor(async () =>
      expect((await get("thread")).tasks[0].runs[1].state).toBe("succeeded"),
    );
    expect((await get("thread")).tasks[0].runs[0].outcome).toEqual(original.outcome);
  } finally {
    release.resolve();
  }
});

it("pauses and runs a Routine through the real SDK without enabling recurrence", async () => {
  let routineId = "";
  const service = await startPiService(async (request) => {
    const body = JSON.stringify(request.messages);
    if (!body.includes("Pause routine")) return { text: "Archive inspected" };
    const tools = request.messages.filter((row) => row.role === "tool");
    if (!tools.length)
      return {
        tool: "manage_routine",
        arguments: { requestId: "sdk-pause", routineId, action: "pause" },
      };
    if (tools.length === 1)
      return {
        tool: "manage_routine",
        arguments: { requestId: "sdk-run", routineId, action: "run" },
      };
    return { text: "Paused, and ran once." };
  });
  try {
    await start(
      piRunDriver(new PiProvider({ modelRuntime: service.runtime, model: service.model })),
    );
    const created = await (
      await post("routines", { requestId: "sdk-cron", text: "Read the archive", cron: "0 * * * *" })
    ).json();
    routineId = created.id;
    await post("thread/messages", {
      requestId: "sdk-manage",
      text: `Pause routine ${routineId} and run it once`,
    });
    await vi.waitFor(async () =>
      expect((await get("thread")).tasks[0].runs[0].state).toBe("succeeded"),
    );
    expect(
      service.requests[0]?.tools?.some((tool) => tool.function.name === "manage_routine"),
    ).toBe(true);
    expect((await get("routines")).routines[0]).toMatchObject({
      paused: true,
      text: "Read the archive",
    });
    await vi.waitFor(async () =>
      expect((await get("thread")).tasks[1].runs[0].state).toBe("succeeded"),
    );
    const occurrence = (await get("thread")).tasks[1];
    expect(occurrence.routine.text).toBe("Read the archive");
    expect(occurrence.origin).toBe("routine");
    now += 3 * 3600000;
    await host.reconcile();
    expect((await get("thread")).tasks).toHaveLength(2);
    expect((await get("routines")).routines[0].paused).toBe(true);
  } finally {
    await service.close();
  }
});

it("manages the current Bot's Routines through scoped commands", async () => {
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
  const created = await (
    await post("routines", {
      requestId: "scoped-cron",
      text: "Archive from the owner",
      cron: "0 9 * * *",
    })
  ).json();
  await post("thread/messages", { requestId: "manager", text: "Pause the archive Routine" });
  await entered.promise;
  const mailbox = new RunnerMailbox(driver.launches[0]?.material.directory as string);
  async function ask(id: string, input: Record<string, unknown>) {
    mailbox.requestHistory({
      id,
      operation: "manage_routine",
      input,
      incarnation: mailbox.executionIncarnation(),
    });
    return vi.waitFor(() => {
      const response = mailbox.historyResponse(id);
      expect(response).toBeDefined();
      return response as { result?: Record<string, unknown>; error?: string };
    });
  }
  expect(
    (await ask("pause-it", { requestId: "pause-it", routineId: created.id, action: "pause" }))
      .result,
  ).toMatchObject({ id: created.id, paused: true });
  expect(
    (
      await ask("edit-it", {
        requestId: "edit-it",
        routineId: created.id,
        action: "update",
        text: "Archive shelf 3",
        cron: "15 9 * * *",
      })
    ).result,
  ).toMatchObject({ text: "Archive shelf 3", cron: "15 9 * * *", paused: true });
  expect(
    (await ask("run-it", { requestId: "run-it", routineId: created.id, action: "run" })).result,
  ).toMatchObject({ paused: true, runId: expect.any(String) });
  expect((await get("thread")).tasks[1].routine.text).toBe("Archive shelf 3");
  expect((await get("routines")).routines[0].paused).toBe(true);
  mailbox.requestHistory({
    id: "lookup-edit",
    operation: "read_operation",
    input: { requestId: "edit-it" },
    incarnation: mailbox.executionIncarnation(),
  });
  await vi.waitFor(() =>
    expect(mailbox.historyResponse("lookup-edit")?.result).toMatchObject({
      state: "recorded",
      routine: { text: "Archive shelf 3" },
    }),
  );
  expect(
    (
      await ask("forged", {
        requestId: "forged",
        routineId: created.id,
        action: "pause",
        botId: "writer",
      })
    ).error,
  ).toContain("Forged execution identity");
  mailbox.requestHistory({
    id: "cross",
    operation: "administer_routine",
    input: { requestId: "cross", routineId: created.id },
    incarnation: mailbox.executionIncarnation(),
  });
  await vi.waitFor(() => expect(mailbox.historyResponse("cross")?.error).toContain("Cross-Bot"));
  expect(
    (await ask("delete-it", { requestId: "delete-it", routineId: created.id, action: "delete" }))
      .result,
  ).toMatchObject({ deletedAt: expect.any(String), text: "Archive shelf 3" });
  await vi.waitFor(async () =>
    expect(["closed", "failed", "succeeded"]).toContain(
      (await get("thread")).tasks[1].runs[0].state,
    ),
  );
  expect((await get("routines")).routines[0].deletedAt).toEqual(expect.any(String));
});
