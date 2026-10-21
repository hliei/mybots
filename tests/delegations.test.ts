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

it("waits for an exact local approval before delegating and continues the same Run", async () => {
  const driver = new MailboxDriver();
  const visits = new Set<string>();
  driver.respond = async (input, _material, signal) => {
    if (input.content === "Approve this work" && !visits.has(input.content)) {
      visits.add(input.content);
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    return `Completed: ${input.content}`;
  };
  await start(driver);
  const targetId = await writer();
  const grant = await post(`/api/bots/personal/collaboration/${targetId}`, {
    requestId: "approval-mode",
    mode: "ask-each-time",
  });
  expect(grant.status).toBe(201);
  const sent = await (
    await post("/api/bots/personal/thread/messages", {
      requestId: "approval-source",
      text: "Approve this work",
    })
  ).json();
  await vi.waitFor(() => expect(driver.launches).toHaveLength(1));
  const mailbox = new RunnerMailbox(driver.launches[0]?.material.directory as string);
  const proposal = { requestId: "exact-child", targetBotId: targetId, text: "Only these inputs" };
  const response = await ask(mailbox, proposal.requestId, "delegate", proposal);
  expect(response.result).toMatchObject({
    state: "pending",
    childTaskId: null,
    approval: { id: "exact-child", operation: "delegate", state: "pending", deadline: null },
  });
  expect((await get(`/api/bots/${targetId}/thread`)).tasks).toEqual([]);
  mailbox.requestDurableWait("delegation");
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("waiting"),
  );
  const waiting = (await get("/api/bots/personal/thread")).tasks[0].runs[0];
  expect(waiting.attempts[0].endedAt).not.toBeNull();
  expect((await get("/api/bots/personal/thread")).admission.activeCount).toBe(0);
  now += 86400000;
  await host.reconcile();
  expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].budget.activeMs).toBe(
    waiting.budget.activeMs,
  );
  const decided = await post(
    `/api/bots/personal/runs/${sent.runId}/approvals/exact-child/decision`,
    {
      requestId: "approve-exact",
      decision: "approve",
      operation: "delegate",
      targetBotId: targetId,
      text: proposal.text,
      deadline: null,
    },
  );
  expect(decided.status).toBe(202);
  await host.reconcile();
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("succeeded"),
  );
  const parent = (await get("/api/bots/personal/thread")).tasks[0].runs[0];
  expect(parent).toMatchObject({
    id: sent.runId,
    delegations: [
      expect.objectContaining({
        state: "succeeded",
        approval: expect.objectContaining({ state: "executed", decision: "approve" }),
      }),
    ],
  });
  expect(parent.attempts).toHaveLength(2);
  const child = (await get(`/api/bots/${targetId}/thread`)).tasks;
  expect(child).toHaveLength(1);
  expect(child[0].runs[0].inputs[0].text).toBe(proposal.text);
});

it("fences a granted action when permission becomes deny before execution, even if restored", async () => {
  const driver = new MailboxDriver();
  driver.respond = async (_input, _material, signal) => {
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return "stopped";
  };
  await start(driver);
  const targetId = await writer();
  await post(`/api/bots/personal/collaboration/${targetId}`, {
    requestId: "ask-revoke",
    mode: "ask-each-time",
  });
  const source = await (
    await post("/api/bots/personal/thread/messages", {
      requestId: "revoke-source",
      text: "Hold approval",
    })
  ).json();
  await vi.waitFor(() => expect(driver.launches).toHaveLength(1));
  const mailbox = new RunnerMailbox(driver.launches[0]?.material.directory as string);
  await ask(mailbox, "revoke-action", "delegate", {
    requestId: "revoke-action",
    targetBotId: targetId,
    text: "Revoked inputs",
  });
  const decision = await post(
    `/api/bots/personal/runs/${source.runId}/approvals/revoke-action/decision`,
    {
      requestId: "revoke-approve",
      decision: "approve",
      operation: "delegate",
      targetBotId: targetId,
      text: "Revoked inputs",
      deadline: null,
    },
  );
  expect(decision.status).toBe(202);
  expect((await get(`/api/bots/${targetId}/thread`)).tasks).toEqual([]);
  await post(`/api/bots/personal/collaboration/${targetId}`, {
    requestId: "revoke-deny",
    mode: "deny",
  });
  await post(`/api/bots/personal/collaboration/${targetId}`, {
    requestId: "revoke-restore",
    mode: "allow",
  });
  mailbox.requestDurableWait("delegation");
  await vi.waitFor(async () => {
    const run = (await get("/api/bots/personal/thread")).tasks[0].runs[0];
    expect(run.delegations[0]).toMatchObject({
      state: "denied",
      childRunId: null,
      approval: { state: "stale" },
    });
  });
  expect((await get(`/api/bots/${targetId}/thread`)).tasks).toEqual([]);
});

