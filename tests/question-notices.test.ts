import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerMailbox } from "@mybots/mailbox/node";
import { afterEach, expect, it, vi } from "vitest";
import { TelegramChannel } from "../packages/host/src/channels/telegram.ts";
import { createTelegramApi } from "../packages/host/src/channels/telegram-api.ts";
import { WebSocketChannel } from "../packages/host/src/channels/websocket.ts";
import { loadHostSettings } from "../packages/host/src/config/host.ts";
import type { HostConfiguration } from "../packages/host/src/host.ts";
import { Host } from "../packages/host/src/host.ts";
import { MailboxDriver } from "./host-fixture.ts";

let root = "";
let host: Host | undefined;
let channel: TelegramChannel | undefined;
let web: WebSocketChannel | undefined;
let closeTelegram: (() => Promise<void>) | undefined;
let now = Date.parse("2026-10-21T00:00:00.000Z");
let headers: Record<string, string> = {};
let base = "";

afterEach(async () => {
  await channel?.stop();
  await web?.close();
  await host?.stop();
  channel = undefined;
  web = undefined;
  host = undefined;
  await closeTelegram?.();
  closeTelegram = undefined;
  if (root) await rm(root, { recursive: true, force: true });
});

interface TelegramReply {
  status?: number;
  body: unknown;
}

async function startTelegram(
  handler: (
    method: string,
    body: Record<string, unknown>,
  ) => TelegramReply | Promise<TelegramReply>,
  topicsEnabled: () => boolean = () => true,
) {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<
      string,
      unknown
    >;
    const method = request.url?.split("/").at(-1) ?? "";
    calls.push({ method, body });
    const result =
      method === "getMe"
        ? {
            body: {
              ok: true,
              result: { id: 1, username: "notice_bot", has_topics_enabled: topicsEnabled() },
            },
          }
        : await handler(method, body);
    response.writeHead(result.status ?? 200, { "content-type": "application/json" });
    response.end(JSON.stringify(result.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Telegram fixture did not bind");
  closeTelegram = () =>
    new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  return { calls, url: `http://127.0.0.1:${address.port}` };
}

function okChat(): TelegramReply {
  return { body: { ok: true, result: { id: 123456789, type: "private" } } };
}
function okTopic(topicId: number, name: unknown): TelegramReply {
  return { body: { ok: true, result: { message_thread_id: topicId, name } } };
}
function okSend(): TelegramReply {
  return { body: { ok: true, result: { message_id: 1 } } };
}

async function open(driver = new MailboxDriver(), file = "examples/host/host-telegram.json") {
  now = Date.parse("2026-10-21T00:00:00.000Z");
  root = await mkdtemp(join(tmpdir(), "mybots-notices-"));
  const { configuration } = await loadHostSettings(file);
  host = await Host.start({
    root,
    configuration,
    driver,
    now: () => now,
    reconcileMs: 365 * 86400000,
  });
  web = await WebSocketChannel.listen({ root, host, configuration, port: 0 });
  base = `http://127.0.0.1:${web.address.port}`;
  headers = {
    Authorization: `Bearer ${(await readFile(join(root, "data", "client-credential"), "utf8")).trim()}`,
    "Content-Type": "application/json",
  };
  return { configuration, driver };
}

function attach(url: string, configuration: HostConfiguration) {
  const running = host;
  if (!running) throw new Error("Host is not running");
  channel = TelegramChannel.listen({
    host: running,
    api: createTelegramApi({ token: "offline-token", baseUrl: url, fetch: globalThis.fetch }),
    instance: "telegram",
    destinations: configuration.destinations
      .filter((destination) => destination.channelType === "telegram")
      .map((destination) => ({ id: destination.id, platformId: destination.platformId })),
    owners: configuration.owners,
  });
}

function post(path: string, body: unknown) {
  return fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}
async function get(path: string) {
  const response = await fetch(`${base}${path}`, { headers });
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    tasks: { runs: { id: string; state: string; outcome: { kind: string } | null }[] }[];
    notices: {
      questionId: string;
      botId: string;
      taskId: string;
      runId: string;
      summary: string;
      locator: string;
      eligibility: string;
      state: string;
      attempts: number;
      nextAttemptAt: string | null;
      lastError: string | null;
      acceptedAt: string | null;
    }[];
    telegramTopic: {
      chatId: string;
      topicId: string | null;
      state: string;
      failure: string | null;
    } | null;
  }>;
}

async function ask(driver: MailboxDriver, id: string, text: string) {
  const previous = driver.respond;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  driver.respond = async (input, material, signal) => {
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else {
        signal.addEventListener("abort", () => resolve(), { once: true });
        gate.then(resolve);
      }
    });
    if (signal.aborted) return "stopped";
    if (previous) return previous(input, material, signal);
    return `Reply: ${input.content}`;
  };
  const sent = await (
    await post("/api/bots/personal/thread/messages", {
      requestId: `source-${id}`,
      text: "Plan a trip",
    })
  ).json();
  await vi.waitFor(() => expect(driver.launches.length).toBeGreaterThan(0));
  const mailbox = new RunnerMailbox(driver.launches.at(-1)?.material.directory as string);
  mailbox.requestHistory({
    id,
    operation: "ask_question",
    incarnation: mailbox.executionIncarnation(),
    input: { requestId: id, text },
  });
  await vi.waitFor(() =>
    expect(mailbox.historyResponse(id)).toMatchObject({ result: { state: "pending" } }),
  );
  release();
  return { sent, mailbox };
}

