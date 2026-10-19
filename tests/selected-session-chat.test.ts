import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HostMailbox, RunnerMailbox } from "@mybots/mailbox/node";
import { afterEach, expect, it, vi } from "vitest";
import { runMailbox } from "../packages/agent-runner/src/poll-loop.ts";
import { PiProvider } from "../packages/agent-runner/src/providers/pi.ts";
import { WebSocketChannel } from "../packages/host/src/channels/websocket.ts";
import { loadHostSettings } from "../packages/host/src/config/host.ts";
import type { SessionDriver } from "../packages/host/src/drivers/types.ts";
import { Host } from "../packages/host/src/host.ts";
import { waitForCheckpoint } from "./checkpoint.ts";
import { MailboxDriver } from "./host-fixture.ts";
import { startPiService } from "./pi-fixture.ts";

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

it("creates, names and selects separate Bot-owned chats with stable admissions after restart", async () => {
  const configuration = await start();
  const request = { requestId: "new-chat", botId: "personal", name: "Research notes" };
  const response = await post("/api/sessions", request);
  expect(response.status).toBe(201);
  const created = await response.json();
  expect(created).toMatchObject({
    requestId: "new-chat",
    session: { botId: "personal", name: "Research notes", purpose: "chat" },
  });
  const other = await (await post("/api/sessions", { ...request, requestId: "other-chat" })).json();
  expect(other.session.id).not.toBe(created.session.id);
  expect((await post("/api/sessions", request)).status).toBe(200);
  expect((await post("/api/sessions", { ...request, name: "Changed" })).status).toBe(409);
  expect(
    (await post("/api/sessions", { ...request, requestId: "missing-bot", botId: "missing" }))
      .status,
  ).toBe(404);
  const renamed = await post(`/api/sessions/${created.session.id}/name`, {
    requestId: "rename-chat",
    name: "Sources",
  });
  expect(renamed.status).toBe(200);
  expect(await get(`/api/sessions/${created.session.id}`)).toMatchObject({
    session: { name: "Sources" },
    works: [],
  });
  await channel.close();
  await host.stop();
  host = await Host.start({ root, configuration, driver: new MailboxDriver() });
  await listen(configuration);
  expect(await get("/api/sessions?botId=personal")).toMatchObject({
    sessions: [{ id: created.session.id, name: "Sources" }, { id: other.session.id }],
  });
  expect(await (await post("/api/sessions", request)).json()).toEqual({
    ...created,
    replayed: true,
  });
});

