import { afterEach, expect, it, vi } from "vitest";
import { runBot } from "../src/bot/startup.ts";
import { TelegramChannel, telegramTransport } from "../src/bot/telegram.ts";
import type { TelegramApi, TelegramUpdate } from "../src/bot/telegram-api.ts";
import { createTelegramApi, normalizeTelegramUpdate } from "../src/bot/telegram-api.ts";
import { EventRuntime } from "../src/core/runtime.ts";
import { chatFixture } from "./chat-fixture.ts";

let fixture: Awaited<ReturnType<typeof chatFixture>> | undefined;
let runtime: EventRuntime | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await runtime?.stop();
  runtime = undefined;
  await fixture?.close();
  fixture = undefined;
});

const signal = () => new AbortController().signal;

function telegramSettings(allowed: string[]): string {
  return [
    "channels:",
    "  enabled: true",
    "  telegram:",
    "    enabled: true",
    "    bot_token: offline-token",
    `    allowed_user_ids: [${allowed.map((id) => `"${id}"`).join(", ")}]`,
    "",
  ].join("\n");
}

function update(overrides: Partial<TelegramUpdate> = {}): TelegramUpdate {
  return { updateId: 1, userId: "42", chatId: "-100", text: "Hello", ...overrides };
}

function recordingApi(options: { failSends?: boolean } = {}) {
  const sends: { chatId: string; text: string }[] = [];
  const sendSignals: AbortSignal[] = [];
  const api: TelegramApi = {
    async getMe() {
      return { id: "1", username: "test_bot" };
    },
    async getUpdates() {
      return [];
    },
    async sendMessage(chatId, text, sendSignal) {
      sendSignals.push(sendSignal);
      if (options.failSends) throw new Error("Telegram unavailable");
      sends.push({ chatId, text });
    },
  };
  return { api, sends, sendSignals };
}

it("normalizes Telegram text updates and keeps identifiers as digit strings", () => {
  expect(
    normalizeTelegramUpdate({
      update_id: 5,
      message: { text: "Hi", from: { id: 42 }, chat: { id: -1001234567890 } },
    }),
  ).toEqual({ updateId: 5, userId: "42", chatId: "-1001234567890", text: "Hi" });
  expect(
    normalizeTelegramUpdate({
      update_id: 6,
      message: { text: "Hi", from: { id: "9007199254740993" }, chat: { id: "-100" } },
    }),
  ).toEqual({ updateId: 6, userId: "9007199254740993", chatId: "-100", text: "Hi" });
  expect(
    normalizeTelegramUpdate({
      update_id: 7,
      message: { text: "Hi", from: { id: Number.MAX_SAFE_INTEGER + 1 }, chat: { id: "-100" } },
    }),
  ).toBeUndefined();
  expect(
    normalizeTelegramUpdate({
      update_id: 11,
      message: { text: "Hi", from: { id: -1 }, chat: { id: "-100" } },
    }),
  ).toBeUndefined();
  expect(
    normalizeTelegramUpdate({
      update_id: 8,
      message: { text: "Hi", chat: { id: "-100" } },
    }),
  ).toBeUndefined();
  expect(
    normalizeTelegramUpdate({
      update_id: 9,
      message: { text: "", from: { id: 1 }, chat: { id: 2 } },
    }),
  ).toBeUndefined();
  expect(normalizeTelegramUpdate({ update_id: 10 })).toBeUndefined();
});

it("talks to the Bot API with documented methods and string destinations", async () => {
  const calls: { url: string; body: Record<string, unknown>; signal: AbortSignal }[] = [];
  const results = [
    { ok: true, result: { id: 7, username: "test_bot" } },
    {
      ok: true,
      result: [
        { update_id: 1, message: { text: "Hi", from: { id: 42 }, chat: { id: -100 } } },
        { update_id: 2, message: { text: "No sender", chat: { id: -100 } } },
      ],
    },
    { ok: true, result: true },
  ];
  const fetchImpl: typeof globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(url), body, signal: init?.signal as AbortSignal });
    return new Response(JSON.stringify(results.shift()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const api = createTelegramApi({
    token: "offline-token",
    baseUrl: "https://telegram.test",
    fetch: fetchImpl,
  });
  const controller = new AbortController();
  expect(await api.getMe(controller.signal)).toEqual({ id: "7", username: "test_bot" });
  expect(await api.getUpdates(3, controller.signal)).toEqual([
    { updateId: 1, userId: "42", chatId: "-100", text: "Hi" },
  ]);
  await api.sendMessage("-1001234567890", "Reply", controller.signal);
  expect(calls.map((call) => call.url)).toEqual([
    "https://telegram.test/botoffline-token/getMe",
    "https://telegram.test/botoffline-token/getUpdates",
    "https://telegram.test/botoffline-token/sendMessage",
  ]);
  expect(calls[1].body).toEqual({ offset: 3, timeout: 30, allowed_updates: ["message"] });
  expect(calls[2].body).toEqual({ chat_id: "-1001234567890", text: "Reply" });
});