function sends(calls: { method: string; body: Record<string, unknown> }[]) {
  return calls.filter((call) => call.method === "sendMessage");
}

it("sends a pending question to that Bot topic with identity and a local client locator", async () => {
  const driver = new MailboxDriver();
  driver.respond = async (_input, _material, signal) => {
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return "Still working";
  };
  const telegram = await startTelegram((method, body) => {
    if (method === "getChat") return okChat();
    if (method === "createForumTopic") return okTopic(77, body.name);
    return okSend();
  });
  const { configuration } = await open(driver);
  attach(telegram.url, configuration);
  const { sent } = await ask(driver, "destination", "Which city?");
  const detail = await vi.waitFor(async () => {
    const body = await get("/api/bots/personal/thread");
    expect(body.notices[0]?.state).toBe("delivered");
    return body;
  });
  expect(detail.tasks[0]?.runs[0]?.state).not.toBe("failed");
  expect(detail.telegramTopic).toEqual({
    chatId: "123456789",
    topicId: "77",
    state: "mapped",
    failure: null,
  });
  expect(detail.notices[0]).toMatchObject({
    questionId: "destination",
    botId: "personal",
    taskId: sent.taskId,
    runId: sent.runId,
    summary: "Which city?",
    locator: `/?bot=personal&run=${sent.runId}#question-destination`,
    eligibility: "eligible",
    attempts: 1,
    acceptedAt: "2026-10-21T00:00:00.000Z",
  });
  expect(sends(telegram.calls)).toEqual([
    {
      method: "sendMessage",
      body: {
        chat_id: "123456789",
        message_thread_id: 77,
        text: [
          "Question needs an answer",
          "Bot: Personal (personal)",
          `Task: ${sent.taskId}`,
          `Run: ${sent.runId}`,
          "Request: destination",
          `Local client: /?bot=personal&run=${sent.runId}#question-destination`,
          "Which city?",
        ].join("\n"),
      },
    },
  ]);
  expect(
    await channel?.dispatch({
      updateId: 1,
      userId: "123456789",
      chatId: "123456789",
      text: "Hangzhou",
    }),
  ).toBeUndefined();
  expect(
    await channel?.dispatch({
      updateId: 2,
      userId: "123456789",
      chatId: "123456789",
      text: "approve",
      threadId: "77",
    }),
  ).toBeUndefined();
  expect(driver.launches).toHaveLength(1);
});

