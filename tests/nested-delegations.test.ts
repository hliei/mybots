import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
async function bot(name: string) {
  const created = await (
    await post("/api/bots", {
      requestId: `${name}-bot`,
      name,
      instructions: `Role: ${name}. Work only on selected text.`,
      model: { provider: "deepseek", id: "deepseek-chat" },
      tools: ["read", "bash"],
    })
  ).json();
  return created.bot.id as string;
}

async function allow(source: string, target: string) {
  expect(
    (
      await post(`/api/bots/${source}/collaboration/${target}`, {
        requestId: `allow-${source}-${target}`,
        mode: "allow",
      })
    ).status,
  ).toBe(201);
}
async function run(botId: string, runId: string) {
  const detail = await get(`/api/bots/${botId}/thread`);
  return detail.tasks
    .flatMap((task: { runs: { id: string }[] }) => task.runs)
    .find((row: { id: string }) => row.id === runId);
}
async function mailbox(driver: MailboxDriver, runId: string) {
  await vi.waitFor(() =>
    expect(driver.launches.some((row) => row.material.key.sessionId === runId)).toBe(true),
  );
  return new RunnerMailbox(
    driver.launches.filter((row) => row.material.key.sessionId === runId).at(-1)?.material
      .directory as string,
  );
}
async function wait(mailbox: RunnerMailbox, botId: string, runId: string) {
  mailbox.requestDurableWait("delegation");
  await vi.waitFor(async () => expect((await run(botId, runId)).state).toBe("waiting"), {
    timeout: 5000,
  });
}
async function untilAbort(signal: AbortSignal) {
  if (!signal.aborted)
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
}

it("links two levels, checks every direction and rejects ancestors and a third edge", async () => {
  const driver = new MailboxDriver();
  const entered = new Set<string>();
  const leaf = Promise.withResolvers<void>();
  driver.respond = async (input, material, signal) => {
    if (input.content === "Review selected text") {
      await Promise.race([leaf.promise, untilAbort(signal)]);
      return "Reviewer result";
    }
    if (!entered.has(material.key.sessionId)) {
      entered.add(material.key.sessionId);
      await untilAbort(signal);
    }
    return `Handled: ${input.content}`;
  };
  await start(driver);
  const specialist = await bot("Specialist");
  const reviewer = await bot("Reviewer");
  const fourth = await bot("Fourth");
  await allow("personal", specialist);
  const source = await (
    await post("/api/bots/personal/thread/messages", { requestId: "source", text: "Coordinate" })
  ).json();
  const sourceMailbox = await mailbox(driver, source.runId);
  const child = (
    await ask(sourceMailbox, "specialist", "delegate", {
      requestId: "specialist",
      targetBotId: specialist,
      text: "Specialize selected text",
    })
  ).result;
  await wait(sourceMailbox, "personal", source.runId);
  const childMailbox = await mailbox(driver, child?.childRunId as string);
  expect(
    (
      await ask(childMailbox, "denied-review", "delegate", {
        requestId: "denied-review",
        targetBotId: reviewer,
        text: "Denied review",
      })
    ).result,
  ).toMatchObject({ state: "denied", originatingRunId: source.runId, childTaskId: null });
  await allow(specialist, reviewer);
  const reviewed = await ask(childMailbox, "review", "delegate", {
    requestId: "review",
    targetBotId: reviewer,
    text: "Review selected text",
  });
  expect(reviewed.error).toBeUndefined();
  expect(reviewed.result).toMatchObject({
    sourceBotId: specialist,
    targetBotId: reviewer,
    parentTaskId: child?.childTaskId,
    parentRunId: child?.childRunId,
    originatingRunId: source.runId,
    state: "pending",
  });
  await allow(specialist, "personal");
  expect(
    (
      await ask(childMailbox, "ancestor", "delegate", {
        requestId: "ancestor",
        targetBotId: "personal",
        text: "Loop",
      })
    ).error,
  ).toMatch(/ancestor/);
  await wait(childMailbox, specialist, child?.childRunId as string);
  const reviewMailbox = await mailbox(driver, reviewed.result?.childRunId as string);
  await allow(reviewer, fourth);
  expect(
    (
      await ask(reviewMailbox, "third", "delegate", {
        requestId: "third",
        targetBotId: fourth,
        text: "Too deep",
      })
    ).error,
  ).toMatch(/two delegation edges/);
  await allow(reviewer, specialist);
  expect(
    (
      await ask(reviewMailbox, "loop", "delegate", {
        requestId: "loop",
        targetBotId: specialist,
        text: "Loop",
      })
    ).error,
  ).toMatch(/ancestor/);
  const waiting = await run("personal", source.runId);
  const childWaiting = await run(specialist, child?.childRunId as string);
  now += 30_000;
  await host.reconcile();
  expect((await run("personal", source.runId)).budget.activeMs).toBe(waiting.budget.activeMs);
  expect((await run(specialist, child?.childRunId as string)).budget.activeMs).toBe(
    childWaiting.budget.activeMs,
  );
  expect(
    (await run(reviewer, reviewed.result?.childRunId as string)).budget.activeMs,
  ).toBeGreaterThanOrEqual(30_000);
  leaf.resolve();
  await vi.waitFor(async () =>
    expect((await run("personal", source.runId)).state).toBe("succeeded"),
  );
  const parent = await run("personal", source.runId);
  const middle = await run(specialist, child?.childRunId as string);
  expect(parent.attempts).toHaveLength(2);
  expect(middle.attempts).toHaveLength(2);
  expect(middle.delegations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "review", state: "succeeded", result: "Reviewer result" }),
    ]),
  );
  expect(parent.delegations).toEqual([
    expect.objectContaining({
      id: "specialist",
      state: "succeeded",
      result: "Handled: Specialize selected text",
    }),
  ]);
  expect((await get(`/api/bots/${fourth}/thread`)).tasks).toEqual([]);
});

