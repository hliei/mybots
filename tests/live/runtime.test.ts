import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { stringify } from "yaml";
import { TelegramChannel, telegramTransport } from "../../src/bot/telegram.ts";
import { createTelegramApi, type TelegramUpdate } from "../../src/bot/telegram-api.ts";
import { loadSettings, type WorkspaceSettings } from "../../src/config/workspace.ts";
import { parseEvent, type RuntimeEvent } from "../../src/core/events.ts";
import { ConversationHistory } from "../../src/core/history.ts";
import { EventRuntime } from "../../src/core/runtime.ts";
import { WebSocketInterface } from "../../src/websocket/interface.ts";

let root: string;
let source: WorkspaceSettings;
let runtime: EventRuntime | undefined;
let server: WebSocketInterface | undefined;
let channel: TelegramChannel | undefined;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  const { config, definition } = await loadSettings(
    resolve(process.env.MYBOTS_ACCEPTANCE_WORKSPACE ?? "workspace"),
  );
  source = config;
  root = await mkdtemp(join(tmpdir(), "mybots-runtime-live-"));
  await mkdir(join(root, ".agents/bots/acceptance"), { recursive: true });
  await writeFile(
    join(root, "config.user.yaml"),
    stringify({
      default_agent: "acceptance",
      llm: { ...definition.llm, thinking: true, max_tokens: 8192, context_window: 100_000 },
    }),
    { mode: 0o600 },
  );
  await writeFile(
    join(root, ".agents/bots/acceptance/AGENT.md"),
    "---\nname: Acceptance\n---\n\nFollow the user's requested tool and remember facts. Keep replies short. Never read configuration or credentials.\n",
  );
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await server?.stop();
  server = undefined;
  await channel?.stop();
  channel = undefined;
  await runtime?.stop({ graceMs: 0 });
  runtime = undefined;
  if (root) await rm(root, { recursive: true, force: true });
});

async function client(url: string) {
  const socket = new WebSocket(url);
  sockets.push(socket);
  const events: RuntimeEvent[] = [];
  socket.on("message", (data) => events.push(parseEvent(JSON.parse(data.toString()))));
  await once(socket, "open", { signal: AbortSignal.timeout(5000) });
  return { socket, events };
}

it("continues real DeepSeek tools over WebSocket with all-client broadcast and restart affinity", async () => {
  runtime = await EventRuntime.open({ workspace: root });
  server = new WebSocketInterface({ runtime, host: "127.0.0.1", port: 0 });
  const address = await server.start();
  const url = `ws://${address.host}:${address.port}${address.path}`;
  const sender = await client(url);
  const observer = await client(url);
  const marker = `FACT_${randomUUID()}`;
  sender.socket.send(
    JSON.stringify({
      source: "acceptance",
      content: `Remember ${marker}. Use bash to run exactly: printf TOOL_CONFIRMED. Reply with the fact and tool output.`,
    }),
  );
  await vi.waitFor(
    () => expect(observer.events.some((event) => event.type === "OutboundEvent")).toBe(true),
    { timeout: 120_000 },
  );
  const first = observer.events.find((event) => event.type === "OutboundEvent");
  expect(first?.error).toBeNull();
  expect(first?.content.includes(marker)).toBe(true);
  expect(first?.content.includes("TOOL_CONFIRMED")).toBe(true);
  await vi.waitFor(() => expect(sender.events.length).toBe(2));
  expect(sender.events).toEqual(observer.events);
  const sessionId = first?.session_id ?? "";
  await vi.waitFor(async () => expect(await runtime?.getPendingReplies(sessionId)).toEqual([]));
  const history = await ConversationHistory.open(join(root, ".history"));
  const original = await history.getMessages(sessionId);
  const call = original
    .flatMap((message) => message.tool_calls ?? [])
    .find((item) => item.function.name === "bash");
  expect(call).toBeDefined();
  expect(JSON.parse(call?.function.arguments ?? "{}")).toEqual({
    command: "printf TOOL_CONFIRMED",
  });
  expect(
    original.find((message) => message.tool_call_id === call?.id)?.content === "TOOL_CONFIRMED",
  ).toBe(true);
  expect(original.some((message) => (message.reasoning_content?.length ?? 0) > 0)).toBe(true);
  await server.stop();
  await runtime.stop();
  runtime = await EventRuntime.open({ workspace: root });
  server = new WebSocketInterface({ runtime, host: "127.0.0.1", port: 0 });
  const resumed = await server.start();
  const reconnected = await client(`ws://${resumed.host}:${resumed.port}${resumed.path}`);
  reconnected.socket.send(
    JSON.stringify({
      source: "acceptance",
      content: "Reply with only the remembered fact. Do not use tools.",
    }),
  );
  await vi.waitFor(() => expect(reconnected.events.length).toBe(2), { timeout: 120_000 });
  expect(reconnected.events[1]).toMatchObject({
    type: "OutboundEvent",
    session_id: sessionId,
    error: null,
  });
  expect(reconnected.events[1].content.includes(marker)).toBe(true);
  const recovered = await (await ConversationHistory.open(join(root, ".history"))).getMessages(
    sessionId,
  );
  expect(JSON.stringify(recovered.slice(0, original.length)) === JSON.stringify(original)).toBe(
    true,
  );
  console.log(
    "PASS: real model/tool continuation; original reasoning/results; two-client broadcast; reconnect after runtime restart retains source session.",
  );
});