it("waits five then thirty seconds, honors a longer retry-after, and stops after three attempts", async () => {
  const driver = new MailboxDriver();
  let retryAfter = true;
  const telegram = await startTelegram((method) => {
    if (method === "getChat") return okChat();
    if (method === "createForumTopic") return okTopic(77, "Personal");
    if (retryAfter) {
      retryAfter = false;
      return {
        status: 429,
        body: { ok: false, description: "Too Many Requests", parameters: { retry_after: 60 } },
      };
    }
    return { status: 500, body: { ok: false, description: "Internal Server Error" } };
  });
  const { configuration } = await open(driver);
  attach(telegram.url, configuration);
  await ask(driver, "destination", "Which city?");
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).notices[0]?.attempts).toBe(1),
  );
  expect((await get("/api/bots/personal/thread")).notices[0]).toMatchObject({
    state: "pending",
    nextAttemptAt: "2026-10-21T00:01:00.000Z",
    lastError: "Telegram asked to wait 60 seconds.",
  });
  now += 5000;
  await expect(
    vi.waitFor(() => expect(sends(telegram.calls).length).toBe(2), { timeout: 150 }),
  ).rejects.toThrow();
  now += 55000;
  await vi.waitFor(() => expect(sends(telegram.calls).length).toBe(2));
  expect((await get("/api/bots/personal/thread")).notices[0]?.nextAttemptAt).toBe(
    "2026-10-21T00:01:30.000Z",
  );
  now += 30000;
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).notices[0]?.state).toBe("failed"),
  );
  expect((await get("/api/bots/personal/thread")).notices[0]?.attempts).toBe(3);
  const sent = sends(telegram.calls).length;
  now += 120000;
  await expect(
    vi.waitFor(() => expect(sends(telegram.calls).length).toBe(sent + 1), { timeout: 150 }),
  ).rejects.toThrow();
  expect((await get("/api/bots/personal/thread")).tasks[0]?.runs[0]?.state).not.toBe("failed");
});

it("keeps an exhausted notice failed across restart until the owner resends it", async () => {
  const driver = new MailboxDriver();
  const telegram = await startTelegram((method) => {
    if (method === "getChat") return okChat();
    if (method === "createForumTopic") return okTopic(77, "Personal");
    return { status: 500, body: { ok: false, description: "Internal Server Error" } };
  });
  const first = await open(driver);
  attach(telegram.url, first.configuration);
  await ask(driver, "destination", "Which city?");
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).notices[0]?.attempts).toBe(1),
  );
  now += 5000;
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).notices[0]?.attempts).toBe(2),
  );
  now += 30000;
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).notices[0]?.state).toBe("failed"),
  );
  const sent = sends(telegram.calls).length;
  await closeTelegram?.();
  closeTelegram = undefined;
  await channel?.stop();
  channel = undefined;
  await web?.close();
  await host?.stop();
  host = undefined;
  const { configuration } = await loadHostSettings("examples/host/host-telegram.json");
  host = await Host.start({
    root,
    configuration,
    driver: new MailboxDriver(),
    now: () => now,
    reconcileMs: 365 * 86400000,
  });
  web = await WebSocketChannel.listen({ root, host, configuration, port: 0 });
  base = `http://127.0.0.1:${web.address.port}`;
  headers = {
    Authorization: `Bearer ${(await readFile(join(root, "data", "client-credential"), "utf8")).trim()}`,
    "Content-Type": "application/json",
  };
  const recovered = await startTelegram((method) => {
    if (method === "getChat") return okChat();
    if (method === "createForumTopic") return okTopic(77, "Personal");
    return okSend();
  });
  attach(recovered.url, configuration);
  now += 120000;
  await expect(
    vi.waitFor(() => expect(sends(recovered.calls).length).toBe(1), { timeout: 150 }),
  ).rejects.toThrow();
  expect((await get("/api/bots/personal/thread")).notices[0]).toMatchObject({
    state: "failed",
    attempts: 3,
  });
  expect(sends(telegram.calls).length).toBe(sent);
  const resend = await post("/api/bots/personal/questions/destination/notice/resend", {
    requestId: "resend-destination",
  });
  expect(resend.status).toBe(202);
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).notices[0]).toMatchObject({
      state: "delivered",
      attempts: 1,
    }),
  );
  expect((await get("/api/bots/personal/thread")).tasks[0]?.runs[0]?.state).not.toBe("failed");
  expect(sends(recovered.calls)[0]?.body.message_thread_id).toBe(77);
});