it("surfaces Bot API failures as startup-visible errors", async () => {
  const api = createTelegramApi({
    token: "bad-token",
    baseUrl: "https://telegram.test",
    fetch: async () =>
      new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
  });
  await expect(api.getMe(signal())).rejects.toThrow("Telegram getMe failed: Unauthorized");
});

it("routes an allowed message through the runtime and delivers the reply to its chat", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace(undefined, telegramSettings(["42"]));
  const { api, sends } = recordingApi();
  runtime = await EventRuntime.open({
    workspace,
    delivery: { transports: [telegramTransport(api)] },
  });
  const channel = new TelegramChannel({ api, runtime, allowedUserIds: ["42"] });

  const result = await channel.dispatch(update());
  expect(result).toMatchObject({ error: null, content: "Hello!" });
  await runtime.stop();

  expect(sends).toEqual([{ chatId: "-100", text: "Hello!" }]);
  expect(await runtime.getPendingReplies(result?.session_id as string)).toEqual([]);
});

it("delivers command observations to the originating chat without a durable reply", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace(undefined, telegramSettings([]));
  const { api, sends } = recordingApi();
  runtime = await EventRuntime.open({
    workspace,
    delivery: { transports: [telegramTransport(api)] },
  });
  const channel = new TelegramChannel({ api, runtime, allowedUserIds: [] });

  const result = await channel.dispatch(update({ text: "/help" }));
  expect(result).toMatchObject({ error: null });
  expect(result).not.toHaveProperty("reply_id");
  expect(sends).toEqual([{ chatId: "-100", text: expect.stringContaining("Available Commands") }]);
  expect(fixture.requests).toHaveLength(0);
});

it("enforces the allowlist including the empty-allowlist behavior", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace(undefined, telegramSettings(["42"]));
  const { api, sends } = recordingApi();
  runtime = await EventRuntime.open({
    workspace,
    delivery: { transports: [telegramTransport(api)] },
  });
  const blocked = new TelegramChannel({ api, runtime, allowedUserIds: ["42"] });
  expect(await blocked.dispatch(update({ userId: "7" }))).toBeUndefined();
  expect(fixture.requests).toHaveLength(0);

  const open = new TelegramChannel({ api, runtime, allowedUserIds: [] });
  await open.dispatch(update({ userId: "7", chatId: "-200" }));
  await runtime.stop();
  expect(sends).toEqual([{ chatId: "-200", text: "Hello!" }]);
});

it("keeps distinct sessions per user and chat and replies to the originating chat", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace(undefined, telegramSettings([]));
  const { api, sends } = recordingApi();
  runtime = await EventRuntime.open({
    workspace,
    delivery: { transports: [telegramTransport(api)] },
  });
  const channel = new TelegramChannel({ api, runtime, allowedUserIds: [] });

  const group = await channel.dispatch(update({ chatId: "-100" }));
  const otherUser = await channel.dispatch(update({ userId: "99", chatId: "-100" }));
  const privateChat = await channel.dispatch(update({ userId: "42", chatId: "500" }));
  expect(new Set([group?.session_id, otherUser?.session_id, privateChat?.session_id]).size).toBe(3);
  await runtime.stop();

  expect(sends).toEqual(
    expect.arrayContaining([
      { chatId: "-100", text: "Hello!" },
      { chatId: "500", text: "Hello!" },
    ]),
  );
  expect(sends).toHaveLength(3);
});

it("queues follow-ups in reception order while the first turn runs", async () => {
  fixture = await chatFixture();
  const held = Promise.withResolvers<unknown>();
  fixture.responses.push({ status: 200, body: held.promise });
  const workspace = await fixture.workspace(undefined, telegramSettings([]));
  const { api } = recordingApi();
  runtime = await EventRuntime.open({
    workspace,
    delivery: { transports: [telegramTransport(api)] },
  });
  const channel = new TelegramChannel({ api, runtime, allowedUserIds: [] });

  const first = channel.dispatch(update({ text: "First" }));
  const second = channel.dispatch(update({ updateId: 2, text: "Second" }));
  await vi.waitFor(() => expect(fixture?.requests).toHaveLength(1));
  held.resolve({ choices: [{ message: { role: "assistant", content: "First answer" } }] });
  await Promise.all([first, second]);
  expect(fixture.requests[1].messages.map((message) => message.content)).toEqual([
    "Give concise answers.",
    "First",
    "First answer",
    "Second",
  ]);
});

it("retries failed Telegram sends through the shared delivery path", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace(undefined, telegramSettings([]));
  let failures = 2;
  const sends: { chatId: string; text: string }[] = [];
  const api: TelegramApi = {
    async getMe() {
      return { id: "1" };
    },
    async getUpdates() {
      return [];
    },
    async sendMessage(chatId, text) {
      if (failures-- > 0) throw new Error("Telegram unavailable");
      sends.push({ chatId, text });
    },
  };
  runtime = await EventRuntime.open({
    workspace,
    delivery: { transports: [telegramTransport(api)], random: () => 0.5, wait: async () => {} },
  });
  const channel = new TelegramChannel({ api, runtime, allowedUserIds: [] });

  const result = await channel.dispatch(update());
  await runtime.stop();
  expect(sends).toEqual([{ chatId: "-100", text: "Hello!" }]);
  expect(await runtime.getPendingReplies(result?.session_id as string)).toEqual([]);
});