it("tracks FIFO follow-ups in one work and starts distinct post-terminal work without duplicate inputs", async () => {
  const driver = new MailboxDriver();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const seen: string[] = [];
  driver.respond = async (input, _material, signal) => {
    seen.push(input.content);
    if (seen.length === 1) {
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
  const { session } = await (
    await post("/api/sessions", { requestId: "chat", botId: "personal", name: "FIFO" })
  ).json();
  const path = `/api/sessions/${session.id}`;
  try {
    const response = await post(`${path}/messages`, { requestId: "first", text: "One" });
    expect(response.status).toBe(202);
    const first = await response.json();
    await waitForCheckpoint(entered.promise, "first exchange");
    const [secondResponse, replayResponse] = await Promise.all([
      post(`${path}/messages`, { requestId: "second", text: "Two" }),
      post(`${path}/messages`, { requestId: "first", text: "One" }),
    ]);
    const second = await secondResponse.json();
    expect(second).toMatchObject({ workId: first.workId });
    expect(await replayResponse.json()).toEqual({ ...first, replayed: true });
    const third = await (
      await post(`${path}/messages`, { requestId: "third", text: "Three" })
    ).json();
    expect(third.workId).toBe(first.workId);
    expect((await post(`${path}/messages`, { requestId: "second", text: "Changed" })).status).toBe(
      409,
    );
    expect(await get(path)).toMatchObject({
      works: [{ id: first.workId, state: "active", outcome: null }],
    });
    expect(seen).toEqual(["One"]);
    release.resolve();
    await vi.waitFor(async () =>
      expect(await get(path)).toMatchObject({
        works: [
          {
            id: first.workId,
            state: "succeeded",
            outcome: { kind: "succeeded", reply: "Final: Three", messageId: third.messageId },
          },
        ],
      }),
    );
    expect(seen).toEqual(["One", "Two", "Three"]);
    const next = await (await post(`${path}/messages`, { requestId: "next", text: "Four" })).json();
    expect(next.workId).not.toBe(first.workId);
    await vi.waitFor(async () => expect((await get(path)).works).toHaveLength(2));
  } finally {
    release.resolve();
  }
});

it("persists provider failure as a correlated outcome and permits later distinct work", async () => {
  const driver = new MailboxDriver();
  driver.respond = async (input, material) => {
    if (input.content === "Fail") {
      const mailbox = new RunnerMailbox(material.directory);
      mailbox.acknowledge(input.id, "completed");
      return { error: "Provider unavailable" };
    }
    return "Recovered reply";
  };
  const configuration = await start(driver);
  const { session } = await (
    await post("/api/sessions", { requestId: "failure-chat", botId: "personal", name: "Errors" })
  ).json();
  const path = `/api/sessions/${session.id}`;
  const first = await (
    await post(`${path}/messages`, { requestId: "failure", text: "Fail" })
  ).json();
  await vi.waitFor(async () =>
    expect(await get(path)).toMatchObject({
      works: [
        {
          id: first.workId,
          state: "failed",
          outcome: { kind: "failed", reply: "Provider unavailable", messageId: first.messageId },
        },
      ],
    }),
  );
  const saved = await get(path);
  await channel.close();
  await host.stop();
  host = await Host.start({ root, configuration, driver: new MailboxDriver() });
  await listen(configuration);
  expect(await get(path)).toEqual(saved);
  const next = await (
    await post(`${path}/messages`, { requestId: "after-failure", text: "Try something else" })
  ).json();
  expect(next.workId).not.toBe(first.workId);
  expect(
    await (await post(`${path}/messages`, { requestId: "failure", text: "Fail" })).json(),
  ).toEqual({ ...first, replayed: true });
});

it("keeps acknowledged output gaps uncertain across restart, holds pending follow-ups, and isolates unrelated work", async () => {
  const driver = new MailboxDriver();
  const acknowledged = Promise.withResolvers<void>();
  const crash = Promise.withResolvers<void>();
  driver.respond = async (input, material, signal) => {
    new RunnerMailbox(material.directory).acknowledge(input.id, "completed");
    acknowledged.resolve();
    await Promise.race([
      crash.promise,
      new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      ),
    ]);
    throw new Error("Controlled crash after acknowledgement");
  };
  const configuration = await start(driver);
  const { session } = await (
    await post("/api/sessions", {
      requestId: "uncertain-chat",
      botId: "personal",
      name: "Interrupted",
    })
  ).json();
  const path = `/api/sessions/${session.id}`;
  try {
    const first = await (
      await post(`${path}/messages`, { requestId: "acknowledged", text: "May have effects" })
    ).json();
    await waitForCheckpoint(acknowledged.promise, "early acknowledgement");
    expect(await get(path)).toMatchObject({
      works: [{ state: "active", outcome: null, messages: [{ outcome: null }] }],
    });
    const followUp = await (
      await post(`${path}/messages`, { requestId: "unclaimed-followup", text: "Do this next" })
    ).json();
    expect(followUp.workId).toBe(first.workId);
    crash.resolve();
    await vi.waitFor(async () =>
      expect(await get(path)).toMatchObject({ works: [{ state: "uncertain", outcome: null }] }),
    );
    expect(
      (await post(`${path}/messages`, { requestId: "replacement", text: "Start again" })).status,
    ).toBe(409);
    await channel.close();
    await host.stop();
    const resumed = new MailboxDriver();
    host = await Host.start({ root, configuration, driver: resumed });
    await listen(configuration);
    expect(await get(path)).toMatchObject({ works: [{ id: first.workId, state: "uncertain" }] });
    expect(
      (await post(`${path}/messages`, { requestId: "replacement", text: "Start again" })).status,
    ).toBe(409);
    expect(
      await (
        await post(`${path}/messages`, { requestId: "acknowledged", text: "May have effects" })
      ).json(),
    ).toEqual({ ...first, replayed: true });
    const { session: other } = await (
      await post("/api/sessions", { requestId: "other", botId: "personal", name: "Other work" })
    ).json();
    await post(`/api/sessions/${other.id}/messages`, {
      requestId: "unrelated",
      text: "Continue independently",
    });
    await vi.waitFor(async () =>
      expect(await get(`/api/sessions/${other.id}`)).toMatchObject({
        works: [{ state: "succeeded" }],
      }),
    );
    expect(resumed.launches.map((launch) => launch.material.key.sessionId)).toEqual([other.id]);
    expect(await get(path)).toMatchObject({
      works: [{ state: "uncertain", messages: [{ outcome: null }, { outcome: null }] }],
    });
  } finally {
    crash.resolve();
  }
});

it("runs independent sessions and Bots concurrently with shared same-Bot files and separate session state", async () => {
  const driver = new MailboxDriver();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const contexts = new Map<string, string[]>();
  driver.respond = async (input, material, signal) => {
    const history = contexts.get(material.directory) ?? [];
    history.push(input.content);
    contexts.set(material.directory, history);
    const file = join(material.workspace, "notes.txt");
    if (input.content === "Hold and write") {
      await writeFile(file, "Shared research");
      entered.resolve();
      await Promise.race([
        release.promise,
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
      ]);
    }
    let notes = "No notes";
    try {
      notes = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return `${history.join(" / ")}: ${notes}`;
  };
  await start(driver);
  const created = await (
    await post("/api/bots", {
      requestId: "writer",
      name: "Writer",
      instructions: "Write reports",
      model: { provider: "deepseek", id: "deepseek-chat" },
      tools: ["read", "write"],
    })
  ).json();
  const sessions: { id: string }[] = [];
  for (const [requestId, botId] of [
    ["first", "personal"],
    ["second", "personal"],
    ["third", created.bot.id],
  ]) {
    const response = await post("/api/sessions", { requestId, botId, name: requestId });
    expect(response.status).toBe(201);
    sessions.push((await response.json()).session);
  }
  try {
    await post(`/api/sessions/${sessions[0].id}/messages`, {
      requestId: "held",
      text: "Hold and write",
    });
    await waitForCheckpoint(entered.promise, "shared file written");
    await Promise.all(
      sessions.slice(1).map((session) =>
        post(`/api/sessions/${session.id}/messages`, {
          requestId: `read-${session.id}`,
          text: "Read",
        }),
      ),
    );
    await vi.waitFor(async () => {
      expect(await get(`/api/sessions/${sessions[1].id}`)).toMatchObject({
        works: [{ state: "succeeded", outcome: { reply: "Read: Shared research" } }],
      });
      expect(await get(`/api/sessions/${sessions[2].id}`)).toMatchObject({
        works: [{ state: "succeeded", outcome: { reply: "Read: No notes" } }],
      });
    });
    expect(await get(`/api/sessions/${sessions[0].id}`)).toMatchObject({
      works: [{ state: "active" }],
    });
    release.resolve();
    await vi.waitFor(async () =>
      expect(await get(`/api/sessions/${sessions[0].id}`)).toMatchObject({
        works: [{ state: "succeeded", outcome: { reply: "Hold and write: Shared research" } }],
      }),
    );
  } finally {
    release.resolve();
  }
});

it("keeps early-acknowledged follow-up loss uncertain even when the initial input has a final reply", async () => {
  const driver = new MailboxDriver();
  const started = Promise.withResolvers<void>();
  const loseQueue = Promise.withResolvers<void>();
  driver.respond = async (input, material, signal) => {
    started.resolve();
    await Promise.race([
      loseQueue.promise,
      new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      ),
    ]);
    const mailbox = new RunnerMailbox(material.directory);
    for (const followUp of mailbox.pending()) mailbox.acknowledge(followUp.id, "completed");
    mailbox.acknowledge(input.id, "completed");
    mailbox.reply(input, "Initial result");
    throw new Error("Controlled loss of acknowledged SDK queue");
  };
  await start(driver);
  const { session } = await (
    await post("/api/sessions", { requestId: "queue-chat", botId: "personal", name: "Early queue" })
  ).json();
  const path = `/api/sessions/${session.id}`;
  try {
    const first = await (
      await post(`${path}/messages`, { requestId: "initial", text: "Initial" })
    ).json();
    await waitForCheckpoint(started.promise, "initial turn");
    const followUp = await (
      await post(`${path}/messages`, { requestId: "queued", text: "Queued" })
    ).json();
    expect(followUp.workId).toBe(first.workId);
    loseQueue.resolve();
    await vi.waitFor(async () =>
      expect(await get(path)).toMatchObject({
        works: [
          {
            state: "uncertain",
            outcome: null,
            messages: [{ outcome: { reply: "Initial result" } }, { outcome: null }],
          },
        ],
      }),
    );
  } finally {
    loseQueue.resolve();
  }
});

it("validates chat operations without consuming identities or admitting unintended execution", async () => {
  const driver = new MailboxDriver();
  await start(driver);
  for (const value of [
    null,
    [],
    {},
    { requestId: "bad", botId: "personal", name: " " },
    { requestId: "bad", botId: "personal", name: "x", model: "override" },
  ])
    expect((await post("/api/sessions", value)).status).toBe(400);
  const responses = await Promise.all(
    [1, 2, 3].map(() =>
      post("/api/sessions", { requestId: "same", botId: "personal", name: "Chat" }),
    ),
  );
  expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 201]);
  const admitted = await responses[0].json();
  const path = `/api/sessions/${admitted.session.id}`;
  expect(
    (await post(`${path}/messages`, { requestId: "invalid", text: " ", botId: "other" })).status,
  ).toBe(400);
  expect((await post(`${path}/messages`, { requestId: "invalid", text: "" })).status).toBe(400);
  expect(
    (await post(`${path}/messages`, { requestId: "invalid", text: "x".repeat(32001) })).status,
  ).toBe(400);
  expect(
    (await post(`${path}/messages`, { requestId: "invalid", text: "x".repeat(66000) })).status,
  ).toBe(413);
  expect(
    (await fetch(`${base}${path}/messages`, { method: "POST", headers, body: "{" })).status,
  ).toBe(400);
  expect(
    (await post("/api/sessions/unknown/messages", { requestId: "unknown", text: "Hello" })).status,
  ).toBe(404);
  expect(
    (await post("/api/sessions/unknown/name", { requestId: "unknown", name: "Name" })).status,
  ).toBe(404);
  const getMissing = await fetch(`${base}/api/sessions/unknown`, { headers });
  expect(getMissing.status).toBe(404);
  const legacy = await host.accept({
    destinationId: "terminal",
    userId: "cli:local",
    text: "Legacy",
  });
  expect(
    (
      await post(`/api/sessions/${legacy.sessionId}/messages`, {
        requestId: "channel-root",
        text: "Unrelated",
      })
    ).status,
  ).toBe(404);
  expect((await post(`${path}/name`, { requestId: "same", name: "Collision" })).status).toBe(409);
  expect(await get(path)).toMatchObject({ works: [] });
  expect(driver.launches.map((launch) => launch.material.key.sessionId)).toEqual([
    legacy.sessionId,
  ]);
});