it("repairs a deleted topic without treating the failure as delivery", async () => {
  const driver = new MailboxDriver();
  let deleted = true;
  let topicId = 76;
  const telegram = await startTelegram((method, body) => {
    if (method === "getChat") return okChat();
    if (method === "createForumTopic") {
      topicId += 1;
      return okTopic(topicId, body.name);
    }
    if (deleted)
      return {
        status: 400,
        body: { ok: false, description: "Bad Request: message thread not found" },
      };
    return okSend();
  });
  const { configuration } = await open(driver);
  attach(telegram.url, configuration);
  await ask(driver, "destination", "Which city?");
  await vi.waitFor(async () => {
    const detail = await get("/api/bots/personal/thread");
    expect(detail.notices[0]?.state).toBe("failed");
    expect(detail.telegramTopic).toMatchObject({
      state: "repairable",
      topicId: null,
      failure: "Telegram topic was deleted.",
    });
  });
  expect(sends(telegram.calls)).toHaveLength(1);
  expect(sends(telegram.calls)[0]?.body.message_thread_id).toBe(77);
  deleted = false;
  const repair = await post("/api/bots/personal/telegram-topic/repair", {
    requestId: "repair-topic",
  });
  expect(repair.status).toBe(202);
  expect(await repair.json()).toMatchObject({ topicId: "78", state: "mapped", failure: null });
  expect((await get("/api/bots/personal/thread")).notices[0]?.state).toBe("failed");
  const resend = await post("/api/bots/personal/questions/destination/notice/resend", {
    requestId: "resend-after-repair",
  });
  expect(resend.status).toBe(202);
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).notices[0]?.state).toBe("delivered"),
  );
  expect(sends(telegram.calls).at(-1)?.body.message_thread_id).toBe(78);
  expect((await get("/api/bots/personal/thread")).tasks[0]?.runs[0]?.state).not.toBe("failed");
});

it("keeps unavailable private topic mode visible until the owner repairs it", async () => {
  const driver = new MailboxDriver();
  let topics = false;
  const telegram = await startTelegram(
    (method, body) => {
      if (method === "getChat") return okChat();
      if (method === "createForumTopic") return okTopic(77, body.name);
      return okSend();
    },
    () => topics,
  );
  const { configuration } = await open(driver);
  attach(telegram.url, configuration);
  await ask(driver, "destination", "Which city?");
  await vi.waitFor(async () => {
    const detail = await get("/api/bots/personal/thread");
    expect(detail.notices[0]).toMatchObject({
      state: "failed",
      attempts: 0,
      lastError: "Private topic mode is unavailable.",
    });
    expect(detail.telegramTopic).toMatchObject({ state: "repairable", topicId: null });
  });
  expect(telegram.calls.some((call) => call.method === "createForumTopic")).toBe(false);
  expect(sends(telegram.calls)).toHaveLength(0);
  const stuck = await post("/api/bots/personal/telegram-topic/repair", {
    requestId: "repair-mode",
  });
  expect(await stuck.json()).toMatchObject({
    state: "repairable",
    failure: "Private topic mode is unavailable.",
  });
  topics = true;
  const repair = await post("/api/bots/personal/telegram-topic/repair", {
    requestId: "repair-mode-ready",
  });
  expect(await repair.json()).toMatchObject({ state: "mapped", topicId: "77" });
  expect(
    (
      await post("/api/bots/personal/questions/destination/notice/resend", {
        requestId: "resend-mode",
      })
    ).status,
  ).toBe(202);
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).notices[0]?.state).toBe("delivered"),
  );
  expect(sends(telegram.calls)).toHaveLength(1);
  expect((await get("/api/bots/personal/thread")).tasks[0]?.runs[0]?.state).not.toBe("failed");
});

