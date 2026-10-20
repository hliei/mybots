import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RunnerMailbox } from "@mybots/mailbox/node";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PiProvider } from "../packages/agent-runner/src/providers/pi.ts";
import { WebSocketChannel } from "../packages/host/src/channels/websocket.ts";
import { loadHostSettings } from "../packages/host/src/config/host.ts";
import type { SessionDriver } from "../packages/host/src/drivers/types.ts";
import { Host } from "../packages/host/src/host.ts";
import { MailboxDriver } from "./host-fixture.ts";
import { startPiService } from "./pi-fixture.ts";
import { piRunDriver } from "./pi-run-driver.ts";

let root: string;
let host: Host;
let channel: WebSocketChannel;
let base: string;
let headers: Record<string, string>;
let now = Date.parse("2026-10-20T00:00:00Z");
beforeEach(() => {
  now = Date.parse("2026-10-20T00:00:00Z");
});
afterEach(async () => {
  await channel?.close();
  await host?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});
async function start(driver: SessionDriver = new MailboxDriver()) {
  root = await mkdtemp(join(tmpdir(), "mybots-progress-"));
  const { configuration } = await loadHostSettings("examples/host/host.json");
  host = await Host.start({
    root,
    configuration,
    driver,
    now: () => now,
    reconcileMs: 365 * 86400000,
  });
  channel = await WebSocketChannel.listen({ root, host, configuration, port: 0 });
  base = `http://127.0.0.1:${channel.address.port}`;
  headers = {
    Authorization: `Bearer ${(await readFile(join(root, "data", "client-credential"), "utf8")).trim()}`,
    "Content-Type": "application/json",
  };
  return configuration;
}
function post(path: string, body: unknown) {
  return fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}