it("recovers a saved exhausted-input failure if the Host stopped before projecting its outcome", async () => {
  const driver = new MailboxDriver();
  driver.fail = true;
  const configuration = await start(driver);
  const { session } = await (
    await post("/api/sessions", {
      requestId: "exhausted-chat",
      botId: "personal",
      name: "Recovery",
    })
  ).json();
  const path = `/api/sessions/${session.id}`;
  const admitted = await (
    await post(`${path}/messages`, { requestId: "exhausted", text: "Could not execute" })
  ).json();
  await channel.close();
  await host.stop();
  // The Host persisted retry exhaustion in the mailbox, then lost its outcome projection.
  new HostMailbox(join(root, "data", "sessions", "personal", session.id)).failInput(
    admitted.messageId,
  );
  const restarted = new MailboxDriver();
  host = await Host.start({ root, configuration, driver: restarted });
  await listen(configuration);
  expect(await get(path)).toMatchObject({
    works: [
      {
        id: admitted.workId,
        state: "failed",
        outcome: { kind: "failed", messageId: admitted.messageId },
      },
    ],
  });
  expect(restarted.launches).toEqual([]);
});

it("publishes a durably admitted input after restart without changing its identity", async () => {
  const driver = new MailboxDriver();
  driver.fail = true;
  const configuration = await start(driver);
  const { session } = await (
    await post("/api/sessions", {
      requestId: "outbox-chat",
      botId: "personal",
      name: "Publication",
    })
  ).json();
  const path = `/api/sessions/${session.id}`;
  const request = { requestId: "outbox", text: "Admitted before publication" };
  const admitted = await (await post(`${path}/messages`, request)).json();
  await channel.close();
  await host.stop();
  // Recreate the admission-before-publication crash checkpoint; no runner claimed this input.
  const db = new DatabaseSync(join(root, "data", "sessions", "personal", session.id, "inbound.db"));
  db.prepare("DELETE FROM messages_in WHERE id = ?").run(admitted.messageId);
  db.close();
  host = await Host.start({ root, configuration, driver: new MailboxDriver() });
  await listen(configuration);
  expect(await (await post(`${path}/messages`, request)).json()).toEqual({
    ...admitted,
    replayed: true,
  });
  await vi.waitFor(async () =>
    expect(await get(path)).toMatchObject({
      works: [
        {
          id: admitted.workId,
          state: "succeeded",
          messages: [
            {
              id: admitted.messageId,
              text: request.text,
              outcome: { reply: `Reply: ${request.text}` },
            },
          ],
        },
      ],
    }),
  );
});