it("receives actual Telegram input and delivers model replies across a runtime restart", async () => {
  const chatId = process.env.MYBOTS_ACCEPTANCE_TELEGRAM_CHAT_ID;
  const userId = process.env.MYBOTS_ACCEPTANCE_TELEGRAM_USER_ID;
  const token = source.channels.telegram?.bot_token;
  if (!token || !chatId || !/^-?\d+$/u.test(chatId) || !userId || !/^\d+$/u.test(userId)) {
    throw new Error(
      "Telegram acceptance incomplete: configure a bot token and explicit MYBOTS_ACCEPTANCE_TELEGRAM_CHAT_ID / MYBOTS_ACCEPTANCE_TELEGRAM_USER_ID. Stop other bot pollers before running.",
    );
  }
  const api = createTelegramApi({ token, pollTimeoutSeconds: 10 });
  const signal = AbortSignal.timeout(240_000);
  await api.getMe(signal);
  // Discard already queued updates; only new, explicitly marked test inputs qualify.
  let offset = (await api.getUpdates(0, signal)).nextOffset;
  const marker = `TG_${randomUUID()}`;
  async function receive(text: string): Promise<TelegramUpdate> {
    console.log(`Send this exact text to your test bot chat: ${text}`);
    while (true) {
      signal.throwIfAborted();
      const batch = await api.getUpdates(offset, signal);
      offset = batch.nextOffset;
      const update = batch.updates.find(
        (item) => item.chatId === chatId && item.userId === userId && item.text === text,
      );
      if (update) return update;
    }
  }
  async function start() {
    runtime = await EventRuntime.open({
      workspace: root,
      delivery: { transports: [telegramTransport(api)], ownedPlatforms: ["telegram"] },
    });
    channel = new TelegramChannel({ api, runtime, allowedUserIds: [userId ?? ""] });
  }
  await start();
  const first = await channel?.dispatch(await receive(`Remember ${marker}. Reply ACK only.`));
  expect(first?.type).toBe("OutboundEvent");
  if (first?.type !== "OutboundEvent") throw new Error("No Telegram reply.");
  expect(first.error).toBeNull();
  expect(first.content.includes("ACK")).toBe(true);
  await vi.waitFor(
    async () => expect(await runtime?.getPendingReplies(first.session_id)).toEqual([]),
    { timeout: 30_000 },
  );
  await channel?.stop();
  await runtime?.stop();
  await start();
  console.log("Runtime restarted; send the second checkpoint input now.");
  const second = await channel?.dispatch(
    await receive("Report only the fact I asked you to remember."),
  );
  expect(second?.session_id).toBe(first.session_id);
  if (second?.type !== "OutboundEvent") throw new Error("No resumed Telegram reply.");
  expect(second.error).toBeNull();
  expect(second.content.includes(marker)).toBe(true);
  await vi.waitFor(
    async () => expect(await runtime?.getPendingReplies(first.session_id)).toEqual([]),
    { timeout: 30_000 },
  );
  const sessions = await (await ConversationHistory.open(join(root, ".history"))).listSessions();
  expect(sessions).toHaveLength(1);
  expect(sessions[0].source === `platform-telegram:${userId}:${chatId}`).toBe(true);
  console.log(
    "PASS: actual Telegram input → DeepSeek → confirmed Telegram delivery; same source/session after runtime restart.",
  );
});