async function approvalScenario(deadline?: string, text = "Concrete selected inputs") {
  const driver = new MailboxDriver();
  let attempts = 0;
  const sourceReady = Promise.withResolvers<void>();
  driver.respond = async (input, _material, signal) => {
    if (input.content === "Approval source" && ++attempts === 1) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
        sourceReady.resolve();
      });
    }
    return `Handled: ${input.content}`;
  };
  const configuration = await start(driver);
  const targetId = await writer();
  await post(`/api/bots/personal/collaboration/${targetId}`, {
    requestId: "scenario-mode",
    mode: "ask-each-time",
  });
  const source = await (
    await post("/api/bots/personal/thread/messages", {
      requestId: "scenario-source",
      text: "Approval source",
    })
  ).json();
  await vi.waitFor(() => expect(driver.launches).toHaveLength(1));
  await sourceReady.promise;
  const mailbox = new RunnerMailbox(driver.launches[0]?.material.directory as string);
  const proposal = {
    requestId: "scenario-action",
    targetBotId: targetId,
    text,
    ...(deadline ? { deadline } : {}),
  };
  const response = await ask(mailbox, proposal.requestId, "delegate", proposal);
  expect(response.result).toMatchObject({ state: "pending", childRunId: null });
  const path = `/api/bots/personal/runs/${source.runId}/approvals/${proposal.requestId}/decision`;
  const decision = {
    requestId: "scenario-decision",
    decision: "approve",
    operation: "delegate",
    targetBotId: targetId,
    text: proposal.text,
    deadline: deadline ?? null,
  };
  return { configuration, driver, targetId, source, mailbox, proposal, path, decision };
}

it.each([
  ["Chinese", "资料".repeat(11000)],
  ["astral characters", "🧪".repeat(17000)],
])(
  "approves accepted delegation inputs containing %s without changing them",
  async (_label, text) => {
    const { mailbox, path, decision, targetId } = await approvalScenario(undefined, text);
    mailbox.requestDurableWait("delegation");
    await vi.waitFor(async () =>
      expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("waiting"),
    );
    expect((await post(path, { ...decision, text: "x".repeat(32001) })).status).toBe(400);
    expect((await post(path, { ...decision, text: "x".repeat(256 * 1024) })).status).toBe(413);
    expect((await post(path, decision)).status).toBe(202);
    await host.reconcile();
    await vi.waitFor(async () =>
      expect((await get(`/api/bots/${targetId}/thread`)).tasks).toHaveLength(1),
    );
    const childRun = (await get(`/api/bots/${targetId}/thread`)).tasks[0].runs[0];
    expect(childRun.delegations[0].text).toBe(text);
    expect(childRun.delegations[0].approval.text).toBe(text);
    expect(childRun.inputs[0].truncated).toBe(true);
  },
);

it("returns an owner denial to the source and suppresses identical automatic requests", async () => {
  const { mailbox, proposal, path, decision, targetId, source } = await approvalScenario();
  const denied = { ...decision, decision: "deny" };
  expect((await post(path, denied)).status).toBe(202);
  expect((await post(path, denied)).status).toBe(202);
  expect((await post(path, { ...decision, requestId: "late-opposite" })).status).toBe(409);
  const repeated = await ask(mailbox, "repeated-denied-action", "delegate", {
    ...proposal,
    requestId: "repeated-denied-action",
  });
  expect(repeated.result).toMatchObject({
    id: proposal.requestId,
    state: "denied",
    result: expect.stringContaining("Owner denied"),
    approval: { decision: "deny" },
  });
  mailbox.requestDurableWait("delegation");
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("succeeded"),
  );
  expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].id).toBe(source.runId);
  expect((await get(`/api/bots/${targetId}/thread`)).tasks).toEqual([]);
});