it("uses separate real Pi contexts for selected chats while sharing only the owning Bot workspace", async () => {
  const service = await startPiService((request) => {
    const latestIndex = request.messages.findLastIndex((message) => message.role === "user");
    const latest = JSON.stringify(request.messages[latestIndex]?.content);
    const tool = request.messages.slice(latestIndex + 1).find((message) => message.role === "tool");
    if (latest.includes("Store private A"))
      return tool
        ? { text: "Stored A" }
        : { tool: "write", arguments: { path: "shared.txt", content: "amber orchard" } };
    if (latest.includes("Read shared"))
      return tool
        ? {
            text: JSON.stringify(tool.content).includes("amber orchard")
              ? "Read amber orchard"
              : "No shared note",
          }
        : { tool: "read", arguments: { path: "shared.txt" } };
    return {
      text: JSON.stringify(request.messages).includes("Store private A")
        ? "Reopened A"
        : "Missing A",
    };
  });
  const driver: SessionDriver = {
    async start(material, signal) {
      const controller = new AbortController();
      const running = runMailbox({
        mailbox: new RunnerMailbox(material.directory),
        provider: new PiProvider({ modelRuntime: service.runtime, model: service.model }),
        cwd: material.workspace,
        sessionDir: join(material.directory, "pi"),
        resources: { tools: ["read", "write"] },
        signal: AbortSignal.any([signal, controller.signal]),
        pollMs: 5,
      });
      return {
        wait: () => running,
        stop: async () => {
          controller.abort();
          await running;
        },
      };
    },
  };
  try {
    const configuration = await start(driver);
    const writer = await (
      await post("/api/bots", {
        requestId: "pi-writer",
        name: "Writer",
        instructions: "Write reports",
        model: { provider: "deepseek", id: "deepseek-chat" },
        tools: ["read", "write"],
      })
    ).json();
    const selected: { id: string }[] = [];
    for (const [requestId, botId] of [
      ["pi-a", "personal"],
      ["pi-b", "personal"],
      ["pi-c", writer.bot.id],
    ])
      selected.push(
        (await (await post("/api/sessions", { requestId, botId, name: requestId })).json()).session,
      );
    await post(`/api/sessions/${selected[0].id}/messages`, {
      requestId: "pi-store",
      text: "Store private A",
    });
    await vi.waitFor(async () =>
      expect(await get(`/api/sessions/${selected[0].id}`)).toMatchObject({
        works: [{ state: "succeeded", outcome: { reply: "Stored A" } }],
      }),
    );
    await Promise.all(
      selected.slice(1).map((session) =>
        post(`/api/sessions/${session.id}/messages`, {
          requestId: `pi-read-${session.id}`,
          text: "Read shared",
        }),
      ),
    );
    await vi.waitFor(async () => {
      expect(await get(`/api/sessions/${selected[1].id}`)).toMatchObject({
        works: [{ state: "succeeded", outcome: { reply: "Read amber orchard" } }],
      });
      expect(await get(`/api/sessions/${selected[2].id}`)).toMatchObject({
        works: [{ state: "succeeded", outcome: { reply: "No shared note" } }],
      });
    });
    const readRequests = service.requests.filter((request) =>
      JSON.stringify(request.messages.at(-1)?.content).includes("Read shared"),
    );
    expect(readRequests).toHaveLength(2);
    for (const request of readRequests)
      expect(JSON.stringify(request.messages)).not.toContain("Store private A");
    await channel.close();
    await host.stop();
    host = await Host.start({ root, configuration, driver });
    await listen(configuration);
    await post(`/api/sessions/${selected[0].id}/messages`, {
      requestId: "pi-reopen",
      text: "Reopen A",
    });
    await vi.waitFor(async () =>
      expect((await get(`/api/sessions/${selected[0].id}`)).works).toMatchObject([
        { outcome: { reply: "Stored A" } },
        { outcome: { reply: "Reopened A" } },
      ]),
    );
    expect(JSON.stringify(service.requests.at(-1)?.messages)).not.toContain("Read shared");
  } finally {
    await host?.stop();
    await service.close();
  }
}, 15000);