it("preserves a pending reply after platform failure and recovers on a fresh runtime", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace(undefined, telegramSettings([]));
  const failing = recordingApi({ failSends: true });
  runtime = await EventRuntime.open({
    workspace,
    delivery: {
      transports: [telegramTransport(failing.api)],
      random: () => 0.5,
      wait: async () => {},
    },
  });
  const channel = new TelegramChannel({ api: failing.api, runtime, allowedUserIds: [] });
  const result = await channel.dispatch(update());
  await runtime.stop();
  expect(await runtime.getPendingReplies(result?.session_id as string)).toMatchObject([
    { confirmedChunks: 0, failure: { attempts: 5, error: "Telegram unavailable" } },
  ]);

  const recovered = recordingApi();
  runtime = await EventRuntime.open({
    workspace,
    delivery: { transports: [telegramTransport(recovered.api)] },
  });
  await vi.waitFor(() => expect(recovered.sends).toEqual([{ chatId: "-100", text: "Hello!" }]));
  await runtime.stop();
  expect(await runtime.getPendingReplies(result?.session_id as string)).toEqual([]);
});

it("starts polling, dispatches updates, and aborts requests on stop", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace(undefined, telegramSettings([]));
  const { api, sends } = recordingApi();
  const started = Promise.withResolvers<void>();
  const signals: AbortSignal[] = [];
  const polling: TelegramApi = {
    ...api,
    async getUpdates(offset, pollSignal) {
      signals.push(pollSignal);
      if (offset === 0) {
        started.resolve();
        return [update()];
      }
      return await new Promise<TelegramUpdate[]>((_resolve, reject) => {
        const abort = () => reject(pollSignal.reason ?? new Error("aborted"));
        if (pollSignal.aborted) abort();
        else pollSignal.addEventListener("abort", abort, { once: true });
      });
    },
  };
  runtime = await EventRuntime.open({
    workspace,
    delivery: { transports: [telegramTransport(polling)] },
  });
  const channel = new TelegramChannel({
    api: polling,
    runtime,
    allowedUserIds: [],
    onError: () => {},
  });

  const running = channel.start();
  await started.promise;
  await vi.waitFor(() => expect(sends).toEqual([{ chatId: "-100", text: "Hello!" }]));
  await channel.stop();
  await expect(running).resolves.toBeUndefined();
  expect(signals.every((pollSignal) => pollSignal.aborted)).toBe(true);
});

it("resolves startup without Telegram enabled and without credentials", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const createApi = vi.fn();
  expect(await runBot(["--workspace", workspace], { createApi })).toBe(0);
  expect(createApi).not.toHaveBeenCalled();
  expect(log.mock.calls.flat().join("\n")).toContain("Telegram is disabled");
});

it("prints help without loading a workspace", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const createApi = vi.fn();
  expect(await runBot(["--help"], { createApi })).toBe(0);
  expect(createApi).not.toHaveBeenCalled();
  expect(log.mock.calls.flat().join("\n")).toContain("Usage: npm run start:bot");
});

it("reports a Telegram startup failure and does not poll", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace(undefined, telegramSettings([]));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const getUpdates = vi.fn();
  const createApi = vi.fn(() => ({
    async getMe() {
      throw new Error("Unauthorized");
    },
    getUpdates,
    async sendMessage() {},
  }));
  expect(await runBot(["--workspace", workspace], { createApi })).toBe(1);
  expect(getUpdates).not.toHaveBeenCalled();
  expect(error.mock.calls.flat().join("\n")).toContain("Unauthorized");
});

it("runs the bot lifecycle and shuts polling and the runtime down on abort", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace(undefined, telegramSettings([]));
  const { api, sends } = recordingApi();
  const started = Promise.withResolvers<void>();
  const signals: AbortSignal[] = [];
  let delivered = false;
  const polling: TelegramApi = {
    ...api,
    async getUpdates(_offset, pollSignal) {
      signals.push(pollSignal);
      if (!delivered) {
        delivered = true;
        started.resolve();
        return [update()];
      }
      return await new Promise<TelegramUpdate[]>((_resolve, reject) => {
        const abort = () => reject(pollSignal.reason ?? new Error("aborted"));
        if (pollSignal.aborted) abort();
        else pollSignal.addEventListener("abort", abort, { once: true });
      });
    },
  };
  const controller = new AbortController();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const running = runBot(["--workspace", workspace], {
    createApi: () => polling,
    signal: controller.signal,
  });
  await started.promise;
  await vi.waitFor(() => expect(sends).toEqual([{ chatId: "-100", text: "Hello!" }]));
  controller.abort();
  expect(await running).toBe(0);
  expect(signals.every((pollSignal) => pollSignal.aborted)).toBe(true);
  expect(log.mock.calls.flat().join("\n")).toContain("Telegram bot @test_bot is running");
});
