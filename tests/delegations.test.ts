import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostMailbox, RunnerMailbox } from "@mybots/mailbox/node";
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
  root = await mkdtemp(join(tmpdir(), "mybots-delegation-"));
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
async function writer() {
  const created = await (
    await post("/api/bots", {
      requestId: "writer-bot",
      name: "Writer",
      instructions: "Write only the supplied text.",
      model: { provider: "deepseek", id: "deepseek-chat" },
      tools: ["read", "bash"],
    })
  ).json();
  return created.bot.id as string;
}

it("delegates one allowed child and continues the same parent Run", async () => {
  const releaseChild = Promise.withResolvers<void>();
  const driver = new MailboxDriver();
  let parentAttempts = 0;
  driver.respond = async (input, _material, signal) => {
    if (input.content === "Selected summary text" || input.content === "Steer the child") {
      await Promise.race([
        releaseChild.promise,
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
      ]);
      if (signal.aborted) return "stopped";
    }
    if (input.content === "Selected summary text" || input.content === "Steer the child")
      return "Child report";
    if (input.content === "Plan the report") {
      parentAttempts += 1;
      if (parentAttempts === 1) {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return "Do not finish before the child";
      }
      return "Parent handled the child";
    }
    return `Final: ${input.content}`;
  };
  const configuration = await start(driver);
  const targetId = await writer();
  expect((await get("/api/bots/personal/thread")).collaboration).toEqual([
    expect.objectContaining({ targetBotId: targetId, name: "Writer", mode: "deny" }),
  ]);
  expect(
    (
      await post(`/api/bots/personal/collaboration/${targetId}`, {
        requestId: "self",
        mode: "allow",
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await post("/api/bots/personal/collaboration/personal", {
        requestId: "self-grant",
        mode: "allow",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await post(`/api/bots/personal/collaboration/${targetId}`, {
        requestId: "ask-mode",
        mode: "ask-each-time",
      })
    ).status,
  ).toBe(409);
  await post(`/api/bots/personal/collaboration/${targetId}`, {
    requestId: "reset-deny",
    mode: "deny",
  });
  const sent = await (
    await post("/api/bots/personal/thread/messages", {
      requestId: "source",
      text: "Plan the report",
    })
  ).json();
  await vi.waitFor(() => expect(driver.launches).toHaveLength(1));
  const mailbox = new RunnerMailbox(driver.launches[0]?.material.directory as string);
  const denied = await ask(mailbox, "denied-once", "delegate", {
    requestId: "denied-once",
    targetBotId: targetId,
    text: "Selected summary text",
  });
  expect(denied.result).toMatchObject({
    id: "denied-once",
    state: "denied",
    result: "Directed collaboration is denied.",
    childTaskId: null,
  });
  const repeated = await ask(mailbox, "denied-again", "delegate", {
    requestId: "denied-again",
    targetBotId: targetId,
    text: "Selected summary text",
  });
  expect(repeated.result).toMatchObject({ id: "denied-once", state: "denied" });
  expect((await get(`/api/bots/${targetId}/thread`)).tasks).toEqual([]);
  expect(
    (
      await ask(mailbox, "self-delegate", "delegate", {
        requestId: "self-delegate",
        targetBotId: "personal",
        text: "Selected summary text",
      })
    ).error,
  ).toBe("A Bot cannot delegate to itself.");
  const allowed = await post(`/api/bots/personal/collaboration/${targetId}`, {
    requestId: "allow-writer",
    mode: "allow",
  });
  expect(allowed.status).toBe(201);
  expect((await get("/api/bots/personal/thread")).collaboration[0]).toMatchObject({
    targetBotId: targetId,
    mode: "allow",
  });
  const delegated = await ask(mailbox, "child-one", "delegate", {
    requestId: "child-one",
    targetBotId: targetId,
    text: "Selected summary text",
  });
  expect(delegated.result).toMatchObject({
    id: "child-one",
    state: "pending",
    sourceBotId: "personal",
    targetBotId: targetId,
    parentTaskId: sent.taskId,
    parentRunId: sent.runId,
    originatingRunId: sent.runId,
  });
  expect(
    (await ask(mailbox, "read-child", "read_operation", { requestId: "child-one" })).result,
  ).toMatchObject({ state: "recorded", delegation: { id: "child-one", state: "pending" } });
  mailbox.requestDurableWait("delegation");
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("waiting"),
  );
  const waiting = (await get("/api/bots/personal/thread")).tasks[0].runs[0];
  expect(waiting.outcome).toBeNull();
  expect(waiting.delegations.find((row: { id: string }) => row.id === "child-one")).toMatchObject({
    id: "child-one",
    childTaskId: delegated.result?.childTaskId,
    childRunId: delegated.result?.childRunId,
  });
  const child = (await get(`/api/bots/${targetId}/thread`)).tasks[0];
  expect(child.origin).toBe("delegation");
  expect(child.runs[0].references).toEqual([]);
  expect(child.runs[0].inputs[0].text).toBe("Selected summary text");
  const childLaunch = driver.launches.find(
    (row) => row.material.key.sessionId === delegated.result?.childRunId,
  );
  const parentLaunch = driver.launches.find((row) => row.material.key.sessionId === sent.runId);
  expect(childLaunch?.material.workspace).not.toBe(parentLaunch?.material.workspace);
  expect(childLaunch?.material.workspace.endsWith(targetId)).toBe(true);
  await writeFile(join(root, "groups", "personal", "secret.txt"), "source-only");
  expect(child.runs[0].inputs[0].text).not.toContain("source-only");
  now += 10_000;
  await host.reconcile();
  expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].budget.activeMs).toBe(
    waiting.budget.activeMs,
  );
  await vi.waitFor(async () =>
    expect((await get(`/api/bots/${targetId}/thread`)).tasks[0].runs[0].state).toBe("active"),
  );
  expect((await get("/api/bots/personal/thread")).admission.activeCount).toBe(1);
  const chat = await (
    await post(`/api/bots/${targetId}/thread/messages`, {
      requestId: "writer-chat",
      text: "Ordinary writer chat",
    })
  ).json();
  expect(chat.taskId).not.toBe(delegated.result?.childTaskId);
  expect(
    (await get(`/api/bots/${targetId}/thread`)).tasks.map(
      (task: { origin: string }) => task.origin,
    ),
  ).toEqual(["delegation", "chat"]);
  const steered = await post(
    `/api/bots/${targetId}/tasks/${delegated.result?.childTaskId}/inputs`,
    {
      requestId: "child-steer",
      text: "Steer the child",
    },
  );
  expect(steered.status).toBe(202);
  expect((await steered.json()).runId).toBe(delegated.result?.childRunId);
  expect(
    (
      await post("/api/bots/personal/settings", {
        requestId: "during-wait",
        instructions: "Use the child report",
        model: { provider: configuration.agent.model.provider, id: configuration.agent.model.id },
        tools: ["read", "bash"],
      })
    ).status,
  ).toBe(201);
  const parentAddition = await post(`/api/bots/personal/tasks/${sent.taskId}/inputs`, {
    requestId: "parent-note",
    text: "Parent note does not settle the child",
  });
  expect((await parentAddition.json()).runId).toBe(sent.runId);
  expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("waiting");
  expect(
    (await get("/api/bots/personal/thread")).tasks[0].runs[0].delegations.find(
      (row: { id: string }) => row.id === "child-one",
    ).state,
  ).toBe("pending");
  const childMailbox = new RunnerMailbox(childLaunch?.material.directory as string);
  expect(
    (
      await ask(childMailbox, "reverse-denied", "delegate", {
        requestId: "reverse-denied",
        targetBotId: "personal",
        text: "Ask the source for more",
      })
    ).result,
  ).toMatchObject({ state: "denied", childTaskId: null });
  expect(
    (
      await post(`/api/bots/${targetId}/collaboration/personal`, {
        requestId: "allow-reverse",
        mode: "allow",
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await ask(childMailbox, "reverse-nested", "delegate", {
        requestId: "reverse-nested",
        targetBotId: "personal",
        text: "Ask the source for more",
      })
    ).error,
  ).toBe("Nested delegation is not available.");
  releaseChild.resolve();
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("succeeded"),
  );
  const parent = (await get("/api/bots/personal/thread")).tasks[0].runs[0];
  expect(parent.id).toBe(sent.runId);
  expect(parent.attempts).toHaveLength(2);
  expect(parent.attempts[1].configurationVersion).toBeGreaterThan(
    parent.attempts[0].configurationVersion,
  );
  expect(parent.delegations.find((row: { id: string }) => row.id === "child-one")).toMatchObject({
    state: "succeeded",
    result: "Child report",
  });
  expect(parent.outcome.kind).toBe("succeeded");
  const resumed = driver.launches.filter((row) => row.material.key.sessionId === sent.runId).at(-1);
  const context = JSON.parse(await readFile(resumed?.material.contextFile as string, "utf8"));
  expect(context.instructions).toBe("Use the child report");
  expect(context.runContext.delegations).toEqual([
    expect.objectContaining({ id: "denied-once", state: "denied" }),
    expect.objectContaining({ id: "child-one", state: "succeeded", result: "Child report" }),
  ]);
  const childRun = (await get(`/api/bots/${targetId}/thread`)).tasks[0].runs[0];
  expect(childRun.inputs.map((input: { text: string }) => input.text)).toEqual([
    "Selected summary text",
    "Steer the child",
  ]);
  expect((await host.inspect(sent.runId)).continuation).not.toBe(
    (await host.inspect(delegated.result?.childRunId as string)).continuation,
  );
});

it("treats child failure as parent input and keeps an uncertain child from completing the parent", async () => {
  const release = Promise.withResolvers<void>();
  const driver = new MailboxDriver();
  const continued = new Set<string>();
  driver.respond = async (input, material, signal) => {
    if (input.content === "Fail this child") {
      await release.promise;
      return { error: "Child blocked" };
    }
    if (input.content === "Leave this child uncertain") {
      new RunnerMailbox(material.directory).acknowledge(input.id, "failed");
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return "Must not replace the gap";
    }
    if (input.content.startsWith("Plan ")) {
      if (!continued.has(input.content)) {
        continued.add(input.content);
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return "unused";
      }
      return "Parent continues after the child";
    }
    return `Final: ${input.content}`;
  };
  await start(driver);
  const targetId = await writer();
  await post(`/api/bots/personal/collaboration/${targetId}`, {
    requestId: "allow-failure",
    mode: "allow",
  });
  const failedParent = await (
    await post("/api/bots/personal/thread/messages", {
      requestId: "fail-source",
      text: "Plan failure",
    })
  ).json();
  await vi.waitFor(() => expect(driver.launches).toHaveLength(1));
  const mailbox = new RunnerMailbox(driver.launches[0]?.material.directory as string);
  await ask(mailbox, "failed-child", "delegate", {
    requestId: "failed-child",
    targetBotId: targetId,
    text: "Fail this child",
  });
  mailbox.requestDurableWait("delegation");
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("waiting"),
  );
  release.resolve();
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("succeeded"),
  );
  const parent = (await get("/api/bots/personal/thread")).tasks[0].runs[0];
  expect(parent.id).toBe(failedParent.runId);
  expect(parent.delegations.find((row: { id: string }) => row.id === "failed-child")).toMatchObject(
    {
      state: "failed",
      result: "Child blocked",
    },
  );
  expect(parent.outcome.reply).toBe("Parent continues after the child");
  const uncertain = await (
    await post("/api/bots/personal/thread/tasks", {
      requestId: "uncertain-source",
      text: "Plan uncertainty",
    })
  ).json();
  await vi.waitFor(() =>
    expect(driver.launches.some((row) => row.material.key.sessionId === uncertain.runId)).toBe(
      true,
    ),
  );
  const uncertainMailbox = new RunnerMailbox(
    driver.launches.find((row) => row.material.key.sessionId === uncertain.runId)?.material
      .directory as string,
  );
  const child = await ask(uncertainMailbox, "uncertain-child", "delegate", {
    requestId: "uncertain-child",
    targetBotId: targetId,
    text: "Leave this child uncertain",
  });
  uncertainMailbox.requestDurableWait("delegation");
  await vi.waitFor(async () =>
    expect(
      (await get("/api/bots/personal/thread")).tasks.find(
        (task: { id: string }) => task.id === uncertain.taskId,
      ).runs[0].state,
    ).toBe("waiting"),
  );
  const stop = await post(`/api/bots/${targetId}/runs/${child.result?.childRunId}/stop`, {
    requestId: "stop-uncertain-child",
  });
  expect(stop.status).toBe(202);
  await vi.waitFor(async () =>
    expect(
      (await get(`/api/bots/${targetId}/thread`)).tasks
        .flatMap((task: { runs: { id: string; state: string }[] }) => task.runs)
        .find((run: { id: string }) => run.id === child.result?.childRunId)?.state,
    ).toBe("uncertain"),
  );
  const held = (await get("/api/bots/personal/thread")).tasks.find(
    (task: { id: string }) => task.id === uncertain.taskId,
  ).runs[0];
  expect(held.state).toBe("waiting");
  expect(held.held).toBe(true);
  expect(held.outcome).toBeNull();
  expect(held.delegations[0].state).toBe("uncertain");
  expect(
    (
      await post(`/api/bots/personal/runs/${uncertain.runId}/stop`, {
        requestId: "stop-uncertain-parent",
      })
    ).status,
  ).toBe(202);
  await vi.waitFor(async () =>
    expect(
      (await get("/api/bots/personal/thread")).tasks.find(
        (task: { id: string }) => task.id === uncertain.taskId,
      ).runs[0],
    ).toMatchObject({
      state: "stopping",
      held: true,
      outcome: null,
      stopError: "Owned child stop is unconfirmed.",
    }),
  );
});