it("counts all admitted descendants across restart, steering and new Attempts", async () => {
  const driver = new MailboxDriver();
  const leaves = Promise.withResolvers<void>();
  driver.respond = async (input, _material, signal) => {
    if (input.content.startsWith("Leaf ")) {
      await Promise.race([leaves.promise, untilAbort(signal)]);
      return { error: "Reviewer declined" };
    }
    await untilAbort(signal);
    return "unused";
  };
  const configuration = await start(driver);
  const specialist = await bot("Specialist");
  const reviewer = await bot("Reviewer");
  await allow("personal", specialist);
  await allow(specialist, reviewer);
  const source = await (
    await post("/api/bots/personal/thread/messages", {
      requestId: "count-source",
      text: "Coordinate count",
    })
  ).json();
  const sourceMailbox = await mailbox(driver, source.runId);
  const child = (
    await ask(sourceMailbox, "count-child", "delegate", {
      requestId: "count-child",
      targetBotId: specialist,
      text: "Counted specialist",
    })
  ).result;
  await wait(sourceMailbox, "personal", source.runId);
  let childMailbox = await mailbox(driver, child?.childRunId as string);
  for (let i = 1; i <= 6; i++) {
    const id = `leaf-${i}`;
    expect(
      (
        await ask(childMailbox, id, "delegate", {
          requestId: id,
          targetBotId: reviewer,
          text: `Leaf ${i}`,
        })
      ).result,
    ).toMatchObject({ state: "pending", originatingRunId: source.runId });
  }
  await wait(childMailbox, specialist, child?.childRunId as string);
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
  expect((await run(specialist, child?.childRunId as string)).state).toBe("waiting");
  now += 6000;
  await host.reconcile();
  leaves.resolve();
  await vi.waitFor(
    async () => expect((await run(specialist, child?.childRunId as string)).state).toBe("active"),
    { timeout: 8000 },
  );
  childMailbox = await mailbox(driver, child?.childRunId as string);
  expect((await run(specialist, child?.childRunId as string)).attempts).toHaveLength(2);
  const addition = await post(`/api/bots/${specialist}/tasks/${child?.childTaskId}/inputs`, {
    requestId: "count-steer",
    text: "Keep the existing count",
  });
  expect((await addition.json()).runId).toBe(child?.childRunId);
  const eighth = await ask(childMailbox, "eighth", "delegate", {
    requestId: "eighth",
    targetBotId: reviewer,
    text: "Leaf eight",
  });
  expect(eighth.result).toMatchObject({ state: "pending", originatingRunId: source.runId });
  expect(
    (
      await ask(childMailbox, "ninth", "delegate", {
        requestId: "ninth",
        targetBotId: reviewer,
        text: "Leaf nine",
      })
    ).error,
  ).toMatch(/eight total delegations/);
  await wait(childMailbox, specialist, child?.childRunId as string);
  await vi.waitFor(async () =>
    expect((await run(specialist, child?.childRunId as string)).state).toBe("active"),
  );
  childMailbox = await mailbox(driver, child?.childRunId as string);
  expect(
    (
      await ask(childMailbox, "still-ninth", "delegate", {
        requestId: "still-ninth",
        targetBotId: reviewer,
        text: "Leaf nine after replacement",
      })
    ).error,
  ).toMatch(/eight total delegations/);
  const detail = await get(`/api/bots/${reviewer}/thread`);
  expect(detail.tasks).toHaveLength(7);
  expect(
    detail.tasks.every((task: { runs: { state: string }[] }) => task.runs[0]?.state === "failed"),
  ).toBe(true);
  expect((await run("personal", source.runId)).state).toBe("waiting");
});

async function nested(driver: MailboxDriver, questionText?: string) {
  await start(driver);
  const specialist = await bot("Specialist");
  const reviewer = await bot("Reviewer");
  await allow("personal", specialist);
  await allow(specialist, reviewer);
  const source = await (
    await post("/api/bots/personal/thread/messages", { requestId: "nested-source", text: "Root" })
  ).json();
  const sourceMailbox = await mailbox(driver, source.runId);
  const middle = (
    await ask(sourceMailbox, "nested-middle", "delegate", {
      requestId: "nested-middle",
      targetBotId: specialist,
      text: "Middle",
    })
  ).result;
  await wait(sourceMailbox, "personal", source.runId);
  const middleMailbox = await mailbox(driver, middle?.childRunId as string);
  const leaf = (
    await ask(middleMailbox, "nested-leaf", "delegate", {
      requestId: "nested-leaf",
      targetBotId: reviewer,
      text: "Leaf",
    })
  ).result;
  if (questionText)
    expect(
      (
        await ask(middleMailbox, "nested-question", "ask_question", {
          requestId: "nested-question",
          text: questionText,
        })
      ).result,
    ).toMatchObject({ state: "pending" });
  await wait(middleMailbox, specialist, middle?.childRunId as string);
  const leafMailbox = await mailbox(driver, leaf?.childRunId as string);
  return { source, sourceMailbox, middle, middleMailbox, leaf, leafMailbox, specialist, reviewer };
}