it("reports queued recovery when a later input was not acknowledged before execution stopped", async () => {
  const driver = new MailboxDriver();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  driver.respond = async (input, material, signal) => {
    entered.resolve();
    await Promise.race([
      release.promise,
      new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      ),
    ]);
    const mailbox = new RunnerMailbox(material.directory);
    mailbox.acknowledge(input.id, "completed");
    mailbox.reply(input, "Initial completed");
    throw new Error("Controlled exit before claiming the next input");
  };
  await start(driver);
  const { session } = await (
    await post("/api/sessions", {
      requestId: "pending-chat",
      botId: "personal",
      name: "Pending recovery",
    })
  ).json();
  const path = `/api/sessions/${session.id}`;
  try {
    await post(`${path}/messages`, { requestId: "pending-initial", text: "First" });
    await waitForCheckpoint(entered.promise, "initial input");
    await post(`${path}/messages`, { requestId: "pending-later", text: "Later" });
    release.resolve();
    await vi.waitFor(async () =>
      expect(await get(path)).toMatchObject({
        works: [
          {
            state: "queued",
            outcome: null,
            messages: [{ outcome: { reply: "Initial completed" } }, { outcome: null }],
          },
        ],
      }),
    );
  } finally {
    release.resolve();
  }
});

it("preserves durable success when the final recovery attempt exits before Host acknowledgement sync", async () => {
  const driver: SessionDriver = {
    async start(material) {
      const mailbox = new RunnerMailbox(material.directory);
      const input = mailbox.pending()[0];
      if (!input) throw new Error("Expected admitted input");
      // Final allowed attempt, just before the Host observes its terminal acknowledgement.
      const db = new DatabaseSync(join(material.directory, "inbound.db"));
      db.prepare("UPDATE messages_in SET tries = 5 WHERE id = ?").run(input.id);
      db.close();
      mailbox.acknowledge(input.id, "completed");
      mailbox.reply(input, "Durable success");
      return {
        wait: async () => {
          throw new Error("Controlled exit after saved final evidence");
        },
        stop: async () => {},
      };
    },
  };
  await start(driver);
  const { session } = await (
    await post("/api/sessions", {
      requestId: "last-attempt-chat",
      botId: "personal",
      name: "Final attempt",
    })
  ).json();
  const path = `/api/sessions/${session.id}`;
  const admitted = await (
    await post(`${path}/messages`, { requestId: "last-attempt", text: "Finish on last attempt" })
  ).json();
  await vi.waitFor(async () =>
    expect(await get(path)).toMatchObject({
      works: [
        {
          state: "succeeded",
          outcome: { reply: "Durable success", messageId: admitted.messageId },
        },
      ],
    }),
  );
});

