import { expect, it } from "vitest";
import {
  createTelegramApi,
  normalizeTelegramUpdate,
  TelegramRequestError,
} from "../packages/host/src/channels/telegram-api.ts";

const signal = () => new AbortController().signal;

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
    { ok: true, result: { id: 7, username: "test_bot", has_topics_enabled: true } },
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
  expect(await api.getMe(controller.signal)).toEqual({
    id: "7",
    username: "test_bot",
    topicsEnabled: true,
  });
  expect(await api.getUpdates(0, controller.signal)).toEqual({
    updates: [{ updateId: 1, userId: "42", chatId: "-100", text: "Hi" }],
    nextOffset: 3,
  });
  await api.sendMessage("-1001234567890", "Reply", controller.signal);
  expect(calls.map((call) => call.url)).toEqual([
    "https://telegram.test/botoffline-token/getMe",
    "https://telegram.test/botoffline-token/getUpdates",
    "https://telegram.test/botoffline-token/sendMessage",
  ]);
  expect(calls[1].body).toEqual({
    offset: 0,
    timeout: 30,
    allowed_updates: ["message", "callback_query"],
  });
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

it("keeps topic ids and retry-after on the Bot API boundary and drops callbacks", async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const results = [
    {
      status: 200,
      body: {
        ok: true,
        result: [
          { update_id: 4, callback_query: { id: "cb", from: { id: 42 }, data: "approve" } },
          {
            update_id: 5,
            message: {
              text: "In topic",
              message_thread_id: 77,
              from: { id: 42 },
              chat: { id: 42 },
            },
          },
        ],
      },
    },
    { status: 200, body: { ok: true, result: { id: 42, type: "private", is_forum: true } } },
    { status: 200, body: { ok: true, result: { message_thread_id: 77, name: "Personal" } } },
    {
      status: 429,
      body: {
        ok: false,
        description: "Too Many Requests: retry after 9",
        parameters: { retry_after: 60 },
      },
    },
    { status: 400, body: { ok: false, description: "Bad Request: message thread not found" } },
    { status: 400, body: { ok: false, description: "Bad Request: the chat is not a forum" } },
    { status: 403, body: { ok: false, description: "Forbidden: bot was blocked by the user" } },
  ];
  const api = createTelegramApi({
    token: "offline-token",
    baseUrl: "https://telegram.test",
    fetch: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      const next = results.shift();
      if (!next) throw new Error("missing fixture");
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  expect(await api.getUpdates(4, signal())).toEqual({
    updates: [{ updateId: 5, userId: "42", chatId: "42", text: "In topic", threadId: "77" }],
    nextOffset: 6,
  });
  expect(await api.getChat("42", signal())).toEqual({ isForum: true });
  expect(await api.createForumTopic("42", "Personal", signal())).toEqual({ topicId: "77" });
  await expect(api.sendMessage("42", "Question", signal(), "77")).rejects.toMatchObject({
    retryAfterMs: 60000,
    kind: "retryable",
  });
  await expect(api.sendMessage("42", "Question", signal(), "77")).rejects.toBeInstanceOf(
    TelegramRequestError,
  );
  await expect(api.createForumTopic("42", "Personal", signal())).rejects.toMatchObject({
    kind: "topic-mode",
  });
  await expect(api.getChat("42", signal())).rejects.toMatchObject({ kind: "authority" });
  expect(calls[3]?.body).toEqual({ chat_id: "42", text: "Question", message_thread_id: 77 });
});