async function get(path: string) {
  const response = await fetch(`${base}${path}`, { headers });
  expect(response.status).toBe(200);
  return response.json();
}
function ask(
  mailbox: RunnerMailbox,
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

it("persists a scoped question, waits for a correlated answer, and resumes the same Run", async () => {
  const driver = new MailboxDriver();
  driver.respond = async (_input, _material, signal) => {
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    return "Do not complete while waiting";
  };
  await start(driver);
  const sent = await (
    await post("/api/bots/personal/thread/messages", { requestId: "source", text: "Plan a trip" })
  ).json();
  await vi.waitFor(() => expect(driver.launches).toHaveLength(1));
  const mailbox = new RunnerMailbox(driver.launches[0]?.material.directory as string);
  const question = await ask(mailbox, "destination", "ask_question", {
    requestId: "destination",
    text: "Which city?",
  });
  expect(question.result).toMatchObject({
    id: "destination",
    state: "pending",
    taskId: sent.taskId,
    runId: sent.runId,
  });
  expect(
    (await ask(mailbox, "lookup", "read_operation", { requestId: "destination" })).result,
  ).toMatchObject({ state: "recorded", question: { id: "destination", text: "Which city?" } });
  expect(
    (
      await ask(mailbox, "forged", "ask_question", {
        requestId: "forged",
        text: "x",
        botId: "other",
      })
    ).error,
  ).toBe("Forged execution identity is rejected.");
  expect(
    (
      await ask(
        mailbox,
        "stale",
        "ask_question",
        { requestId: "stale", text: "x" },
        mailbox.executionIncarnation() + 1,
      )
    ).error,
  ).toBe("Execution scope is no longer active.");
  mailbox.requestDurableWait("owner-question");
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("waiting"),
  );
  const waiting = (await get("/api/bots/personal/thread")).tasks[0].runs[0];
  expect(waiting.outcome).toBeNull();
  expect(waiting.questions).toEqual([
    expect.objectContaining({ id: "destination", text: "Which city?", state: "pending" }),
  ]);
  now += 24 * 60 * 60 * 1000;
  await host.reconcile();
  expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].budget.activeMs).toBe(
    waiting.budget.activeMs,
  );
  const supplement = await (
    await post(`/api/bots/personal/tasks/${sent.taskId}/inputs`, {
      requestId: "addition",
      text: "Prefer rail",
    })
  ).json();
  expect(supplement.runId).toBe(sent.runId);
  expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("waiting");
  const answerPath = `/api/bots/personal/runs/${sent.runId}/questions/destination/answer`;
  expect(
    (
      await fetch(`${base}${answerPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: "unauth", text: "Hangzhou" }),
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await post(`/api/bots/missing/runs/${sent.runId}/questions/destination/answer`, {
        requestId: "wrong-bot",
        text: "Hangzhou",
      })
    ).status,
  ).toBe(404);
  const answer = await post(answerPath, { requestId: "answer", text: "Hangzhou" });
  expect(answer.status).toBe(202);
  expect(await answer.json()).toMatchObject({
    taskId: sent.taskId,
    runId: sent.runId,
    questionId: "destination",
  });
  expect((await post(answerPath, { requestId: "answer", text: "Hangzhou" })).status).toBe(202);
  expect((await post(answerPath, { requestId: "another-answer", text: "Beijing" })).status).toBe(
    409,
  );
  await vi.waitFor(() => expect(driver.launches).toHaveLength(2));
  const resumed = (await get("/api/bots/personal/thread")).tasks[0].runs[0];
  expect(resumed.questions[0]).toMatchObject({ state: "answered", answer: "Hangzhou" });
  expect(resumed.attempts).toHaveLength(2);
});

it.each([false, true])(
  "ends the real SDK batch and resumes with current settings after restart (lost wait checkpoint: %s)",
  async (lostCheckpoint) => {
    const requests: string[] = [];
    const service = await startPiService(
      async (request) => {
        requests.push(JSON.stringify(request));
        if (!request.messages.some((row) => row.role === "tool"))
          return {
            tools: [
              { name: "ask_question", arguments: { requestId: "city", text: "Which city?" } },
              { name: "ask_question", arguments: { requestId: "date", text: "Which date?" } },
              {
                name: "bash",
                arguments: { command: "printf 'Saved before waiting' > wait-evidence.txt" },
              },
            ],
            text: "Choosing a destination",
          };
        if (request.messages.filter((row) => row.role === "tool").length === 3)
          return {
            tool: "read_operation",
            arguments: { requestId: "city" },
            text: "Reading the answered question",
          };
        return { text: "Trip to Hangzhou by rail" };
      },
      { contextWindow: 65536 },
    );
    try {
      const driver = piRunDriver(
        new PiProvider({ modelRuntime: service.runtime, model: service.model }),
      );
      const configuration = await start(driver);
      const sent = await (
        await post("/api/bots/personal/thread/messages", {
          requestId: "sdk-source",
          text: "Plan a trip",
        })
      ).json();
      await vi.waitFor(
        async () =>
          expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("waiting"),
        { timeout: 5000 },
      );
      expect(requests).toHaveLength(1);
      expect(await readFile(join(root, "groups", "personal", "wait-evidence.txt"), "utf8")).toBe(
        "Saved before waiting",
      );
      async function allRecords() {
        const records: { kind: string; toolName?: string; toolCallId?: string }[] = [];
        let after = "";
        do {
          const page = await get(
            `/api/bots/personal/runs/${sent.runId}/history?kind=records${after ? `&after=${encodeURIComponent(after)}` : ""}`,
          );
          records.push(...page.records);
          after = page.nextAfter ?? "";
        } while (after);
        return records;
      }
      const before = await allRecords();
      expect(
        before
          .filter((record) => record.kind === "tool-call")
          .map((record) => record.toolName)
          .sort(),
      ).toEqual(["ask_question", "ask_question", "bash"]);
      expect(
        before
          .filter((record) => record.kind === "tool-result")
          .map((record) => record.toolCallId)
          .sort(),
      ).toEqual(
        before
          .filter((record) => record.kind === "tool-call")
          .map((record) => record.toolCallId)
          .sort(),
      );
      await channel.close();
      await host.stop();
      if (lostCheckpoint) {
        // Recreate loss before the Host commits the wait; assertions remain at public seams.
        const db = new DatabaseSync(join(root, "data", "host.db"));
        try {
          db.prepare("UPDATE runs SET state = 'queued', wait_reason = NULL WHERE id = ?").run(
            sent.runId,
          );
        } finally {
          db.close();
        }
      }
      now += 7 * 24 * 60 * 60 * 1000;
      host = await Host.start({
        root,
        configuration,
        driver,
        now: () => now,
        reconcileMs: 365 * 86400000,
      });
      channel = await WebSocketChannel.listen({ root, host, configuration, port: 0 });
      base = `http://127.0.0.1:${channel.address.port}`;
      const waiting = (await get("/api/bots/personal/thread")).tasks[0].runs[0];
      expect(waiting.state).toBe("waiting");
      expect(waiting.questions[0].state).toBe("pending");
      expect(requests).toHaveLength(1);
      const memory = await get("/api/bots/personal/memory");
      expect(
        (
          await fetch(`${base}/api/bots/personal/memory/index`, {
            method: "PUT",
            headers,
            body: JSON.stringify({
              content: "Owner correction: prefer trains",
              version: memory.index?.version ?? null,
            }),
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await post("/api/bots/personal/settings", {
            requestId: "wait-settings",
            instructions: "Use updated travel instructions",
            model: {
              provider: configuration.agent.model.provider,
              id: configuration.agent.model.id,
            },
            tools: ["read", "bash"],
          })
        ).status,
      ).toBe(201);
      const supplemented = await post(`/api/bots/personal/tasks/${sent.taskId}/inputs`, {
        requestId: "sdk-extra",
        text: "Prefer rail",
      });
      expect(supplemented.status).toBe(202);
      const answered = await post(`/api/bots/personal/runs/${sent.runId}/questions/city/answer`, {
        requestId: "sdk-answer",
        text: "Hangzhou",
      });
      expect(answered.status).toBe(202);
      expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("waiting");
      expect(requests).toHaveLength(1);
      expect(
        (
          await post(`/api/bots/personal/runs/${sent.runId}/questions/date/answer`, {
            requestId: "sdk-date-answer",
            text: "Tomorrow",
          })
        ).status,
      ).toBe(202);
      await vi.waitFor(async () =>
        expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("succeeded"),
      );
      const finished = (await get("/api/bots/personal/thread")).tasks[0].runs[0];
      expect(finished.id).toBe(sent.runId);
      expect(finished.attempts).toHaveLength(2);
      expect(
        finished.attempts.map((a: { configurationVersion: number }) => a.configurationVersion),
      ).toEqual([1, 2]);
      expect(finished.outcome.reply).toBe("Trip to Hangzhou by rail");
      expect(requests.slice(1).some((r) => r.includes("Hangzhou"))).toBe(true);
      expect(requests.slice(1).every((r) => r.includes("Owner correction: prefer trains"))).toBe(
        true,
      );
      expect(requests.slice(1).every((r) => r.includes("Use updated travel instructions"))).toBe(
        true,
      );
      expect(requests.slice(1).some((r) => r.includes("Prefer rail"))).toBe(true);
      expect(requests.filter((r) => !r.includes('"role":"tool"'))).toHaveLength(1);
      const after = await allRecords();
      expect(
        after
          .filter((record) => record.kind === "tool-call")
          .map((record) => record.toolName)
          .sort(),
      ).toEqual(["ask_question", "ask_question", "bash", "read_operation"]);
      expect(
        after
          .filter((record) => record.kind === "tool-result")
          .map((record) => record.toolCallId)
          .sort(),
      ).toEqual(
        after
          .filter((record) => record.kind === "tool-call")
          .map((record) => record.toolCallId)
          .sort(),
      );
    } finally {
      await channel?.close();
      await host?.stop();
      await service.close();
    }
  },
  20000,
);

it("keeps capacity until the complete tool batch and confirmed stop, then fairly queues a resumed Run", async () => {
  const external = new MailboxDriver();
  const stopping = Promise.withResolvers<void>();
  const confirm = Promise.withResolvers<void>();
  external.respond = async (_input, _material, signal) => {
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    return "Unresolved";
  };
  let firstStop = true;
  const driver: SessionDriver = {
    start: async (material, signal) => {
      const handle = await external.start(material, signal);
      return {
        ...handle,
        stop: async () => {
          if (firstStop) {
            firstStop = false;
            stopping.resolve();
            await confirm.promise;
          }
          await handle.stop();
        },
      };
    },
  };
  try {
    await start(driver);
    const sent = await (
      await post("/api/bots/personal/thread/messages", { requestId: "batch-source", text: "Plan" })
    ).json();
    await vi.waitFor(() => expect(external.launches).toHaveLength(1));
    const mailbox = new RunnerMailbox(external.launches[0]?.material.directory as string);
    await ask(mailbox, "batch-city", "ask_question", {
      requestId: "batch-city",
      text: "Which city?",
    });
    mailbox.recordExecution({
      id: "batch-call",
      kind: "tool-call",
      toolCallId: "batch",
      toolName: "write",
      text: "file",
      createdAt: new Date(now).toISOString(),
    });
    mailbox.requestDurableWait("owner-question");
    const other = await (
      await post("/api/bots/personal/thread/tasks", {
        requestId: "other-task",
        text: "Independent work",
      })
    ).json();
    expect(other.runId).not.toBe(sent.runId);
    expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("active");
    expect(external.launches).toHaveLength(1);
    mailbox.recordExecution({
      id: "batch-result",
      kind: "tool-result",
      toolCallId: "batch",
      toolName: "write",
      text: "saved",
      createdAt: new Date(now).toISOString(),
    });
    await stopping.promise;
    expect((await get("/api/bots/personal/thread")).admission.activeCount).toBe(1);
    expect(external.launches).toHaveLength(1);
    confirm.resolve();
    await vi.waitFor(() => expect(external.launches).toHaveLength(2));
    const waiting = (await get("/api/bots/personal/thread")).tasks[0].runs[0];
    expect(waiting.state).toBe("waiting");
    expect(
      (
        await post(`/api/bots/personal/runs/${sent.runId}/questions/batch-city/answer`, {
          requestId: "batch-answer",
          text: "Hangzhou",
        })
      ).status,
    ).toBe(202);
    const detail = await get("/api/bots/personal/thread");
    expect(detail.tasks[0].runs[0].state).toBe("queued");
    expect(detail.tasks[1].runs[0].state).toBe("active");
    expect(external.launches).toHaveLength(2);
  } finally {
    confirm.resolve();
  }
});

it("expires only an explicit deadline across restart, refuses late answers and fences a stopped question", async () => {
  const external = new MailboxDriver();
  external.respond = async (_input, _material, signal) => {
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    return "Unresolved";
  };
  const configuration = await start(external);
  const sent = await (
    await post("/api/bots/personal/thread/messages", { requestId: "expiry-source", text: "Plan" })
  ).json();
  await vi.waitFor(() => expect(external.launches).toHaveLength(1));
  const mailbox = new RunnerMailbox(external.launches[0]?.material.directory as string);
  await ask(mailbox, "expires", "ask_question", {
    requestId: "expires",
    text: "Which city?",
    deadline: new Date(now + 60000).toISOString(),
  });
  await ask(mailbox, "indefinite", "ask_question", {
    requestId: "indefinite",
    text: "Which date?",
  });
  mailbox.requestDurableWait("owner-question");
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("waiting"),
  );
  await channel.close();
  await host.stop();
  now += 60001;
  host = await Host.start({
    root,
    configuration,
    driver: external,
    now: () => now,
    reconcileMs: 365 * 86400000,
  });
  channel = await WebSocketChannel.listen({ root, host, configuration, port: 0 });
  base = `http://127.0.0.1:${channel.address.port}`;
  const questions = (await get("/api/bots/personal/thread")).tasks[0].runs[0].questions;
  expect(questions.map((q: { state: string }) => q.state)).toEqual(["expired", "pending"]);
  const answer = `/api/bots/personal/runs/${sent.runId}/questions`;
  expect(
    (await post(`${answer}/expires/answer`, { requestId: "late", text: "Hangzhou" })).status,
  ).toBe(409);
  expect(
    (await post(`${answer}/indefinite/answer`, { requestId: "date", text: "Tomorrow" })).status,
  ).toBe(202);
  expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("waiting");
  expect(
    (await post(`/api/bots/personal/tasks/${sent.taskId}/stop`, { requestId: "stop-wait" })).status,
  ).toBe(202);
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("closed"),
  );
  expect(
    (await post(`${answer}/expires/answer`, { requestId: "later", text: "Hangzhou" })).status,
  ).toBe(409);
  expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].questions[0].state).toBe(
    "cancelled",
  );
  expect(external.launches).toHaveLength(1);
});