it.each(["close", "retry"])(
  "holds every ancestor for uncertain leaf work until owner %s",
  async (decision) => {
    const driver = new MailboxDriver();
    const entered = new Set<string>();
    const releaseRetry = Promise.withResolvers<void>();
    let leafCalls = 0;
    driver.respond = async (input, material, signal) => {
      if (input.content === "Leaf") {
        leafCalls++;
        if (leafCalls === 1) {
          new RunnerMailbox(material.directory).acknowledge(input.id, "failed");
          await untilAbort(signal);
        } else await Promise.race([releaseRetry.promise, untilAbort(signal)]);
        return "Leaf resolved";
      }
      if (input.content === "Unrelated") return "Unrelated completed";
      if (!entered.has(material.key.sessionId)) {
        entered.add(material.key.sessionId);
        await untilAbort(signal);
      }
      return `Handled: ${input.content}`;
    };
    const chain = await nested(driver);
    now += 20_000;
    expect(
      (
        await post(`/api/bots/${chain.reviewer}/runs/${chain.leaf?.childRunId}/stop`, {
          requestId: "leaf-stop",
        })
      ).status,
    ).toBe(202);
    await vi.waitFor(async () =>
      expect((await run(chain.reviewer, chain.leaf?.childRunId as string)).state).toBe("uncertain"),
    );
    await vi.waitFor(async () =>
      expect(await run("personal", chain.source.runId)).toMatchObject({
        state: "waiting",
        held: true,
        outcome: null,
      }),
    );
    expect(await run(chain.specialist, chain.middle?.childRunId as string)).toMatchObject({
      state: "waiting",
      held: true,
      outcome: null,
    });
    const unrelated = await (
      await post(`/api/bots/${chain.reviewer}/thread/tasks`, {
        requestId: "unrelated-leaf",
        text: "Unrelated",
      })
    ).json();
    await vi.waitFor(async () =>
      expect((await run(chain.reviewer, unrelated.runId)).state).toBe("succeeded"),
    );
    const before = await run(chain.reviewer, chain.leaf?.childRunId as string);
    const resolved = await post(
      `/api/bots/${chain.reviewer}/runs/${chain.leaf?.childRunId}/${decision}`,
      { requestId: `leaf-${decision}` },
    );
    expect(resolved.status).toBe(202);
    if (decision === "retry") {
      const retried = await resolved.json();
      expect(retried).toMatchObject({
        taskId: chain.leaf?.childTaskId,
        priorRunId: chain.leaf?.childRunId,
      });
      expect(retried.runId).not.toBe(chain.leaf?.childRunId);
      const retryMailbox = await mailbox(driver, retried.runId);
      const current = await run(chain.reviewer, retried.runId);
      expect(current.budget.activeMs).toBe(0);
      expect(before.budget.activeMs).toBeGreaterThanOrEqual(20_000);
      expect((await run(chain.reviewer, chain.leaf?.childRunId as string)).outcome).toEqual(
        before.outcome,
      );
      await allow(chain.reviewer, chain.specialist);
      expect(
        (
          await ask(retryMailbox, "retry-ancestor", "delegate", {
            requestId: "retry-ancestor",
            targetBotId: chain.specialist,
            text: "Do not escape chain",
          })
        ).error,
      ).toMatch(/ancestor/);
      expect((await run("personal", chain.source.runId)).state).toBe("waiting");
      releaseRetry.resolve();
    }
    await vi.waitFor(async () =>
      expect((await run("personal", chain.source.runId)).state).toBe("succeeded"),
    );
    const parent = await run("personal", chain.source.runId);
    expect(parent.held).toBe(false);
    expect(parent.attempts).toHaveLength(2);
    const middle = await run(chain.specialist, chain.middle?.childRunId as string);
    expect(middle.delegations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "nested-leaf",
          originatingRunId: chain.source.runId,
          state: decision === "retry" ? "succeeded" : "cancelled",
        }),
      ]),
    );
  },
);

it("confirms descendant cancellation before settling ancestors and never revives them", async () => {
  const driver = new MailboxDriver();
  driver.respond = async (input, _material, signal) => {
    if (input.content === "Unrelated") return "Unrelated completed";
    await untilAbort(signal);
    return "unused";
  };
  let blocked = true;
  const originalStart = driver.start.bind(driver);
  driver.start = async (material, signal) => {
    const handle = await originalStart(material, signal);
    return {
      ...handle,
      stop: async () => {
        if (
          blocked &&
          material.key.agentGroupId !== "personal" &&
          material.key.agentGroupId !== specialistId
        )
          throw new Error("Leaf stop unconfirmed");
        await handle.stop();
      },
    };
  };
  let specialistId = "";
  // The middle's durable wait also stops its executor before the reviewer exists.
  // Only refuse termination once the complete chain has entered its wait.
  blocked = false;
  const chain = await nested(driver);
  specialistId = chain.specialist;
  blocked = true;
  try {
    const unrelated = await (
      await post(`/api/bots/${chain.reviewer}/thread/tasks`, {
        requestId: "cancel-unrelated",
        text: "Unrelated",
      })
    ).json();
    expect(
      (await post(`/api/bots/personal/runs/${chain.source.runId}/stop`, { requestId: "root-stop" }))
        .status,
    ).toBe(202);
    await vi.waitFor(async () =>
      expect((await run("personal", chain.source.runId)).stopError).toMatch(
        /child stop is unconfirmed/,
      ),
    );
    await host.reconcile();
    expect((await run("personal", chain.source.runId)).state).toBe("stopping");
    expect((await run(chain.specialist, chain.middle?.childRunId as string)).state).toBe(
      "stopping",
    );
    expect((await run(chain.reviewer, unrelated.runId)).state).toBe("queued");
    blocked = false;
    await host.reconcile();
    await vi.waitFor(async () =>
      expect((await run("personal", chain.source.runId)).state).toBe("closed"),
    );
    expect((await run(chain.specialist, chain.middle?.childRunId as string)).state).toBe("closed");
    expect((await run(chain.reviewer, chain.leaf?.childRunId as string)).state).toBe("closed");
    await vi.waitFor(async () =>
      expect((await run(chain.reviewer, unrelated.runId)).state).toBe("succeeded"),
    );
    const leafInput = (await host.inspect(chain.leaf?.childRunId as string)).inputs[0];
    if (!leafInput) throw new Error("Reviewer input is missing");
    chain.leafMailbox.reply(leafInput, "Late reviewer evidence", "message");
    await host.reconcile();
    expect((await run(chain.reviewer, chain.leaf?.childRunId as string)).lateEvidence).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "Late reviewer evidence" })]),
    );
    expect((await run("personal", chain.source.runId)).state).toBe("closed");
    expect((await run(chain.specialist, chain.middle?.childRunId as string)).attempts).toHaveLength(
      1,
    );
    expect(
      (
        await post(`/api/bots/${chain.specialist}/runs/${chain.middle?.childRunId}/retry`, {
          requestId: "revive-cancelled-chain",
        })
      ).status,
    ).toBe(409);
  } finally {
    blocked = false;
  }
});