it("links a failed work outcome to its failed input even when a later follow-up succeeds", async () => {
  const driver = new MailboxDriver();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  driver.respond = async (input, _material, signal) => {
    if (input.content === "Fail first") {
      entered.resolve();
      await Promise.race([
        release.promise,
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
      ]);
      return { error: "First input failed" };
    }
    return "Later input succeeded";
  };
  await start(driver);
  const { session } = await (
    await post("/api/sessions", {
      requestId: "mixed-chat",
      botId: "personal",
      name: "Mixed outcomes",
    })
  ).json();
  const path = `/api/sessions/${session.id}`;
  try {
    const initial = await (
      await post(`${path}/messages`, { requestId: "mixed-initial", text: "Fail first" })
    ).json();
    await waitForCheckpoint(entered.promise, "first input");
    const followUp = await (
      await post(`${path}/messages`, { requestId: "mixed-followup", text: "Succeed later" })
    ).json();
    expect(followUp.workId).toBe(initial.workId);
    release.resolve();
    await vi.waitFor(async () =>
      expect(await get(path)).toMatchObject({
        works: [
          {
            state: "failed",
            outcome: { kind: "failed", messageId: initial.messageId, reply: "First input failed" },
            messages: [
              { outcome: { kind: "failed" } },
              { outcome: { kind: "succeeded", reply: "Later input succeeded" } },
            ],
          },
        ],
      }),
    );
  } finally {
    release.resolve();
  }
});