it("rejects changed inputs and uncorrelated decisions without authorizing from ordinary input", async () => {
  const { mailbox, path, decision, targetId, source } = await approvalScenario();
  expect((await post(path, { ...decision, text: "Changed inputs" })).status).toBe(409);
  expect((await post(path, { ...decision, targetBotId: "personal" })).status).toBe(409);
  expect((await post(path, { ...decision, deadline: "2026-10-22T00:00:00Z" })).status).toBe(409);
  expect((await post(path.replace("personal/runs", `${targetId}/runs`), decision)).status).toBe(
    404,
  );
  expect(
    (
      await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(decision),
      })
    ).status,
  ).toBe(401);
  expect((await post(path, { ...decision, extra: "grant" })).status).toBe(400);
  const forged = await ask(mailbox, "runner-approve", "decide_approval", decision);
  expect(forged.error).toBeDefined();
  mailbox.requestDurableWait("delegation");
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("waiting"),
  );
  expect(
    (
      await post(`/api/bots/personal/tasks/${source.taskId}/inputs`, {
        requestId: "text-approval",
        text: "I approve",
      })
    ).status,
  ).toBe(202);
  expect(
    (
      await post("/api/bots/personal/thread/messages", {
        requestId: "thread-approval",
        text: "Approve this action",
      })
    ).status,
  ).toBe(202);
  expect((await get(`/api/bots/${targetId}/thread`)).tasks).toEqual([]);
  expect(
    (await get("/api/bots/personal/thread")).tasks[0].runs[0].delegations[0].approval.state,
  ).toBe("pending");
});

it.each([false, true])(
  "expires only at an explicit deadline and keeps the source needing attention (approved: %s)",
  async (approved) => {
    const { mailbox, path, decision, targetId, source } = await approvalScenario(
      "2026-10-20T00:01:00.000Z",
    );
    if (approved) {
      expect((await post(path, decision)).status).toBe(202);
      now += 60_000;
    }
    mailbox.requestDurableWait("delegation");
    await vi.waitFor(async () =>
      expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("waiting"),
    );
    if (!approved) now += 60_000;
    await host.reconcile();
    const run = (await get("/api/bots/personal/thread")).tasks[0].runs[0];
    expect(run).toMatchObject({
      id: source.runId,
      state: "waiting",
      outcome: null,
      delegations: [
        expect.objectContaining({
          childRunId: null,
          approval: expect.objectContaining({
            state: "expired",
            decision: approved ? "approve" : null,
          }),
        }),
      ],
    });
    expect(
      (await get("/api/bot-summaries")).bots.find((bot: { id: string }) => bot.id === "personal"),
    ).toMatchObject({ working: false, attention: true });
    expect((await post(path, { ...decision, requestId: "expired-late" })).status).toBe(409);
    expect((await get(`/api/bots/${targetId}/thread`)).tasks).toEqual([]);
    expect(
      (await post(`/api/bots/personal/runs/${source.runId}/stop`, { requestId: "stop-expired" }))
        .status,
    ).toBe(202);
    await vi.waitFor(async () =>
      expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("closed"),
    );
  },
);

it("cancels a pending approval and fences late decisions", async () => {
  const { mailbox, path, decision, targetId, source } = await approvalScenario();
  mailbox.requestDurableWait("delegation");
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("waiting"),
  );
  expect(
    (await post(`/api/bots/personal/runs/${source.runId}/stop`, { requestId: "stop-approval" }))
      .status,
  ).toBe(202);
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("closed"),
  );
  expect((await post(path, decision)).status).toBe(409);
  expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].delegations[0]).toMatchObject({
    state: "cancelled",
    approval: { state: "cancelled" },
  });
  expect((await get(`/api/bots/${targetId}/thread`)).tasks).toEqual([]);
});

it("queries the original action after response loss and resumes a pending approval across Host restart", async () => {
  const { configuration, driver, mailbox, path, decision, targetId, source, proposal } =
    await approvalScenario();
  const lookup = await ask(mailbox, "lost-action-lookup", "read_operation", {
    requestId: proposal.requestId,
  });
  expect(lookup.result).toMatchObject({
    state: "recorded",
    delegation: { id: proposal.requestId, childRunId: null, approval: { state: "pending" } },
  });
  mailbox.requestDurableWait("delegation");
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("waiting"),
  );
  await channel.close();
  await host.stop();
  now += 7 * 86400000;
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
    id: source.runId,
    state: "waiting",
    delegations: [
      expect.objectContaining({ approval: expect.objectContaining({ state: "pending" }) }),
    ],
  });
  expect((await post(path, decision)).status).toBe(202);
  await host.reconcile();
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("succeeded"),
  );
  expect((await post(path, decision)).status).toBe(202);
  expect((await post(path, { ...decision, requestId: "late-duplicate" })).status).toBe(409);
  expect((await post(path, { ...decision, decision: "deny" })).status).toBe(409);
  await host.reconcile();
  expect((await get(`/api/bots/${targetId}/thread`)).tasks).toHaveLength(1);
  expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].attempts).toHaveLength(2);
});