it("keeps failed child retries in the originating chain and waits for necessary decisions", async () => {
  const driver = new MailboxDriver();
  const entered = new Set<string>();
  const fail = Promise.withResolvers<void>();
  const failRetry = Promise.withResolvers<void>();
  let leafCalls = 0;
  driver.respond = async (input, material, signal) => {
    if (input.content === "Leaf") {
      leafCalls++;
      if (leafCalls === 1) {
        await Promise.race([fail.promise, untilAbort(signal)]);
        return { error: "Review failed" };
      }
      if (leafCalls === 2) {
        await Promise.race([failRetry.promise, untilAbort(signal)]);
        return { error: "Retried review failed" };
      }
      await untilAbort(signal);
      return "unused";
    }
    if (!entered.has(material.key.sessionId)) {
      entered.add(material.key.sessionId);
      await untilAbort(signal);
    }
    return "Parent handled failure";
  };
  const chain = await nested(driver, "How should I handle a failed review?");
  now += 10_000;
  fail.resolve();
  await vi.waitFor(async () =>
    expect((await run(chain.reviewer, chain.leaf?.childRunId as string)).state).toBe("failed"),
  );
  const before = await run(chain.reviewer, chain.leaf?.childRunId as string);
  expect((await run(chain.specialist, chain.middle?.childRunId as string)).state).toBe("waiting");
  const response = await post(`/api/bots/${chain.reviewer}/runs/${chain.leaf?.childRunId}/retry`, {
    requestId: "failed-leaf-retry",
  });
  expect(response.status).toBe(202);
  const retried = await response.json();
  const retryMailbox = await mailbox(driver, retried.runId);
  await allow(chain.reviewer, "personal");
  expect(
    (
      await ask(retryMailbox, "failed-retry-ancestor", "delegate", {
        requestId: "failed-retry-ancestor",
        targetBotId: "personal",
        text: "Cannot escape through retry",
      })
    ).error,
  ).toMatch(/ancestor/);
  expect((await run(chain.reviewer, chain.leaf?.childRunId as string)).outcome).toEqual(
    before.outcome,
  );
  expect((await run(chain.reviewer, retried.runId)).budget.activeMs).toBe(0);
  const oldRun = await run(chain.reviewer, chain.leaf?.childRunId as string);
  expect(oldRun.delegations).toEqual([
    expect.objectContaining({ id: "nested-leaf", originatingRunId: chain.source.runId }),
  ]);
  failRetry.resolve();
  await vi.waitFor(async () =>
    expect((await run(chain.reviewer, retried.runId)).state).toBe("failed"),
  );
  const retryOutcome = (await run(chain.reviewer, retried.runId)).outcome;
  const fromOlder = await post(`/api/bots/${chain.reviewer}/runs/${chain.leaf?.childRunId}/retry`, {
    requestId: "retry-from-older-run",
  });
  expect(fromOlder.status).toBe(202);
  const latest = await fromOlder.json();
  await mailbox(driver, latest.runId);
  expect((await run(chain.specialist, chain.middle?.childRunId as string)).delegations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "nested-leaf",
        childRunId: latest.runId,
        state: "pending",
        originatingRunId: chain.source.runId,
      }),
    ]),
  );
  expect((await run(chain.reviewer, retried.runId)).outcome).toEqual(retryOutcome);
  expect(
    (
      await post(
        `/api/bots/${chain.specialist}/runs/${chain.middle?.childRunId}/questions/nested-question/answer`,
        { requestId: "answer-review", text: "Use the evidence and explain the failure" },
      )
    ).status,
  ).toBe(202);
  expect((await run(chain.specialist, chain.middle?.childRunId as string)).state).toBe("waiting");
  expect((await run("personal", chain.source.runId)).state).toBe("waiting");
  expect(
    (
      await post(`/api/bots/${chain.reviewer}/runs/${latest.runId}/stop`, {
        requestId: "cancel-latest-retry",
      })
    ).status,
  ).toBe(202);
  await vi.waitFor(async () =>
    expect((await run(chain.reviewer, latest.runId)).state).toBe("closed"),
  );
  await vi.waitFor(async () =>
    expect((await run("personal", chain.source.runId)).state).toBe("succeeded"),
  );
  expect((await run(chain.specialist, chain.middle?.childRunId as string)).delegations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "nested-leaf", childRunId: latest.runId, state: "cancelled" }),
    ]),
  );
});