it("shows missing chat authority as a repairable failure and never a successful notice", async () => {
  const driver = new MailboxDriver();
  let blocked = true;
  const telegram = await startTelegram((method, body) => {
    if (method === "getChat" && blocked)
      return {
        status: 403,
        body: { ok: false, description: "Forbidden: bot was blocked by the user" },
      };
    if (method === "getChat") return okChat();
    if (method === "createForumTopic") return okTopic(77, body.name);
    return okSend();
  });
  const { configuration } = await open(driver);
  attach(telegram.url, configuration);
  await ask(driver, "destination", "Which city?");
  await vi.waitFor(async () => {
    const detail = await get("/api/bots/personal/thread");
    expect(detail.notices[0]).toMatchObject({
      state: "failed",
      attempts: 0,
      lastError: "Telegram chat authority is unavailable.",
    });
    expect(detail.telegramTopic?.state).toBe("repairable");
  });
  expect(sends(telegram.calls)).toHaveLength(0);
  const stuck = await post("/api/bots/personal/telegram-topic/repair", {
    requestId: "repair-authority",
  });
  expect(await stuck.json()).toMatchObject({ state: "repairable" });
  blocked = false;
  const repair = await post("/api/bots/personal/telegram-topic/repair", {
    requestId: "repair-authority-ready",
  });
  expect(await repair.json()).toMatchObject({ state: "mapped", topicId: "77" });
  expect(
    (
      await post("/api/bots/personal/questions/destination/notice/resend", {
        requestId: "resend-authority",
      })
    ).status,
  ).toBe(202);
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).notices[0]?.state).toBe("delivered"),
  );
});

it("suppresses an unsent notice when the question is answered", async () => {
  const driver = new MailboxDriver();
  driver.respond = async (_input, _material, signal) => {
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return "Still working";
  };
  let releaseChat = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseChat = resolve;
  });
  const telegram = await startTelegram(async (method, body) => {
    if (method === "getChat") {
      await gate;
      return okChat();
    }
    if (method === "createForumTopic") return okTopic(77, body.name);
    return okSend();
  });
  const { configuration } = await open(driver);
  attach(telegram.url, configuration);
  const { sent } = await ask(driver, "destination", "Which city?");
  await vi.waitFor(() =>
    expect(telegram.calls.some((call) => call.method === "getChat")).toBe(true),
  );
  const answered = await post(
    `/api/bots/personal/runs/${sent.runId}/questions/destination/answer`,
    {
      requestId: "answer-destination",
      text: "Hangzhou",
    },
  );
  expect(answered.status).toBe(202);
  releaseChat();
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).notices[0]).toMatchObject({
      state: "suppressed",
      eligibility: "suppressed",
    }),
  );
  expect(sends(telegram.calls)).toHaveLength(0);
  expect((await get("/api/bots/personal/thread")).tasks[0]?.runs[0]?.state).not.toBe("failed");
});

it("leaves a successful Run successful when Telegram delivery fails", async () => {
  const driver = new MailboxDriver();
  let waiting = true;
  driver.respond = async (_input, _material, signal) => {
    if (!waiting) return "Done";
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return "Do not complete while waiting";
  };
  const telegram = await startTelegram((method, body) => {
    if (method === "getChat") return okChat();
    if (method === "createForumTopic") return okTopic(77, body.name);
    return { status: 500, body: { ok: false, description: "Internal Server Error" } };
  });
  const { configuration } = await open(driver);
  attach(telegram.url, configuration);
  const { sent, mailbox } = await ask(driver, "destination", "Which city?");
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).notices[0]?.attempts).toBe(1),
  );
  now += 5000;
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).notices[0]?.attempts).toBe(2),
  );
  now += 30000;
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).notices[0]?.state).toBe("failed"),
  );
  mailbox.requestDurableWait("owner-question");
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).tasks[0]?.runs[0]?.state).toBe("waiting"),
  );
  waiting = false;
  expect(
    (
      await post(`/api/bots/personal/runs/${sent.runId}/questions/destination/answer`, {
        requestId: "answer-destination",
        text: "Hangzhou",
      })
    ).status,
  ).toBe(202);
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).tasks[0]?.runs[0]?.state).toBe("succeeded"),
  );
  expect((await get("/api/bots/personal/thread")).notices[0]).toMatchObject({
    state: "suppressed",
    eligibility: "suppressed",
  });
});