it("cancels owned child work, keeps unrelated target work, and fences a late result", async () => {
  const releaseWriter = Promise.withResolvers<void>();
  const driver = new MailboxDriver();
  driver.respond = async (input, _material, signal) => {
    if (input.content === "Unrelated notes") {
      await releaseWriter.promise;
      return "Writer continues";
    }
    if (input.content === "Stop this child" || input.content === "Plan a cancellation") {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return "unused";
    }
    return `Final: ${input.content}`;
  };
  await start(driver);
  const targetId = await writer();
  await post(`/api/bots/personal/collaboration/${targetId}`, {
    requestId: "allow-cancel",
    mode: "allow",
  });
  const sent = await (
    await post("/api/bots/personal/thread/messages", {
      requestId: "cancel-source",
      text: "Plan a cancellation",
    })
  ).json();
  await vi.waitFor(() =>
    expect(driver.launches.map((row) => row.material.key.sessionId)).toContain(sent.runId),
  );
  const mailbox = new RunnerMailbox(
    driver.launches.find((row) => row.material.key.sessionId === sent.runId)?.material
      .directory as string,
  );
  const delegated = await ask(mailbox, "cancel-child", "delegate", {
    requestId: "cancel-child",
    targetBotId: targetId,
    text: "Stop this child",
  });
  mailbox.requestDurableWait("delegation");
  await vi.waitFor(async () =>
    expect((await get(`/api/bots/${targetId}/thread`)).tasks[0].runs[0].state).toBe("active"),
  );
  const unrelated = await (
    await post(`/api/bots/${targetId}/thread/messages`, {
      requestId: "unrelated",
      text: "Unrelated notes",
    })
  ).json();
  expect(unrelated.taskId).not.toBe(delegated.result?.childTaskId);
  expect((await get(`/api/bots/${targetId}/thread`)).tasks[1].runs[0].state).toBe("queued");
  const stopped = await post(`/api/bots/personal/runs/${sent.runId}/stop`, {
    requestId: "stop-parent",
  });
  expect(stopped.status).toBe(202);
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("closed"),
  );
  const writerTasks = await get(`/api/bots/${targetId}/thread`);
  expect(writerTasks.tasks[0].runs[0]).toMatchObject({
    id: delegated.result?.childRunId,
    state: "closed",
  });
  expect(writerTasks.tasks[1]).toMatchObject({ id: unrelated.taskId });
  expect(["queued", "active"]).toContain(writerTasks.tasks[1].runs[0].state);
  const directory = driver.launches.find(
    (row) => row.material.key.sessionId === delegated.result?.childRunId,
  )?.material.directory as string;
  const input = new HostMailbox(directory).inputs().at(-1);
  if (input) new RunnerMailbox(directory).reply(input, "Late child result", "message");
  await host.reconcile();
  expect((await get("/api/bots/personal/thread")).tasks[0].runs[0]).toMatchObject({
    id: sent.runId,
    state: "closed",
  });
  expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].attempts).toHaveLength(1);
  releaseWriter.resolve();
  await vi.waitFor(async () =>
    expect((await get(`/api/bots/${targetId}/thread`)).tasks[1].runs[0].state).toBe("succeeded"),
  );
  expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("closed");
});