it("records two real SDK delegations and reopens both parent ledgers without replay", async () => {
  const release = Promise.withResolvers<void>();
  let specialist = "";
  let reviewer = "";
  let reviewRequests = 0;
  const service = await startPiService(
    async (request) => {
      const body = JSON.stringify(request);
      if (body.includes("Role: Reviewer.")) {
        reviewRequests++;
        if (reviewRequests === 1) {
          await release.promise;
          return { tool: "bash", arguments: { command: "printf reviewed > review.txt" } };
        }
        return { text: "Reviewed selected evidence" };
      }
      if (body.includes("Role: Specialist.")) {
        if (!body.includes("Delegated work sdk-review"))
          return {
            tool: "delegate",
            arguments: {
              requestId: "sdk-review",
              targetBotId: reviewer,
              text: "Review only the selected evidence",
            },
          };
        return { text: "Specialist handled reviewer evidence" };
      }
      if (!body.includes("Delegated work sdk-specialist"))
        return {
          tool: "delegate",
          arguments: {
            requestId: "sdk-specialist",
            targetBotId: specialist,
            text: "Specialize only the selected evidence",
          },
        };
      return { text: "Root handled specialist evidence" };
    },
    { contextWindow: 65536 },
  );
  try {
    await start(
      piRunDriver(new PiProvider({ modelRuntime: service.runtime, model: service.model })),
    );
    specialist = await bot("Specialist");
    reviewer = await bot("Reviewer");
    await allow("personal", specialist);
    await allow(specialist, reviewer);
    const source = await (
      await post("/api/bots/personal/thread/messages", {
        requestId: "sdk-root",
        text: "Coordinate a specialist and reviewer",
      })
    ).json();
    await vi.waitFor(async () =>
      expect((await run("personal", source.runId)).state).toBe("waiting"),
    );
    await vi.waitFor(async () =>
      expect((await get(`/api/bots/${specialist}/thread`)).tasks[0]?.runs[0].state).toBe("waiting"),
    );
    const middle = (await get(`/api/bots/${specialist}/thread`)).tasks[0];
    const leaf = (await get(`/api/bots/${reviewer}/thread`)).tasks[0];
    expect(middle.runs[0].delegations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "sdk-review",
          originatingRunId: source.runId,
          parentRunId: middle.runs[0].id,
          childRunId: leaf.runs[0].id,
        }),
      ]),
    );
    const rootLedger = (await host.inspect(source.runId)).continuation;
    const middleLedger = (await host.inspect(middle.runs[0].id)).continuation;
    expect(rootLedger).not.toBe(middleLedger);
    await service.waitForRequest(3);
    expect(
      (
        await post(`/api/bots/${reviewer}/tasks/${leaf.id}/inputs`, {
          requestId: "sdk-reviewer-note",
          text: "Owner correction for reviewer only",
        })
      ).status,
    ).toBe(202);
    release.resolve();
    await vi.waitFor(async () =>
      expect((await run("personal", source.runId)).state).toBe("succeeded"),
    );
    expect((await host.inspect(source.runId)).continuation).toBe(rootLedger);
    expect((await host.inspect(middle.runs[0].id)).continuation).toBe(middleLedger);
    for (const [botId, runId] of [
      ["personal", source.runId],
      [specialist, middle.runs[0].id],
    ] as [string, string][]) {
      expect((await run(botId, runId)).attempts).toHaveLength(2);
      const records: { kind: string; toolName?: string; toolCallId?: string }[] = [];
      let after = "";
      do {
        const page = await get(
          `/api/bots/${botId}/runs/${runId}/history?kind=records${after ? `&after=${encodeURIComponent(after)}` : ""}`,
        );
        records.push(...page.records);
        after = page.nextAfter ?? "";
      } while (after);
      expect(
        records.filter((record) => record.kind === "tool-call" && record.toolName === "delegate"),
      ).toHaveLength(1);
      expect(
        records
          .filter((record) => record.kind === "tool-result")
          .map((record) => record.toolCallId)
          .sort(),
      ).toEqual(
        records
          .filter((record) => record.kind === "tool-call")
          .map((record) => record.toolCallId)
          .sort(),
      );
    }
    expect(
      service.requests.some((request) =>
        JSON.stringify(request).includes("Owner correction for reviewer only"),
      ),
    ).toBe(true);
    expect(await readFile(join(root, "groups", reviewer, "review.txt"), "utf8")).toBe("reviewed");
    await expect(readFile(join(root, "groups", specialist, "review.txt"))).rejects.toThrow();
    await expect(readFile(join(root, "groups", "personal", "review.txt"))).rejects.toThrow();
  } finally {
    release.resolve();
    await channel?.close();
    await host?.stop();
    await service.close();
  }
}, 20000);

it("rejects new nested work as soon as an ancestor starts stopping", async () => {
  const driver = new MailboxDriver();
  driver.respond = async (_input, _material, signal) => {
    await untilAbort(signal);
    return "unused";
  };
  const originalStart = driver.start.bind(driver);
  let blocked = true;
  driver.start = async (material, signal) => {
    const handle = await originalStart(material, signal);
    return {
      ...handle,
      stop: async () => {
        if (blocked && material.key.agentGroupId === "personal")
          throw new Error("Root stop unconfirmed");
        await handle.stop();
      },
    };
  };
  try {
    await start(driver);
    const specialist = await bot("Specialist");
    const reviewer = await bot("Reviewer");
    await allow("personal", specialist);
    await allow(specialist, reviewer);
    const source = await (
      await post("/api/bots/personal/thread/messages", {
        requestId: "stopping-source",
        text: "Root",
      })
    ).json();
    const sourceMailbox = await mailbox(driver, source.runId);
    const child = (
      await ask(sourceMailbox, "stopping-middle", "delegate", {
        requestId: "stopping-middle",
        targetBotId: specialist,
        text: "Middle",
      })
    ).result;
    const childMailbox = await mailbox(driver, child?.childRunId as string);
    expect(
      (await post(`/api/bots/personal/runs/${source.runId}/stop`, { requestId: "stop-live-root" }))
        .status,
    ).toBe(202);
    await vi.waitFor(async () =>
      expect((await run("personal", source.runId)).state).toBe("stopping"),
    );
    expect(
      (
        await ask(childMailbox, "late-grandchild", "delegate", {
          requestId: "late-grandchild",
          targetBotId: reviewer,
          text: "Too late",
        })
      ).error,
    ).toMatch(/owning parent/);
    expect((await get(`/api/bots/${reviewer}/thread`)).tasks).toEqual([]);
  } finally {
    blocked = false;
  }
});

