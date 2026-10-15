import { expect, it } from "vitest";
import {
  createTelegramApi,
  normalizeTelegramUpdate,
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
  expect(calls[1].body).toEqual({ offset: 0, timeout: 30, allowed_updates: ["message"] });
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