it("reserves approval identity against other public operations", async () => {
  const { proposal, targetId, path, decision, mailbox } = await approvalScenario();
  expect(
    (
      await post("/api/bots/personal/thread/messages", {
        requestId: proposal.requestId,
        text: "Cannot steal approval identity",
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await post("/api/bots/personal/routines", {
        requestId: proposal.requestId,
        text: "Cannot steal approval identity",
        cron: "0 * * * *",
      })
    ).status,
  ).toBe(409);
  expect((await post(path, decision)).status).toBe(202);
  mailbox.requestDurableWait("delegation");
  await vi.waitFor(async () =>
    expect((await get(`/api/bots/${targetId}/thread`)).tasks).toHaveLength(1),
  );
});

it("holds uncertain approved child effects instead of automatically delegating again after restart", async () => {
  const { configuration, driver, targetId, mailbox, path, decision, source } =
    await approvalScenario();
  const childReady = Promise.withResolvers<void>();
  driver.respond = async (input, material, signal) => {
    new RunnerMailbox(material.directory).acknowledge(input.id, "failed");
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
      childReady.resolve();
    });
    return "Cannot prove the action result";
  };
  mailbox.requestDurableWait("delegation");
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("waiting"),
  );
  expect((await post(path, decision)).status).toBe(202);
  await host.reconcile();
  await vi.waitFor(async () =>
    expect((await get(`/api/bots/${targetId}/thread`)).tasks[0].runs[0].state).toBe("active"),
  );
  await childReady.promise;
  const child = (await get(`/api/bots/${targetId}/thread`)).tasks[0].runs[0];
  expect(
    (
      await post(`/api/bots/${targetId}/runs/${child.id}/stop`, {
        requestId: "stop-unknown-approved",
      })
    ).status,
  ).toBe(202);
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).tasks[0].runs[0]).toMatchObject({
      id: source.runId,
      state: "waiting",
      held: true,
      delegations: [
        expect.objectContaining({
          state: "uncertain",
          approval: expect.objectContaining({ state: "executed" }),
        }),
      ],
    }),
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
  expect((await post(path, decision)).status).toBe(202);
  await host.reconcile();
  expect((await get(`/api/bots/${targetId}/thread`)).tasks).toHaveLength(1);
  expect((await get("/api/bots/personal/thread")).tasks[0].runs[0]).toMatchObject({
    state: "waiting",
    held: true,
    outcome: null,
  });
  expect(
    (await post(`/api/bots/personal/runs/${source.runId}/retry`, { requestId: "no-auto-retry" }))
      .status,
  ).toBe(409);
});

it.each([false, true])(
  "keeps Routine commands and delegation identities distinct (command first: %s)",
  async (commandFirst) => {
    const driver = new MailboxDriver();
    driver.respond = async (_input, _material, signal) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return "Stopped";
    };
    await start(driver);
    const targetId = await writer();
    await post(`/api/bots/personal/collaboration/${targetId}`, {
      requestId: "identity-grant",
      mode: "allow",
    });
    const routine = await (
      await post("/api/bots/personal/routines", {
        requestId: "identity-routine",
        text: "Archive later",
        cron: "0 * * * *",
      })
    ).json();
    const source = await (
      await post("/api/bots/personal/thread/messages", {
        requestId: "identity-source",
        text: "Plan the archive",
      })
    ).json();
    await vi.waitFor(() => expect(driver.launches).toHaveLength(1));
    const mailbox = new RunnerMailbox(driver.launches[0]?.material.directory as string);
    const command = () =>
      post(`/api/bots/personal/routines/${routine.id}/pause`, {
        requestId: "same-operation",
      });
    const delegate = () =>
      ask(mailbox, "same-operation", "delegate", {
        requestId: "same-operation",
        targetBotId: targetId,
        text: "Selected archive text",
      });
    if (commandFirst) {
      expect((await command()).status).toBe(200);
      expect((await delegate()).error).toMatch(/(requestId|identity) belongs to another operation/);
    } else {
      expect((await delegate()).result?.state).toBe("pending");
      expect((await command()).status).toBe(409);
    }
    const lookup = await ask(mailbox, "identity-lookup", "read_operation", {
      requestId: "same-operation",
    });
    expect(lookup.result).toMatchObject(
      commandFirst
        ? { state: "recorded", routine: { id: routine.id, paused: true } }
        : { state: "recorded", delegation: { id: "same-operation", parentRunId: source.runId } },
    );
    expect((await get(`/api/bots/${targetId}/thread`)).tasks).toHaveLength(commandFirst ? 0 : 1);
  },
);

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
  ).toBe(201);
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
  expect(
    (
      await post(`/api/bots/personal/runs/${sent.runId}/retry`, {
        requestId: "retry-waiting-parent",
      })
    ).status,
  ).toBe(409);
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
  ).toBe("A Bot cannot delegate to an ancestor Bot.");
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
      state: "uncertain",
      held: true,
      outcome: { kind: "uncertain", reply: "Owned child outcome is uncertain." },
      stopError: null,
    }),
  );
  await host.reconcile();
  expect(
    (await get("/api/bots/personal/thread")).tasks.find(
      (task: { id: string }) => task.id === uncertain.taskId,
    ).runs[0].state,
  ).toBe("uncertain");
  const unrelated = await (
    await post("/api/bots/personal/thread/tasks", {
      requestId: "after-uncertain-stop",
      text: "Unrelated source work",
    })
  ).json();
  await vi.waitFor(async () =>
    expect(
      (await get("/api/bots/personal/thread")).tasks.find(
        (task: { id: string }) => task.id === unrelated.taskId,
      ).runs[0].state,
    ).toBe("succeeded"),
  );
});