it("rejects retrying an older child Run after a later Run has succeeded", async () => {
  const driver = new MailboxDriver();
  const fail = Promise.withResolvers<void>();
  const entered = new Set<string>();
  let leafCalls = 0;
  driver.respond = async (input, material, signal) => {
    if (input.content === "Leaf") {
      if (++leafCalls === 1) {
        await Promise.race([fail.promise, untilAbort(signal)]);
        return { error: "Original review failed" };
      }
      return "Retried review succeeded";
    }
    if (!entered.has(material.key.sessionId)) {
      entered.add(material.key.sessionId);
      await untilAbort(signal);
    }
    return "Parent handled the review";
  };
  const chain = await nested(driver, "Which review should I use?");
  fail.resolve();
  await vi.waitFor(async () =>
    expect((await run(chain.reviewer, chain.leaf?.childRunId as string)).state).toBe("failed"),
  );
  const retry = await post(`/api/bots/${chain.reviewer}/runs/${chain.leaf?.childRunId}/retry`, {
    requestId: "successful-child-retry",
  });
  expect(retry.status).toBe(202);
  const retried = await retry.json();
  await vi.waitFor(async () =>
    expect((await run(chain.reviewer, retried.runId)).state).toBe("succeeded"),
  );
  expect((await run(chain.specialist, chain.middle?.childRunId as string)).state).toBe("waiting");
  const stale = await post(`/api/bots/${chain.reviewer}/runs/${chain.leaf?.childRunId}/retry`, {
    requestId: "stale-successful-retry",
  });
  expect(stale.status).toBe(409);
  const task = (await get(`/api/bots/${chain.reviewer}/thread`)).tasks.find(
    (task: { id: string }) => task.id === chain.leaf?.childTaskId,
  );
  expect(task.runs).toHaveLength(2);
  expect(
    (
      await post(
        `/api/bots/${chain.specialist}/runs/${chain.middle?.childRunId}/questions/nested-question/answer`,
        { requestId: "answer-successful-review", text: "Use the successful retry" },
      )
    ).status,
  ).toBe(202);
  await vi.waitFor(async () =>
    expect((await run("personal", chain.source.runId)).state).toBe("succeeded"),
  );
});

it("rechecks the shared chain limit when nested approvals execute", async () => {
  const driver = new MailboxDriver();
  driver.respond = async (input, _material, signal) => {
    if (input.content.startsWith("Approved leaf")) return "Reviewed";
    await untilAbort(signal);
    return "unused";
  };
  await start(driver);
  const specialist = await bot("Specialist");
  const reviewer = await bot("Reviewer");
  await allow("personal", specialist);
  expect(
    (
      await post(`/api/bots/${specialist}/collaboration/${reviewer}`, {
        requestId: "ask-reviewer",
        mode: "ask-each-time",
      })
    ).status,
  ).toBe(201);
  const source = await (
    await post("/api/bots/personal/thread/messages", {
      requestId: "approval-chain-root",
      text: "Coordinate approvals",
    })
  ).json();
  const sourceMailbox = await mailbox(driver, source.runId);
  const middle = (
    await ask(sourceMailbox, "approval-specialist", "delegate", {
      requestId: "approval-specialist",
      targetBotId: specialist,
      text: "Specialist approvals",
    })
  ).result;
  await wait(sourceMailbox, "personal", source.runId);
  const middleMailbox = await mailbox(driver, middle?.childRunId as string);
  for (let index = 1; index <= 8; index++) {
    const requestId = `approved-leaf-${index}`;
    expect(
      (
        await ask(middleMailbox, requestId, "delegate", {
          requestId,
          targetBotId: reviewer,
          text: `Approved leaf ${index}`,
        })
      ).result,
    ).toMatchObject({
      childTaskId: null,
      originatingRunId: source.runId,
      approval: { state: "pending" },
    });
  }
  await wait(middleMailbox, specialist, middle?.childRunId as string);
  for (let index = 1; index <= 8; index++) {
    expect(
      (
        await post(
          `/api/bots/${specialist}/runs/${middle?.childRunId}/approvals/approved-leaf-${index}/decision`,
          {
            requestId: `approve-leaf-${index}`,
            decision: "approve",
            operation: "delegate",
            targetBotId: reviewer,
            text: `Approved leaf ${index}`,
            deadline: null,
          },
        )
      ).status,
    ).toBe(202);
  }
  await vi.waitFor(async () => {
    const current = await run(specialist, middle?.childRunId as string);
    expect(
      current.delegations.find((row: { id: string }) => row.id === "approved-leaf-8"),
    ).toMatchObject({
      childTaskId: null,
      childRunId: null,
      state: "denied",
      approval: { state: "stale" },
    });
    expect(
      current.delegations.find((row: { id: string }) => row.id === "approved-leaf-8").result,
    ).toMatch(/eight total delegations/);
  });
  expect((await get(`/api/bots/${reviewer}/thread`)).tasks).toHaveLength(7);
}, 15000);

