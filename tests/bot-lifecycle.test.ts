import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerMailbox } from "@mybots/mailbox/node";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocketChannel } from "../packages/host/src/channels/websocket.ts";
import { loadHostSettings } from "../packages/host/src/config/host.ts";
import type { SessionDriver } from "../packages/host/src/drivers/types.ts";
import { Host, type HostConfiguration } from "../packages/host/src/host.ts";
import { MailboxDriver } from "./host-fixture.ts";

let root: string;
let host: Host;
let channel: WebSocketChannel;
let base: string;
let headers: Record<string, string>;
let configuration: HostConfiguration;
let now = Date.parse("2026-10-21T00:00:00.000Z");
afterEach(async () => {
  await channel?.close();
  await host?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

async function listen(driver: SessionDriver) {
  host = await Host.start({
    root,
    configuration,
    driver,
    now: () => now,
    reconcileMs: 36000000,
  });
  channel = await WebSocketChannel.listen({ root, host, configuration, port: 0 });
  base = `http://127.0.0.1:${channel.address.port}`;
  headers = {
    Authorization: `Bearer ${(await readFile(join(root, "data/client-credential"), "utf8")).trim()}`,
    "Content-Type": "application/json",
  };
}
async function start(driver: SessionDriver = new MailboxDriver()) {
  root = await mkdtemp(join(tmpdir(), "mybots-bot-lifecycle-"));
  now = Date.parse("2026-10-21T00:00:00.000Z");
  configuration = (await loadHostSettings("examples/host/host.json")).configuration;
  await listen(driver);
}
function hold(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
function ask(mailbox: RunnerMailbox, id: string, operation: string, input: unknown) {
  mailbox.requestHistory({
    id,
    operation,
    input,
    incarnation: mailbox.executionIncarnation(),
  });
  return vi.waitFor(() => {
    const response = mailbox.historyResponse(id);
    expect(response).toBeDefined();
    return response as { result?: Record<string, unknown>; error?: string };
  });
}

function post(path: string, body: unknown) {
  return fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function get(path: string) {
  const response = await fetch(`${base}${path}`, { headers });
  expect(response.status).toBe(200);
  return response.json();
}

it("disables a Bot during active work, keeps completed effects, and admits another Bot", async () => {
  const external = new MailboxDriver();
  external.respond = async (input, _material, signal) => {
    if (input.content === "Hold")
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    return `Final: ${input.content}`;
  };
  await start(external);
  const path = "/api/bots/personal/thread";
  const finished = await (
    await post(`${path}/messages`, { requestId: "finished-work", text: "Archive the notes" })
  ).json();
  await vi.waitFor(async () => expect((await get(path)).tasks[0].runs[0].state).toBe("succeeded"));
  const held = await (await post(`${path}/tasks`, { requestId: "held-work", text: "Hold" })).json();
  await vi.waitFor(async () => expect((await get(path)).tasks[1].runs[0].state).toBe("active"));

  const disabled = await post("/api/bots/personal/disable", { requestId: "disable-personal" });
  expect(disabled.status).toBe(202);
  expect(await disabled.json()).toMatchObject({
    replayed: false,
    bot: { id: "personal", availability: "disabled" },
  });
  await vi.waitFor(async () =>
    expect((await get(path)).tasks[1].runs[0]).toMatchObject({
      id: held.runId,
      state: "closed",
      outcome: { kind: "cancelled", reply: "Stopped before a final result." },
    }),
  );
  expect((await get(path)).tasks[0].runs[0]).toMatchObject({
    id: finished.runId,
    state: "succeeded",
    outcome: { reply: "Final: Archive the notes" },
  });
  expect(
    (await post(`${path}/messages`, { requestId: "after-disable", text: "Continue" })).status,
  ).toBe(409);
  expect(
    (await post(`${path}/tasks`, { requestId: "after-disable-task", text: "Another task" })).status,
  ).toBe(409);

  const writer = await (
    await post("/api/bots", {
      requestId: "writer-during-disable",
      name: "Writer",
      instructions: "Write",
      model: { provider: "deepseek", id: "deepseek-chat" },
      tools: [],
    })
  ).json();
  await post(`/api/bots/${writer.bot.id}/thread/messages`, {
    requestId: "writer-continues",
    text: "Writer continues",
  });
  await vi.waitFor(async () =>
    expect((await get(`/api/bots/${writer.bot.id}/thread`)).tasks[0].runs[0].state).toBe(
      "succeeded",
    ),
  );
  expect((await get(path)).tasks).toHaveLength(2);
});

it("cancels scheduled work, delegated descendants, and pending decisions without taking unrelated work", async () => {
  const external = new MailboxDriver();
  external.respond = async (input, _material, signal) => {
    if (
      input.content === "Hold source" ||
      input.content === "Child task" ||
      input.content === "After cancellation"
    )
      await hold(signal);
    return `Final: ${input.content}`;
  };
  await start(external);
  const writer = await (
    await post("/api/bots", {
      requestId: "writer-bot",
      name: "Writer",
      instructions: "Write only the supplied text.",
      model: { provider: "deepseek", id: "deepseek-chat" },
      tools: ["read"],
    })
  ).json();
  const writerId = writer.bot.id as string;
  await post(`/api/bots/${writerId}/thread/messages`, {
    requestId: "writer-unrelated",
    text: "Unrelated notes",
  });
  await vi.waitFor(async () =>
    expect((await get(`/api/bots/${writerId}/thread`)).tasks[0].runs[0].state).toBe("succeeded"),
  );
  const source = await (
    await post("/api/bots/personal/thread/messages", {
      requestId: "hold-source",
      text: "Hold source",
    })
  ).json();
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("active"),
  );
  const sourceLaunch = external.launches.find((row) => row.material.key.sessionId === source.runId);
  const mailbox = new RunnerMailbox(sourceLaunch?.material.directory as string);
  expect(
    await ask(mailbox, "need-decision", "ask_question", {
      requestId: "need-decision",
      text: "Which shelf?",
    }),
  ).toMatchObject({ result: { state: "pending" } });
  expect(
    (
      await post(`/api/bots/personal/collaboration/${writerId}`, {
        requestId: "allow-writer",
        mode: "allow",
      })
    ).status,
  ).toBe(201);
  expect(
    await ask(mailbox, "child-request", "delegate", {
      requestId: "child-request",
      targetBotId: writerId,
      text: "Child task",
    }),
  ).toMatchObject({ result: { childRunId: expect.any(String) } });
  await vi.waitFor(async () =>
    expect((await get(`/api/bots/${writerId}/thread`)).tasks[1].runs[0].state).toBe("active"),
  );
  const side = await (
    await post(`/api/bots/${writerId}/thread/tasks`, {
      requestId: "writer-side",
      text: "Side shelf",
    })
  ).json();
  const routine = await (
    await post("/api/bots/personal/routines", {
      requestId: "future-check",
      text: "Future check",
      runAt: "2026-12-01T00:00:00.000Z",
      timezone: "UTC",
    })
  ).json();
  const occurrence = await (
    await post(`/api/bots/personal/routines/${routine.id}/run`, { requestId: "run-future-check" })
  ).json();
  expect(
    (
      await post("/api/bots/personal/routines", {
        requestId: "daily",
        text: "Daily archive",
        cron: "0 9 * * *",
      })
    ).status,
  ).toBe(201);

  const disabled = await post("/api/bots/personal/disable", { requestId: "disable-during-work" });
  expect(disabled.status).toBe(202);
  await vi.waitFor(async () => {
    const detail = await get("/api/bots/personal/thread");
    expect(detail.tasks[0].runs[0]).toMatchObject({
      id: source.runId,
      state: "closed",
      outcome: { kind: "cancelled" },
      questions: [{ id: "need-decision", state: "cancelled" }],
      delegations: [expect.objectContaining({ id: "child-request", state: "cancelled" })],
    });
    expect(detail.tasks[1].runs[0]).toMatchObject({
      id: occurrence.runId,
      state: "closed",
      outcome: { kind: "cancelled" },
    });
  });
  expect((await get(`/api/bots/${writerId}/thread`)).tasks[0].runs[0]).toMatchObject({
    state: "succeeded",
    outcome: { reply: "Final: Unrelated notes" },
  });
  await vi.waitFor(async () =>
    expect((await get(`/api/bots/${writerId}/thread`)).tasks[2].runs[0]).toMatchObject({
      id: side.runId,
      state: "succeeded",
      outcome: { reply: "Final: Side shelf" },
    }),
  );
  expect((await get(`/api/bots/${writerId}/thread`)).tasks[1].runs[0].state).toBe("closed");
  expect(
    (
      await post("/api/bots/personal/thread/messages", {
        requestId: "blocked-chat",
        text: "More",
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await post(`/api/bots/personal/tasks/${source.taskId}/inputs`, {
        requestId: "blocked-input",
        text: "Added",
      })
    ).status,
  ).toBe(409);
  expect(
    (await post(`/api/bots/personal/runs/${source.runId}/retry`, { requestId: "blocked-retry" }))
      .status,
  ).toBe(409);
  expect(
    (
      await post("/api/bots/personal/routines", {
        requestId: "blocked-routine",
        text: "Nope",
        runAt: "2026-12-02T00:00:00.000Z",
        timezone: "UTC",
      })
    ).status,
  ).toBe(409);
  now = Date.parse("2026-10-21T10:00:00.000Z");
  await host.reconcile();
  expect((await get("/api/bots/personal/thread")).tasks).toHaveLength(2);

  await post(`/api/bots/${writerId}/thread/messages`, {
    requestId: "writer-after",
    text: "After cancellation",
  });
  await vi.waitFor(async () =>
    expect((await get(`/api/bots/${writerId}/thread`)).tasks[3].runs[0].state).toBe("active"),
  );
  const after = (await get(`/api/bots/${writerId}/thread`)).tasks[3].runs[0];
  const writerLaunch = external.launches.find((row) => row.material.key.sessionId === after.id);
  const writerMailbox = new RunnerMailbox(writerLaunch?.material.directory as string);
  expect(
    await ask(writerMailbox, "delegate-disabled", "delegate", {
      requestId: "delegate-disabled",
      targetBotId: "personal",
      text: "Should not start",
    }),
  ).toMatchObject({ error: expect.stringContaining("disabled") });
  expect((await get("/api/bots/personal/thread")).tasks).toHaveLength(2);
});

it("keeps an unconfirmed stop visible across restart and does not revive it on enable", async () => {
  const external = new MailboxDriver();
  external.respond = async (input, _material, signal) => {
    if (input.content === "Hold") await hold(signal);
    return `Final: ${input.content}`;
  };
  let stops = 0;
  const driver: SessionDriver = {
    start: async (material, signal) => {
      const handle = await external.start(material, signal);
      return {
        wait: handle.wait,
        stop: async () => {
          stops += 1;
          if (stops === 1) throw new Error("Controlled stop failure");
          await handle.stop();
        },
      };
    },
  };
  await start(driver);
  const path = "/api/bots/personal/thread";
  const held = await (await post(`${path}/messages`, { requestId: "hold", text: "Hold" })).json();
  await vi.waitFor(async () => expect((await get(path)).tasks[0].runs[0].state).toBe("active"));
  const disabled = await post("/api/bots/personal/disable", { requestId: "disable-unconfirmed" });
  expect(disabled.status).toBe(202);
  await vi.waitFor(async () =>
    expect((await get(path)).tasks[0].runs[0]).toMatchObject({
      id: held.runId,
      state: "stopping",
      stopError: "Execution stop unconfirmed; Bot capacity retained",
    }),
  );
  const writer = await (
    await post("/api/bots", {
      requestId: "writer-during-uncertain-stop",
      name: "Writer",
      instructions: "Write",
      model: { provider: "deepseek", id: "deepseek-chat" },
      tools: [],
    })
  ).json();
  await post(`/api/bots/${writer.bot.id}/thread/messages`, {
    requestId: "writer-progress",
    text: "Writer continues",
  });
  await vi.waitFor(async () =>
    expect((await get(`/api/bots/${writer.bot.id}/thread`)).tasks[0].runs[0].state).toBe(
      "succeeded",
    ),
  );
  expect((await get(path)).tasks[0].runs[0].state).toBe("stopping");

  const saved = await putMemory("Remember the shelf");
  const edited = await post("/api/bots/personal/settings", {
    requestId: "edit-while-disabled",
    instructions: "Keep the archived role.",
    model: { provider: "deepseek", id: "deepseek-chat" },
    tools: [],
  });
  expect(edited.status).toBe(201);

  await channel.close();
  await host.stop();
  await listen(new MailboxDriver());
  await vi.waitFor(async () =>
    expect((await get(path)).tasks[0].runs[0]).toMatchObject({
      id: held.runId,
      state: "closed",
      outcome: { kind: "cancelled", reply: "Stopped before a final result." },
    }),
  );
  expect((await get("/api/bots")).bots).toContainEqual(
    expect.objectContaining({
      id: "personal",
      availability: "disabled",
      instructions: "Keep the archived role.",
    }),
  );
  expect((await get("/api/bots/personal/memory")).index.content).toBe("Remember the shelf");
  expect(saved.version).toEqual(expect.any(String));
  expect(
    (await post(`${path}/messages`, { requestId: "still-disabled", text: "No revival" })).status,
  ).toBe(409);

  const enabled = await post("/api/bots/personal/enable", { requestId: "enable-personal" });
  expect(enabled.status).toBe(200);
  expect(await enabled.json()).toMatchObject({
    replayed: false,
    bot: {
      id: "personal",
      availability: "active",
      instructions: "Keep the archived role.",
    },
  });
  expect((await get(path)).tasks[0].runs[0]).toMatchObject({
    id: held.runId,
    state: "closed",
    outcome: { kind: "cancelled" },
  });
  const retried = await (
    await post(`/api/bots/personal/runs/${held.runId}/retry`, { requestId: "retry-after-enable" })
  ).json();
  expect(retried.runId).not.toBe(held.runId);
  await vi.waitFor(async () =>
    expect((await get(path)).tasks[0].runs.map((run: { id: string }) => run.id)).toEqual([
      held.runId,
      retried.runId,
    ]),
  );
  expect((await get(path)).tasks[0].runs[0].state).toBe("closed");
  await vi.waitFor(async () => expect((await get(path)).tasks[0].runs[1].state).toBe("succeeded"));
});

it("logically deletes a Bot, retains evidence, and gives a same-name Bot a new workspace", async () => {
  await start();
  await post("/api/bots/personal/thread/messages", {
    requestId: "kept-history",
    text: "Keep this history",
  });
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("succeeded"),
  );
  const memory = await putMemory("Shelf map");
  const personal = (await get("/api/bots")).bots.find(
    (bot: { id: string }) => bot.id === "personal",
  );
  const writer = await (
    await post("/api/bots", {
      requestId: "copy-holder",
      name: "Writer",
      instructions: "Write",
      model: { provider: "deepseek", id: "deepseek-chat" },
      tools: [],
    })
  ).json();
  await writeFile(join(root, personal.workspace, "kept-notes.txt"), "original notes");
  await writeFile(join(root, writer.bot.workspace, "kept-notes.txt"), "copied notes");

  const deleted = await post("/api/bots/personal/delete", { requestId: "delete-personal" });
  expect(deleted.status).toBe(202);
  const body = await deleted.json();
  expect(body).toMatchObject({
    replayed: false,
    bot: { id: "personal", availability: "deleted", instructions: personal.instructions },
    retention:
      "Logical deletion keeps this Bot's configuration, history, results, workspace, memory, and materials, including copies held by other Bots. It does not restore the Bot or permanently purge retained data.",
  });
  expect(JSON.stringify(body)).not.toContain("kept-notes.txt");
  expect(await readFile(join(root, personal.workspace, "kept-notes.txt"), "utf8")).toBe(
    "original notes",
  );
  expect(await readFile(join(root, writer.bot.workspace, "kept-notes.txt"), "utf8")).toBe(
    "copied notes",
  );
  expect((await get("/api/bots/personal/memory")).index).toMatchObject({
    content: "Shelf map",
    version: memory.version,
  });
  expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].outcome.reply).toBe(
    "Reply: Keep this history",
  );
  expect((await putMemory("Changed after deletion", memory.version)).status).toBe(409);
  expect(
    (
      await post("/api/bots/personal/settings", {
        requestId: "edit-deleted",
        instructions: "Replacement role",
        model: { provider: "deepseek", id: "deepseek-chat" },
        tools: [],
      })
    ).status,
  ).toBe(409);
  expect((await post("/api/bots/personal/enable", { requestId: "restore-deleted" })).status).toBe(
    409,
  );
  expect(
    (
      await post("/api/bots/personal/thread/messages", {
        requestId: "deleted-chat",
        text: "Should fail",
      })
    ).status,
  ).toBe(409);

  const replacement = await (
    await post("/api/bots", {
      requestId: "same-name-replacement",
      name: personal.name,
      instructions: "Fresh role",
      model: { provider: "deepseek", id: "deepseek-chat" },
      tools: [],
    })
  ).json();
  expect(replacement.bot.id).not.toBe("personal");
  expect(replacement.bot.workspace).not.toBe(personal.workspace);
  await expect(
    readFile(join(root, replacement.bot.workspace, "kept-notes.txt"), "utf8"),
  ).rejects.toThrow();
  await post(`/api/bots/${replacement.bot.id}/thread/messages`, {
    requestId: "replacement-chat",
    text: "Independent",
  });
  await vi.waitFor(async () =>
    expect((await get(`/api/bots/${replacement.bot.id}/thread`)).tasks[0].runs[0].state).toBe(
      "succeeded",
    ),
  );
  expect((await get("/api/bots/personal/thread")).tasks).toHaveLength(1);
});

async function putMemory(content: string, version: string | null = null) {
  const response = await fetch(`${base}/api/bots/personal/memory/index`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ content, version }),
  });
  const body = await response.json();
  return { status: response.status, ...(body.index ?? {}), body };
}