it("resumes the original parent Run after restart", async () => {
  const releaseChild = Promise.withResolvers<void>();
  const driver = new MailboxDriver();
  let parentAttempts = 0;
  driver.respond = async (input, _material, signal) => {
    if (input.content === "Restart child text") {
      await Promise.race([
        releaseChild.promise,
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
      ]);
      if (signal.aborted) return "stopped";
      return "Child survived restart";
    }
    if (input.content === "Plan across restart") {
      parentAttempts += 1;
      if (parentAttempts === 1) {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return "unused";
      }
      return "Parent resumed";
    }
    return `Final: ${input.content}`;
  };
  const configuration = await start(driver);
  const targetId = await writer();
  await post(`/api/bots/personal/collaboration/${targetId}`, {
    requestId: "allow-restart",
    mode: "allow",
  });
  const sent = await (
    await post("/api/bots/personal/thread/messages", {
      requestId: "restart-source",
      text: "Plan across restart",
    })
  ).json();
  await vi.waitFor(() => expect(driver.launches).toHaveLength(1));
  const mailbox = new RunnerMailbox(driver.launches[0]?.material.directory as string);
  await ask(mailbox, "restart-child", "delegate", {
    requestId: "restart-child",
    targetBotId: targetId,
    text: "Restart child text",
  });
  mailbox.requestDurableWait("delegation");
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("waiting"),
  );
  await channel.close();
  await host.stop();
  host = await Host.start({
    root,
    configuration,
    driver,
    now: () => now,
    reconcileMs: 365 * 86400000,
  });
  channel = await WebSocketChannel.listen({ root, host, configuration, port: 0 });
  base = `http://127.0.0.1:${channel.address.port}`;
  expect((await get("/api/bots/personal/thread")).tasks[0].runs[0]).toMatchObject({
    id: sent.runId,
    state: "waiting",
  });
  now += 6000;
  await host.reconcile();
  releaseChild.resolve();
  await vi.waitFor(
    async () =>
      expect((await get("/api/bots/personal/thread")).tasks[0].runs[0]).toMatchObject({
        id: sent.runId,
        state: "succeeded",
        outcome: { reply: "Parent resumed" },
      }),
    { timeout: 8000 },
  );
  expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].delegations[0]).toMatchObject({
    state: "succeeded",
    result: "Child survived restart",
  });
});