it("revokes an edge with nested work and a pending approval without cancelling its source", async () => {
  const driver = new MailboxDriver();
  driver.respond = async (input, _material, signal) => {
    if (input.content === "Unrelated") return "Independent result";
    await untilAbort(signal);
    return "unused";
  };
  const chain = await nested(driver, "A decision owned by the cancelled child");
  await allow(chain.specialist, "personal");
  await writeFile(
    join(root, "groups", chain.reviewer, "report.txt"),
    "Delivered before revocation",
  );
  const published = await ask(chain.leafMailbox, "pre-revoke-report", "publish_result", {
    requestId: "pre-revoke-report",
    text: "Delivered evidence",
    files: ["report.txt"],
  });
  expect(published.error).toBeUndefined();
  const artifactId = (published.result?.artifacts as { id: string }[] | undefined)?.[0]?.id;
  // A second source Attempt can propose an exact approval while the child is running.
  const source = await (
    await post("/api/bots/personal/thread/tasks", { requestId: "approval-source", text: "Approve" })
  ).json();
  const sourceMailbox = await mailbox(driver, source.runId);
  expect(
    (
      await post(`/api/bots/personal/collaboration/${chain.specialist}`, {
        requestId: "ask-specialist",
        mode: "ask-each-time",
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await ask(sourceMailbox, "pending-revoked", "delegate", {
        requestId: "pending-revoked",
        targetBotId: chain.specialist,
        text: "Pending exact text",
      })
    ).result,
  ).toMatchObject({ approval: { state: "pending" } });
  // allow -> ask must leave existing work alone.
  expect((await run(chain.reviewer, chain.leaf?.childRunId as string)).state).toBe("active");
  const queued = await (
    await post(`/api/bots/${chain.reviewer}/thread/tasks`, {
      requestId: "unrelated-target",
      text: "Unrelated",
    })
  ).json();
  const response = await post(`/api/bots/personal/collaboration/${chain.specialist}`, {
    requestId: "revoke-specialist",
    mode: "deny",
  });
  expect(response.status).toBe(201);
  await vi.waitFor(async () =>
    expect((await run(chain.specialist, chain.middle?.childRunId as string)).state).toBe("closed"),
  );
  await vi.waitFor(async () =>
    expect((await run(chain.reviewer, queued.runId)).state).toBe("succeeded"),
  );
  expect((await run(chain.reviewer, chain.leaf?.childRunId as string)).state).toBe("closed");
  expect((await run(chain.specialist, chain.middle?.childRunId as string)).questions).toEqual([
    expect.objectContaining({ state: "cancelled" }),
  ]);
  expect((await run("personal", chain.source.runId)).delegations).toContainEqual(
    expect.objectContaining({
      id: "nested-middle",
      state: "cancelled",
      revokedAt: expect.any(String),
      result: expect.stringMatching(/revoked/i),
    }),
  );
  expect((await run("personal", source.runId)).delegations).toContainEqual(
    expect.objectContaining({
      id: "pending-revoked",
      childRunId: null,
      approval: expect.objectContaining({ state: "stale" }),
    }),
  );
  expect(
    (
      await post(`/api/bots/personal/runs/${source.runId}/approvals/pending-revoked/decision`, {
        requestId: "too-late",
        decision: "approve",
        operation: "delegate",
        targetBotId: chain.specialist,
        text: "Pending exact text",
        deadline: null,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await ask(sourceMailbox, "new-denied", "delegate", {
        requestId: "new-denied",
        targetBotId: chain.specialist,
        text: "New forbidden request",
      })
    ).result,
  ).toMatchObject({ state: "denied", childRunId: null });
  expect((await run("personal", chain.source.runId)).state).not.toBe("closed");
  const artifact = await fetch(
    `${base}/api/bots/${chain.reviewer}/runs/${chain.leaf?.childRunId}/artifacts/${artifactId}`,
    { headers },
  );
  expect(artifact.status).toBe(200);
  expect(await artifact.text()).toBe("Delivered before revocation");
  expect((await get(`/api/bots/${chain.specialist}/thread`)).collaboration).toContainEqual(
    expect.objectContaining({ targetBotId: "personal", mode: "allow" }),
  );
  // Restoring permission cannot revive the cancelled child through retry.
  expect(
    (
      await post(`/api/bots/personal/collaboration/${chain.specialist}`, {
        requestId: "restore-specialist",
        mode: "allow",
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await post(`/api/bots/personal/collaboration/${chain.specialist}`, {
        requestId: "revoke-specialist",
        mode: "deny",
      })
    ).status,
  ).toBe(200);
  expect((await get("/api/bots/personal/thread")).collaboration).toContainEqual(
    expect.objectContaining({ targetBotId: chain.specialist, mode: "allow" }),
  );
  expect(
    (
      await post(`/api/bots/${chain.specialist}/runs/${chain.middle?.childRunId}/retry`, {
        requestId: "retry-revoked",
      })
    ).status,
  ).toBe(409);
});

it("retains revoked stop capacity, recovers cancellation after restart and preserves uncertainty and late evidence", async () => {
  const driver = new MailboxDriver();
  driver.respond = async (input, _material, signal) => {
    if (input.content === "Unrelated") return "Independent completed";
    await untilAbort(signal);
    return "unused";
  };
  let blocked = false;
  let reviewer = "";
  const originalStart = driver.start.bind(driver);
  driver.start = async (material, signal) => {
    const handle = await originalStart(material, signal);
    return {
      ...handle,
      stop: async () => {
        if (blocked && material.key.agentGroupId === reviewer) throw new Error("Stop failed");
        await handle.stop();
      },
    };
  };
  const chain = await nested(driver);
  reviewer = chain.reviewer;
  blocked = true;
  try {
    // A final acknowledgement without result makes the confirmed outcome uncertain.
    const input = (await host.inspect(chain.leaf?.childRunId as string)).inputs[0];
    if (!input) throw new Error("Missing leaf input");
    chain.leafMailbox.acknowledge(input.id, "completed");
    const queued = await (
      await post(`/api/bots/${reviewer}/thread/tasks`, {
        requestId: "queued-on-revoked-target",
        text: "Unrelated",
      })
    ).json();
    expect(
      (
        await post(`/api/bots/personal/collaboration/${chain.specialist}`, {
          requestId: "revoke-before-restart",
          mode: "deny",
        })
      ).status,
    ).toBe(201);
    await vi.waitFor(async () =>
      expect((await run(reviewer, chain.leaf?.childRunId as string)).stopError).toMatch(
        /unconfirmed/,
      ),
    );
    expect((await run(chain.specialist, chain.middle?.childRunId as string)).state).toBe(
      "stopping",
    );
    expect((await run(reviewer, queued.runId)).state).toBe("queued");
    const parallel = await (
      await post("/api/bots/personal/thread/tasks", {
        requestId: "parallel-source",
        text: "Unrelated",
      })
    ).json();
    await vi.waitFor(async () =>
      expect((await run("personal", parallel.runId)).state).toBe("succeeded"),
    );
    expect(
      (
        await post(`/api/bots/personal/collaboration/${chain.specialist}`, {
          requestId: "allow-before-restart",
          mode: "allow",
        })
      ).status,
    ).toBe(201);
    await channel.close();
    blocked = false;
    await host.stop();
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
    await vi.waitFor(async () =>
      expect((await run(reviewer, queued.runId)).state).toBe("succeeded"),
    );
    expect((await run(reviewer, chain.leaf?.childRunId as string)).state).toBe("uncertain");
    expect((await run(chain.specialist, chain.middle?.childRunId as string)).state).toBe(
      "uncertain",
    );
    const source = await run("personal", chain.source.runId);
    expect(source).toMatchObject({ state: "waiting", held: true });
    expect(source.delegations).toContainEqual(
      expect.objectContaining({
        id: "nested-middle",
        state: "uncertain",
        revokedAt: expect.any(String),
        result: expect.stringMatching(/revoked/i),
      }),
    );
    chain.leafMailbox.reply(input, "Late revoked child result", "message");
    await host.reconcile();
    expect((await run(reviewer, chain.leaf?.childRunId as string)).lateEvidence).toContainEqual(
      expect.objectContaining({ text: "Late revoked child result" }),
    );
    expect((await run("personal", chain.source.runId)).attempts).toHaveLength(1);
    expect((await get("/api/bots/personal/thread")).tasks).toHaveLength(2);
    expect(
      (
        await post(`/api/bots/${reviewer}/runs/${chain.leaf?.childRunId}/retry`, {
          requestId: "revived-through-descendant",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await post(`/api/bots/${chain.specialist}/runs/${chain.middle?.childRunId}/retry`, {
          requestId: "revived-after-allow",
        })
      ).status,
    ).toBe(409);
  } finally {
    blocked = false;
  }
});

it("returns revocation through the real SDK on the same source Run without replaying delegation", async () => {
  const childStarted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let target = "";
  const service = await startPiService(
    async (request) => {
      const body = JSON.stringify(request);
      if (body.includes("Role: Specialist.")) {
        childStarted.resolve();
        await release.promise;
        return { text: "Late specialist response" };
      }
      if (!body.includes("Delegated work sdk-revoked"))
        return {
          tool: "delegate",
          arguments: { requestId: "sdk-revoked", targetBotId: target, text: "Selected work" },
        };
      expect(body).toMatch(/revoked/i);
      return { text: "Permission revoked; work stopped" };
    },
    { contextWindow: 65536 },
  );
  try {
    await start(
      piRunDriver(new PiProvider({ modelRuntime: service.runtime, model: service.model })),
    );
    target = await bot("Specialist");
    await allow("personal", target);
    const source = await (
      await post("/api/bots/personal/thread/messages", {
        requestId: "sdk-revoke-source",
        text: "Delegate selected work",
      })
    ).json();
    await childStarted.promise;
    await vi.waitFor(async () =>
      expect((await run("personal", source.runId)).state).toBe("waiting"),
    );
    const ledger = (await host.inspect(source.runId)).continuation;
    expect(
      (
        await post(`/api/bots/personal/collaboration/${target}`, {
          requestId: "sdk-revoke-permission",
          mode: "deny",
        })
      ).status,
    ).toBe(201);
    await vi.waitFor(
      async () => expect((await run("personal", source.runId)).state).toBe("succeeded"),
      { timeout: 5000 },
    );
    const parent = await run("personal", source.runId);
    expect(parent.attempts).toHaveLength(2);
    expect(parent.delegations).toContainEqual(
      expect.objectContaining({ state: "cancelled", result: expect.stringMatching(/revoked/i) }),
    );
    expect((await host.inspect(source.runId)).continuation).toBe(ledger);
    const history = await get(`/api/bots/personal/runs/${source.runId}/history?kind=records`);
    expect(
      history.records.filter(
        (r: { kind: string; toolName: string }) =>
          r.kind === "tool-call" && r.toolName === "delegate",
      ),
    ).toHaveLength(1);
    expect(history.records.filter((r: { kind: string }) => r.kind === "tool-result")).toHaveLength(
      1,
    );
    expect((await get(`/api/bots/${target}/thread`)).tasks).toHaveLength(1);
  } finally {
    release.resolve();
    await channel?.close();
    await host?.stop();
    await service.close();
  }
}, 15000);

it("blocks a new retry of previously failed child work while its direction is denied", async () => {
  const driver = new MailboxDriver();
  driver.respond = async (input, _material, signal) => {
    if (input.content === "Failed child") return { error: "Child failed before revocation" };
    await untilAbort(signal);
    return "unused";
  };
  await start(driver);
  const target = await bot("Specialist");
  await allow("personal", target);
  const source = await (
    await post("/api/bots/personal/thread/tasks", {
      requestId: "retry-policy-source",
      text: "Hold source",
    })
  ).json();
  const sourceMailbox = await mailbox(driver, source.runId);
  const child = (
    await ask(sourceMailbox, "failed-before-revoke", "delegate", {
      requestId: "failed-before-revoke",
      targetBotId: target,
      text: "Failed child",
    })
  ).result;
  await vi.waitFor(async () =>
    expect((await run(target, child?.childRunId as string)).state).toBe("failed"),
  );
  expect(
    (
      await post(`/api/bots/personal/collaboration/${target}`, {
        requestId: "deny-retry-direction",
        mode: "deny",
      })
    ).status,
  ).toBe(201);
  expect((await run(target, child?.childRunId as string)).outcome).toMatchObject({
    kind: "failed",
    reply: "Child failed before revocation",
  });
  expect(
    (
      await post(`/api/bots/${target}/runs/${child?.childRunId}/retry`, {
        requestId: "retry-after-revocation",
      })
    ).status,
  ).toBe(409);
  expect((await get(`/api/bots/${target}/thread`)).tasks[0].runs).toHaveLength(1);
});