it("recovers a question confirmed by read_operation after a lost response and wait checkpoint", async () => {
  const service = await startPiService(
    async (request) => {
      const results = request.messages.filter((row) => row.role === "tool");
      if (!results.length)
        return {
          tool: "ask_question",
          arguments: { requestId: "timeout-city", text: "Which city?" },
        };
      if (results.length === 1)
        return { tool: "read_operation", arguments: { requestId: "timeout-city" } };
      return { text: "Trip confirmed" };
    },
    { contextWindow: 65536 },
  );
  const pi = new PiProvider({ modelRuntime: service.runtime, model: service.model });
  // Lose the operation response at the external execution boundary after the real Host persisted it.
  const driver = piRunDriver({
    query(input) {
      return pi.query({
        ...input,
        history: async (operation, value, signal) => {
          const result = await input.history?.(operation, value, signal);
          if (operation === "ask_question")
            throw new Error(
              "Host operation timeout-city is not confirmed. Call read_operation with the same requestId and do not publish again.",
            );
          return result;
        },
      });
    },
  });
  try {
    const configuration = await start(driver);
    const sent = await (
      await post("/api/bots/personal/thread/messages", {
        requestId: "timeout-source",
        text: "Plan a trip",
      })
    ).json();
    await vi.waitFor(async () =>
      expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("waiting"),
    );
    expect(service.requests).toHaveLength(2);
    await channel.close();
    await host.stop();
    const db = new DatabaseSync(join(root, "data", "host.db"));
    try {
      db.prepare("UPDATE runs SET state = 'queued', wait_reason = NULL WHERE id = ?").run(
        sent.runId,
      );
    } finally {
      db.close();
    }
    host = await Host.start({
      root,
      configuration,
      driver,
      now: () => now,
      reconcileMs: 365 * 86400000,
    });
    channel = await WebSocketChannel.listen({ root, host, configuration, port: 0 });
    base = `http://127.0.0.1:${channel.address.port}`;
    expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("waiting");
    expect(service.requests).toHaveLength(2);
    expect(
      (
        await post(`/api/bots/personal/runs/${sent.runId}/questions/timeout-city/answer`, {
          requestId: "timeout-answer",
          text: "Hangzhou",
        })
      ).status,
    ).toBe(202);
    await vi.waitFor(async () =>
      expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("succeeded"),
    );
    expect(service.requests).toHaveLength(3);
  } finally {
    await channel?.close();
    await host?.stop();
    await service.close();
  }
}, 20000);