it("records a real SDK delegation and resumes that Run with current Memory", async () => {
  const releaseChild = Promise.withResolvers<void>();
  let childRequests = 0;
  const service = await startPiService(async (request) => {
    const body = JSON.stringify(request);
    if (body.includes("Summarize only this sentence")) {
      childRequests += 1;
      if (childRequests === 1) {
        await releaseChild.promise;
        return { tool: "bash", arguments: { command: "printf child > child-note.txt" } };
      }
      return { text: "Child summary" };
    }
    if (body.includes("Delegate this summary") && !body.includes("Delegated work"))
      return {
        tool: "delegate",
        arguments: {
          requestId: "sdk-child",
          targetBotId: body.match(/ag-[0-9a-f-]+/)?.[0],
          text: "Summarize only this sentence",
        },
      };
    if (body.includes("Child summary")) return { text: "Parent continued" };
    return { text: "done" };
  });
  try {
    const driver = piRunDriver(
      new PiProvider({ modelRuntime: service.runtime, model: service.model }),
    );
    const configuration = await start(driver);
    const targetId = await writer();
    expect(
      (
        await post(`/api/bots/personal/collaboration/${targetId}`, {
          requestId: "sdk-allow",
          mode: "allow",
        })
      ).status,
    ).toBe(201);
    const sent = await (
      await post("/api/bots/personal/thread/messages", {
        requestId: "sdk-source",
        text: `Delegate this summary to ${targetId}`,
      })
    ).json();
    await vi.waitFor(async () =>
      expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("waiting"),
    );
    const child = (await get(`/api/bots/${targetId}/thread`)).tasks[0];
    expect(child.origin).toBe("delegation");
    await service.waitForRequest(2);
    const steered = await post(`/api/bots/${targetId}/tasks/${child.id}/inputs`, {
      requestId: "sdk-steer",
      text: "Steer the real child",
    });
    expect((await steered.json()).runId).toBe(child.runs[0].id);
    const memory = await get("/api/bots/personal/memory");
    expect(
      (
        await fetch(`${base}/api/bots/personal/memory/index`, {
          method: "PUT",
          headers,
          body: JSON.stringify({
            content: "Owner correction: prefer the child wording",
            version: memory.index?.version ?? null,
          }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post("/api/bots/personal/settings", {
          requestId: "sdk-settings",
          instructions: "Continue from delegated evidence",
          model: { provider: configuration.agent.model.provider, id: configuration.agent.model.id },
          tools: ["read", "bash"],
        })
      ).status,
    ).toBe(201);
    const ledger = (await host.inspect(sent.runId)).continuation;
    releaseChild.resolve();
    await vi.waitFor(async () => {
      const run = (await get("/api/bots/personal/thread")).tasks[0].runs[0];
      expect(run.state).toBe("succeeded");
    });
    const parent = (await get("/api/bots/personal/thread")).tasks[0].runs[0];
    expect(parent.id).toBe(sent.runId);
    expect(parent.attempts.length).toBeGreaterThan(1);
    expect((await host.inspect(sent.runId)).continuation).toBe(ledger);
    const resumed = service.requests.find((request) =>
      JSON.stringify(request).includes("Delegated work sdk-child"),
    );
    expect(JSON.stringify(resumed)).toContain("Child summary");
    expect(JSON.stringify(resumed)).toContain("Owner correction: prefer the child wording");
    expect(JSON.stringify(resumed)).toContain("Continue from delegated evidence");
    const childRequestsBody = service.requests.filter((request) => {
      const body = JSON.stringify(request);
      return (
        body.includes("Summarize only this sentence") && !body.includes("Delegated work sdk-child")
      );
    });
    expect(
      childRequestsBody.some((request) => JSON.stringify(request).includes("Steer the real child")),
    ).toBe(true);
    expect(
      childRequestsBody.every(
        (request) => !JSON.stringify(request).includes("Delegate this summary"),
      ),
    ).toBe(true);
    expect(await readFile(join(root, "groups", targetId, "child-note.txt"), "utf8")).toBe("child");
    await expect(readFile(join(root, "groups", "personal", "child-note.txt"))).rejects.toThrow();
  } finally {
    await service.close();
  }
});