it("cancels owned child work, keeps unrelated target work, and fences a late result", async () => {
  const releaseWriter = Promise.withResolvers<void>();
  const driver = new MailboxDriver();
  let childStopBlocked = true;
  const startExecution = driver.start.bind(driver);
  driver.start = async (material, signal) => {
    const handle = await startExecution(material, signal);
    return {
      ...handle,
      stop: async () => {
        if (material.key.agentGroupId !== "personal" && childStopBlocked)
          throw new Error("Controlled child stop unavailable");
        await handle.stop();
      },
    };
  };
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
  try {
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
      expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].stopError).toBe(
        "Owned child stop is unconfirmed.",
      ),
    );
    for (let pass = 0; pass < 2; pass++) {
      await host.reconcile();
      expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("stopping");
      expect((await get(`/api/bots/${targetId}/thread`)).tasks[0].runs[0].state).toBe("stopping");
    }
    childStopBlocked = false;
    await host.reconcile();
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
  } finally {
    childStopBlocked = false;
    releaseWriter.resolve();
  }
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

it.each(["allow", "ask-each-time"])(
  "records a real SDK delegation under %s and resumes that Run with current Memory",
  async (mode) => {
    const releaseChild = Promise.withResolvers<void>();
    let childRequests = 0;
    const service = await startPiService(
      async (request) => {
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
      },
      { contextWindow: 65536 },
    );
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
            mode,
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
      if (mode === "ask-each-time") {
        const parent = (await get("/api/bots/personal/thread")).tasks[0].runs[0];
        expect(parent.delegations[0]).toMatchObject({
          childRunId: null,
          approval: { state: "pending" },
        });
        expect((await get(`/api/bots/${targetId}/thread`)).tasks).toEqual([]);
        expect(
          (
            await post(`/api/bots/personal/runs/${sent.runId}/approvals/sdk-child/decision`, {
              requestId: "sdk-approve",
              decision: "approve",
              operation: "delegate",
              targetBotId: targetId,
              text: "Summarize only this sentence",
              deadline: null,
            })
          ).status,
        ).toBe(202);
        await host.reconcile();
        await vi.waitFor(async () =>
          expect((await get(`/api/bots/${targetId}/thread`)).tasks).toHaveLength(1),
        );
      }
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
            model: {
              provider: configuration.agent.model.provider,
              id: configuration.agent.model.id,
            },
            tools: ["read", "bash"],
          })
        ).status,
      ).toBe(201);
      const ledger = (await host.inspect(sent.runId)).continuation;
      releaseChild.resolve();
      await vi.waitFor(async () => {
        const run = (await get("/api/bots/personal/thread")).tasks[0].runs[0];
        expect(run.state, JSON.stringify(run.outcome)).toBe("succeeded");
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
          body.includes("Summarize only this sentence") &&
          !body.includes("Delegated work sdk-child")
        );
      });
      expect(
        childRequestsBody.some((request) =>
          JSON.stringify(request).includes("Steer the real child"),
        ),
      ).toBe(true);
      expect(
        childRequestsBody.every(
          (request) => !JSON.stringify(request).includes("Delegate this summary"),
        ),
      ).toBe(true);
      expect(await readFile(join(root, "groups", targetId, "child-note.txt"), "utf8")).toBe(
        "child",
      );
      await expect(readFile(join(root, "groups", "personal", "child-note.txt"))).rejects.toThrow();
    } finally {
      await service.close();
    }
  },
);