it.each(["unclaimed", "processing"])(
  "does not execute a newer follow-up ahead of %s input waiting for bounded recovery",
  async (claim) => {
    let launches = 0;
    const secondStart = Promise.withResolvers<void>();
    const driver: SessionDriver = {
      async start(material, signal) {
        launches++;
        if (launches === 1) {
          if (claim === "processing") {
            const mailbox = new RunnerMailbox(material.directory);
            const input = mailbox.pending()[0];
            if (!input) throw new Error("Expected admitted input");
            mailbox.acknowledge(input.id, "processing");
          }
          return {
            wait: async () => {
              throw new Error("Controlled unfinished crash");
            },
            stop: async () => {},
          };
        }
        const mailbox = new RunnerMailbox(material.directory);
        for (const input of mailbox.pending()) {
          mailbox.acknowledge(input.id, "completed");
          mailbox.reply(input, "Executed before the earlier retry");
        }
        secondStart.resolve();
        const stopped = Promise.withResolvers<void>();
        signal.addEventListener("abort", () => stopped.resolve(), { once: true });
        return { wait: () => stopped.promise, stop: async () => stopped.resolve() };
      },
    };
    await start(driver);
    const { session } = await (
      await post("/api/sessions", {
        requestId: "retry-fifo-chat",
        botId: "personal",
        name: "Recovery order",
      })
    ).json();
    const path = `/api/sessions/${session.id}`;
    const first = await (
      await post(`${path}/messages`, { requestId: "retry-fifo-initial", text: "Earlier" })
    ).json();
    await vi.waitFor(async () =>
      expect((await get("/api/status")).sessions).toMatchObject([{ containerStatus: "stopped" }]),
    );
    const second = await (
      await post(`${path}/messages`, { requestId: "retry-fifo-later", text: "Later" })
    ).json();
    expect(second.workId).toBe(first.workId);
    await waitForCheckpoint(secondStart.promise, "restarted runner input selection");
    expect(await get(path)).toMatchObject({
      works: [{ outcome: null, messages: [{ outcome: null }, { outcome: null }] }],
    });
  },
);