it("notifies a question that was already pending when the private chat is attached", async () => {
  const driver = new MailboxDriver();
  driver.respond = async (_input, _material, signal) => {
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return "Still working";
  };
  const telegram = await startTelegram((method, body) => {
    if (method === "getChat") return okChat();
    if (method === "createForumTopic") return okTopic(77, body.name);
    return okSend();
  });
  const { configuration } = await open(driver, "examples/host/host.json");
  const { sent } = await ask(driver, "before-chat", "Which city?");
  expect((await get("/api/bots/personal/thread")).notices).toEqual([]);
  attach(telegram.url, {
    ...configuration,
    owners: [...configuration.owners, "telegram:123456789"],
    destinations: [
      ...configuration.destinations,
      {
        id: "owner-chat",
        channelType: "telegram",
        platformId: "123456789",
        instance: "telegram",
      },
    ],
  });
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).notices[0]).toMatchObject({
      questionId: "before-chat",
      runId: sent.runId,
      state: "delivered",
      locator: `/?bot=personal&run=${sent.runId}#question-before-chat`,
    }),
  );
  expect(sends(telegram.calls)[0]?.body.message_thread_id).toBe(77);
  expect((await get("/api/bots/personal/thread")).tasks[0]?.runs[0]?.state).not.toBe("failed");
});

it("retains attempts and backoff when the Host stops during Telegram sends", async () => {
  const driver = new MailboxDriver();
  let releaseSend = () => {};
  const telegram = await startTelegram(async (method) => {
    if (method === "getChat") return okChat();
    if (method === "createForumTopic") return okTopic(77, "Personal");
    await new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    return okSend();
  });
  const { configuration } = await open(driver);
  attach(telegram.url, configuration);
  const { mailbox } = await ask(driver, "interrupted-send", "Which city?");
  mailbox.requestDurableWait("owner-question");
  try {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await vi.waitFor(() => expect(sends(telegram.calls)).toHaveLength(attempt));
      expect((await get("/api/bots/personal/thread")).notices[0]?.attempts).toBe(attempt);
      await channel?.stop();
      channel = undefined;
      await web?.close();
      await host?.stop();
      host = undefined;
      releaseSend();
      host = await Host.start({ root, configuration, driver: new MailboxDriver(), now: () => now });
      web = await WebSocketChannel.listen({ root, host, configuration, port: 0 });
      base = `http://127.0.0.1:${web.address.port}`;
      attach(telegram.url, configuration);
      const notice = (await get("/api/bots/personal/thread")).notices[0];
      expect(notice?.attempts).toBe(attempt);
      if (attempt < 3) {
        expect(notice?.nextAttemptAt).toBe(
          new Date(now + (attempt === 1 ? 5000 : 30000)).toISOString(),
        );
        await expect(
          vi.waitFor(() => expect(sends(telegram.calls)).toHaveLength(attempt + 1), {
            timeout: 100,
          }),
        ).rejects.toThrow();
        now += attempt === 1 ? 5000 : 30000;
      }
    }
    await vi.waitFor(async () =>
      expect((await get("/api/bots/personal/thread")).notices[0]?.state).toBe("failed"),
    );
    expect(sends(telegram.calls)).toHaveLength(3);
  } finally {
    releaseSend();
  }
});

it("retains topic history after logical Bot deletion without giving it to a same-name replacement", async () => {
  const driver = new MailboxDriver();
  const telegram = await startTelegram((method) => {
    if (method === "getChat") return okChat();
    if (method === "createForumTopic") return okTopic(77, "Personal");
    return okSend();
  });
  const { configuration } = await open(driver);
  attach(telegram.url, configuration);
  await ask(driver, "retained-notice", "Which city?");
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).notices[0]?.state).toBe("delivered"),
  );
  const before = await get("/api/bots/personal/thread");
  expect((await post("/api/bots/personal/delete", { requestId: "delete-personal" })).status).toBe(
    202,
  );
  expect(
    (await post("/api/bots/personal/telegram-topic/repair", { requestId: "repair-deleted" }))
      .status,
  ).toBe(409);
  const retained = await get("/api/bots/personal/thread");
  expect(retained.telegramTopic).toEqual(before.telegramTopic);
  expect(retained.notices).toEqual(before.notices);
  const replacement = await (
    await post("/api/bots", {
      requestId: "replacement",
      name: "Personal",
      instructions: "Independent identity",
      model: { provider: "deepseek", id: "deepseek-chat" },
      tools: ["read"],
    })
  ).json();
  expect(replacement.bot.id).not.toBe("personal");
  const fresh = await get(`/api/bots/${replacement.bot.id}/thread`);
  expect(fresh.telegramTopic).toBeNull();
  expect(fresh.notices).toEqual([]);
  expect(sends(telegram.calls)).toHaveLength(1);
});
