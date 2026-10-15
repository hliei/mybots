import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { runBot } from "../src/bot/startup.ts";
import { TelegramChannel, telegramTransport } from "../src/bot/telegram.ts";
import type { TelegramApi, TelegramPollResult } from "../src/channels/telegram-api.ts";
import { ConversationHistory } from "../src/core/history.ts";
import { EventRuntime } from "../src/core/runtime.ts";
import { type WebSocketAddress, WebSocketInterface } from "../src/websocket/interface.ts";
import { chatFixture, unavailableResponses } from "./chat-fixture.ts";

interface Client {
  socket: WebSocket;
  messages: Record<string, unknown>[];
  send(value: unknown): void;
  sendRaw(value: string): void;
  waitFor(
    predicate: (message: Record<string, unknown>) => boolean,
    description: string,
  ): Promise<Record<string, unknown>>;
  close(): Promise<void>;
  terminate(): void;
}

let fixture: Awaited<ReturnType<typeof chatFixture>> | undefined;
let runtime: EventRuntime | undefined;
let server: WebSocketInterface | undefined;
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    if (client.socket.readyState !== client.socket.CLOSED) client.socket.terminate();
  }
  await server?.stop();
  server = undefined;
  await runtime?.stop({ graceMs: 0 });
  runtime = undefined;
  await fixture?.close();
  fixture = undefined;
  vi.restoreAllMocks();
});

it("broadcasts inbound and outbound envelopes to every connected client", async () => {
  fixture = await chatFixture();
  runtime = await EventRuntime.open({ workspace: await fixture.workspace() });
  server = new WebSocketInterface({ runtime, host: "127.0.0.1", port: 0 });
  const address = await server.start();
  const alice = await openClient(address);
  const observer = await openClient(address);

  alice.send({ source: "alice", content: "Hello" });
  const inbound = await observer.waitFor((message) => message.type === "InboundEvent", "inbound");
  const outbound = await observer.waitFor(
    (message) => message.type === "OutboundEvent",
    "outbound",
  );

  expect(inbound).toMatchObject({
    type: "InboundEvent",
    source: "platform-ws:alice",
    content: "Hello",
    retry_count: 0,
  });
  expect(inbound.session_id).toEqual(expect.any(String));
  expect(inbound.timestamp).toBeGreaterThan(1_700_000_000);
  expect(inbound.timestamp).toBeLessThan(10_000_000_000);
  expect(outbound).toMatchObject({
    type: "OutboundEvent",
    session_id: inbound.session_id,
    source: "agent:helper",
    content: "Hello!",
    error: null,
    reply_id: expect.any(String),
  });
  expect(alice.messages).toEqual([inbound, outbound]);
  expect(fixture.requests).toHaveLength(1);
  await vi.waitFor(async () => {
    expect(await runtime?.getPendingReplies(inbound.session_id as string)).toEqual([]);
  });
});

it("orders Telegram follow-ups while WebSocket input continues in an isolated session", async () => {
  fixture = await chatFixture();
  const held = Promise.withResolvers<unknown>();
  const started = Promise.withResolvers<void>();
  fixture.server.once("request", () => started.resolve());
  fixture.responses.push({ status: 200, body: held.promise });
  const sends: string[] = [];
  const api: TelegramApi = {
    async getMe() {
      return { id: "1" };
    },
    async getUpdates(offset) {
      return { updates: [], nextOffset: offset };
    },
    async sendMessage(chatId, text) {
      sends.push(`${chatId}:${text}`);
    },
  };
  runtime = await EventRuntime.open({
    workspace: await fixture.workspace(),
    delivery: { transports: [telegramTransport(api)], ownedPlatforms: ["telegram"] },
  });
  const channel = new TelegramChannel({ api, runtime, allowedUserIds: ["42"] });
  server = new WebSocketInterface({ runtime, host: "127.0.0.1", port: 0 });
  const observer = await openClient(await server.start());
  const first = channel.dispatch({ updateId: 1, userId: "42", chatId: "-100", text: "First" });
  await started.promise;
  const next = channel.dispatch({ updateId: 2, userId: "42", chatId: "-100", text: "Follow-up" });
  try {
    observer.send({ source: "independent", content: "Other session" });
    const other = await observer.waitFor(
      (event) => event.type === "OutboundEvent",
      "independent reply",
    );
    expect(other).toMatchObject({ content: "Hello!", error: null });
    expect(sends).toEqual([]);
  } finally {
    held.resolve({ choices: [{ message: { role: "assistant", content: "First reply" } }] });
  }
  const firstResult = await first;
  const nextResult = await next;
  expect(nextResult?.session_id).toBe(firstResult?.session_id);
  await vi.waitFor(() => expect(sends).toEqual(["-100:First reply", "-100:Hello!"]));
  expect(fixture.requests.at(-1)?.messages.slice(-3)).toEqual([
    { role: "user", content: "First" },
    { role: "assistant", content: "First reply" },
    { role: "user", content: "Follow-up" },
  ]);
  await vi.waitFor(() =>
    expect(observer.messages.filter((event) => event.type === "OutboundEvent")).toHaveLength(3),
  );
  expect(
    new Set(
      observer.messages
        .filter((event) => event.type === "InboundEvent")
        .map((event) => event.session_id),
    ).size,
  ).toBe(2);
  await channel.stop();
});

it("observes another platform's reply without acknowledging it", async () => {
  fixture = await chatFixture();
  runtime = await EventRuntime.open({ workspace: await fixture.workspace() });
  server = new WebSocketInterface({ runtime, host: "127.0.0.1", port: 0 });
  const observer = await openClient(await server.start());

  const result = await runtime.submit({ source: "platform-telegram:1:2", content: "Hi" });
  const outbound = await observer.waitFor((message) => message.type === "OutboundEvent", "reply");
  expect(outbound).toMatchObject({
    session_id: result.session_id,
    content: "Hello!",
    error: null,
  });
  expect(await runtime.getPendingReplies(result.session_id)).toEqual([
    expect.objectContaining({ destination: "platform-telegram:1:2" }),
  ]);
});

it("keeps an unobserved reply pending and never replays it to a later connection", async () => {
  fixture = await chatFixture();
  runtime = await EventRuntime.open({ workspace: await fixture.workspace() });
  server = new WebSocketInterface({ runtime, host: "127.0.0.1", port: 0 });
  const address = await server.start();

  const result = await runtime.submit({ source: "platform-ws:alice", content: "Unobserved" });
  const [unobserved] = await runtime.getPendingReplies(result.session_id);
  expect(unobserved).toMatchObject({ payload: "Hello!", destination: "platform-ws:alice" });

  const late = await openClient(address);
  expect(late.messages).toEqual([]);
  late.send({ source: "alice", content: "Observed" });
  const delivered = await late.waitFor(
    (message) => message.type === "OutboundEvent" && message.content === "Hello!",
    "new reply",
  );
  expect(delivered.reply_id).not.toBe(unobserved.replyId);
  await vi.waitFor(async () => {
    const pending = await runtime?.getPendingReplies(result.session_id);
    expect(pending).toEqual([expect.objectContaining({ replyId: unobserved.replyId })]);
  });
});

it("broadcasts a rejected turn as an error envelope without a pending reply", async () => {
  fixture = await chatFixture();
  fixture.responses.push(...unavailableResponses());
  runtime = await EventRuntime.open({ workspace: await fixture.workspace() });
  server = new WebSocketInterface({ runtime, host: "127.0.0.1", port: 0 });
  const client = await openClient(await server.start());

  client.send({ source: "alice", content: "Fail" });
  const outbound = await client.waitFor((message) => message.type === "OutboundEvent", "error");
  expect(outbound).toMatchObject({ content: "", error: expect.stringContaining("HTTP 503") });
  expect(outbound).not.toHaveProperty("reply_id");
  expect(await runtime.getPendingReplies(outbound.session_id as string)).toEqual([]);
});

it("answers plain HTTP requests with upgrade and not-found statuses", async () => {
  fixture = await chatFixture();
  runtime = await EventRuntime.open({ workspace: await fixture.workspace() });
  server = new WebSocketInterface({ runtime, host: "127.0.0.1", port: 0 });
  const address = await server.start();
  const base = `http://${address.host}:${address.port}`;

  expect((await fetch(`${base}${address.path}`)).status).toBe(426);
  expect((await fetch(`${base}/other`)).status).toBe(404);
});

it("retains session identity and reuses the saved summary after reconnect", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  runtime = await EventRuntime.open({ workspace });
  server = new WebSocketInterface({ runtime, host: "127.0.0.1", port: 0 });
  const firstAddress = await server.start();
  const first = await openClient(firstAddress);
  first.send({ source: "alice:device", content: "Old conversation" });
  const firstReply = await first.waitFor(
    (message) => message.type === "OutboundEvent",
    "first reply",
  );
  const sessionId = firstReply.session_id as string;
  await first.close();
  await server.stop();
  await runtime.stop();
  server = undefined;
  runtime = undefined;

  const history = await ConversationHistory.open(join(workspace, ".history"));
  await history.saveCompaction(sessionId, "Exact saved summary.\n", undefined);

  runtime = await EventRuntime.open({ workspace });
  server = new WebSocketInterface({ runtime, host: "127.0.0.1", port: 0 });
  const address = await server.start();
  const reconnected = await openClient(address);
  reconnected.send({ source: "alice:device", content: "Continue" });
  const second = await reconnected.waitFor(
    (message) => message.type === "OutboundEvent" && message.content === "Hello!",
    "second reply",
  );

  expect(second.session_id).toBe(sessionId);
  expect(fixture.requests).toHaveLength(2);
  expect(fixture.requests[1].messages).toEqual([
    { role: "system", content: "Give concise answers." },
    {
      role: "user",
      content:
        "The conversation history before this point was compacted into the following summary:\n\n<summary>\nExact saved summary.\n\n</summary>",
    },
    { role: "user", content: "Continue" },
  ]);
});

it("returns a clear error for malformed input and keeps the connection usable", async () => {
  fixture = await chatFixture();
  runtime = await EventRuntime.open({ workspace: await fixture.workspace() });
  server = new WebSocketInterface({ runtime, host: "127.0.0.1", port: 0 });
  const client = await openClient(await server.start());

  client.sendRaw("not json");
  expect(await client.waitFor((message) => message.type === "error", "json error")).toMatchObject({
    type: "error",
    message: expect.stringContaining("JSON"),
  });

  client.send({ source: "", content: "Hello" });
  expect(
    await client.waitFor(
      (message) => message.type === "error" && /source/u.test(String(message.message)),
      "source error",
    ),
  ).toMatchObject({ type: "error" });

  client.send({ source: "alice" });
  expect(
    await client.waitFor(
      (message) => message.type === "error" && /content/u.test(String(message.message)),
      "content error",
    ),
  ).toMatchObject({ type: "error" });

  client.send({ source: "alice", content: "Agent", agent_id: 7 });
  expect(
    await client.waitFor(
      (message) => message.type === "error" && /agent_id/u.test(String(message.message)),
      "agent error",
    ),
  ).toMatchObject({ type: "error" });

  expect(fixture.requests).toHaveLength(0);
  client.send({ source: "alice", content: "Hello" });
  const outbound = await client.waitFor(
    (message) => message.type === "OutboundEvent",
    "valid reply",
  );
  expect(outbound).toMatchObject({ content: "Hello!", error: null });
  expect(fixture.requests).toHaveLength(1);
});

it("honors Agent selection for a new binding and rejects a conflicting selection", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  await mkdir(join(workspace, ".agents/bots/other"));
  await writeFile(
    join(workspace, ".agents/bots/other/AGENT.md"),
    "---\nname: Other\n---\nOther instructions.\n",
  );
  runtime = await EventRuntime.open({ workspace });
  server = new WebSocketInterface({ runtime, host: "127.0.0.1", port: 0 });
  const client = await openClient(await server.start());

  client.send({ source: "chosen", content: "Hi", agent_id: "other" });
  const chosen = await client.waitFor(
    (message) => message.type === "OutboundEvent",
    "selected Agent reply",
  );
  expect(chosen).toMatchObject({ source: "agent:other", error: null });

  client.send({ source: "chosen", content: "Switch", agent_id: "helper" });
  expect(
    await client.waitFor(
      (message) => message.type === "error" && /Agent/u.test(String(message.message)),
      "Agent conflict error",
    ),
  ).toMatchObject({ type: "error" });

  client.send({ source: "chosen", content: "Again" });
  const continued = await client.waitFor(
    (message) =>
      message.type === "OutboundEvent" && (message.session_id as string) === chosen.session_id,
    "continued reply",
  );
  expect(continued).toMatchObject({ source: "agent:other" });
});

it("exposes no outbound reply before its completion commit", async () => {
  fixture = await chatFixture();
  runtime = await EventRuntime.open({ workspace: await fixture.workspace() });
  server = new WebSocketInterface({ runtime, host: "127.0.0.1", port: 0 });
  const client = await openClient(await server.start());
  const started = Promise.withResolvers<void>();
  const held = Promise.withResolvers<unknown>();
  fixture.server.once("request", () => started.resolve());
  fixture.responses.push({ status: 200, body: held.promise });

  client.send({ source: "alice", content: "Held" });
  await client.waitFor((message) => message.type === "InboundEvent", "inbound echo");
  await started.promise;
  // The model request is unresolved, so no completion commit exists yet.
  expect(client.messages.filter((message) => message.type === "OutboundEvent")).toEqual([]);
  expect(await runtime.getPendingReplies(client.messages[0].session_id as string)).toEqual([]);

  held.resolve({ choices: [{ message: { role: "assistant", content: "Committed" } }] });
  const outbound = await client.waitFor(
    (message) => message.type === "OutboundEvent",
    "committed reply",
  );
  expect(outbound).toMatchObject({ content: "Committed", error: null });
});

it("drops a disconnected peer without disturbing other clients or sessions", async () => {
  fixture = await chatFixture();
  fixture.responses.push(
    { status: 200, body: { choices: [{ message: { role: "assistant", content: "First" } }] } },
    { status: 200, body: { choices: [{ message: { role: "assistant", content: "Second" } }] } },
  );
  runtime = await EventRuntime.open({ workspace: await fixture.workspace() });
  server = new WebSocketInterface({ runtime, host: "127.0.0.1", port: 0 });
  const address = await server.start();
  const departed = await openClient(address);
  const present = await openClient(address);
  departed.terminate();
  await vi.waitFor(() => {
    expect(server?.clientCount).toBe(1);
  });

  present.send({ source: "alice", content: "First" });
  await present.waitFor(
    (message) => message.type === "OutboundEvent" && message.content === "First",
    "first reply",
  );
  present.send({ source: "bob", content: "Second" });
  const second = await present.waitFor(
    (message) => message.type === "OutboundEvent" && message.content === "Second",
    "second reply",
  );
  expect(runtime.subscriberFailures).toEqual([]);
  expect(second.error).toBeNull();
  expect(server.clientCount).toBe(1);
});

it("drops a saturated peer without delaying another client's reply", async () => {
  fixture = await chatFixture();
  const payload = "x".repeat(8_000_000);
  fixture.responses.push({
    status: 200,
    body: { choices: [{ message: { role: "assistant", content: payload } }] },
  });
  runtime = await EventRuntime.open({ workspace: await fixture.workspace() });
  server = new WebSocketInterface({ runtime, host: "127.0.0.1", port: 0, sendTimeoutMs: 100 });
  const address = await server.start();
  const slow = await openClient(address);
  const fast = await openClient(address);
  slow.socket.pause();

  fast.send({ source: "alice", content: "Big" });
  const outbound = await fast.waitFor((message) => message.type === "OutboundEvent", "reply");
  expect((outbound.content as string).length).toBe(8_000_000);
  await vi.waitFor(() => {
    expect(server?.clientCount).toBe(1);
  });
  expect(runtime.subscriberFailures).toEqual([]);
});

it("closes the listener and clients and cancels in-flight work on shutdown", async () => {
  fixture = await chatFixture();
  runtime = await EventRuntime.open({ workspace: await fixture.workspace() });
  server = new WebSocketInterface({ runtime, host: "127.0.0.1", port: 0 });
  const address = await server.start();
  const client = await openClient(address);
  const started = Promise.withResolvers<void>();
  const held = Promise.withResolvers<unknown>();
  fixture.server.once("request", () => started.resolve());
  fixture.responses.push({ status: 200, body: held.promise });
  client.send({ source: "alice", content: "Held" });
  await started.promise;

  const closed = once(client.socket, "close");
  await server.stop();
  await closed;
  server = undefined;
  await expect(tryConnect(address)).rejects.toThrow();

  const stopping = runtime.stop({ graceMs: 0 });
  held.resolve({ choices: [{ message: { role: "assistant", content: "Late" } }] });
  await stopping;
  expect(client.messages.filter((message) => message.type === "OutboundEvent")).toEqual([]);
  expect(fixture.requests).toHaveLength(1);
});

it("serves only the configured path", async () => {
  fixture = await chatFixture();
  runtime = await EventRuntime.open({ workspace: await fixture.workspace() });
  server = new WebSocketInterface({ runtime, host: "127.0.0.1", port: 0 });
  const address = await server.start();
  expect(address.path).toBe("/ws");
  await expect(tryConnect({ ...address, path: "/other" })).rejects.toThrow();
  const client = await openClient(address);
  expect(client.socket.readyState).toBe(client.socket.OPEN);
});

it("bounds client cleanup when a peer never completes the close handshake", async () => {
  fixture = await chatFixture();
  runtime = await EventRuntime.open({ workspace: await fixture.workspace() });
  server = new WebSocketInterface({ runtime, host: "127.0.0.1", port: 0, sendTimeoutMs: 50 });
  const address = await server.start();
  const stalled = await openClient(address);
  stalled.socket.pause();

  await server.stop();
  server = undefined;
  await expect(tryConnect(address)).rejects.toThrow();
});

it("serves the bot entry with the WebSocket interface enabled and Telegram disabled", async () => {
  fixture = await chatFixture();
  const port = await freePort();
  const workspace = await fixture.workspace(
    fixture.root,
    `api:\n  enabled: true\n  host: 127.0.0.1\n  port: ${port}\nchannels:\n  enabled: false\n`,
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
  const controller = new AbortController();
  const listening = Promise.withResolvers<WebSocketAddress>();
  const bot = runBot(["--workspace", workspace], {
    signal: controller.signal,
    onListening: (bound) => listening.resolve(bound),
  });
  const address = await listening.promise;
  expect(address).toEqual({ host: "127.0.0.1", port, path: "/ws" });

  const client = await openClient(address);
  client.send({ source: "entry", content: "Hello" });
  const outbound = await client.waitFor((message) => message.type === "OutboundEvent", "reply");
  expect(outbound).toMatchObject({ source: "agent:helper", content: "Hello!", error: null });
  controller.abort();
  expect(await bot).toBe(0);
});

it("reports a disabled interface without opening a listener", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace(fixture.root, "api:\n  enabled: false\n");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const controller = new AbortController();
  expect(await runBot(["--workspace", workspace], { signal: controller.signal })).toBe(0);
  expect(log).toHaveBeenCalledWith(expect.stringContaining("disabled"));
});

async function openClient(address: WebSocketAddress, path = address.path): Promise<Client> {
  const socket = await tryConnect({ ...address, path });
  const messages: Record<string, unknown>[] = [];
  const waiters: {
    predicate: (message: Record<string, unknown>) => boolean;
    resolve: (message: Record<string, unknown>) => void;
    timer: NodeJS.Timeout;
  }[] = [];
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as Record<string, unknown>;
    messages.push(message);
    for (let index = waiters.length - 1; index >= 0; index--) {
      if (waiters[index].predicate(message)) {
        const [waiter] = waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  });
  const client: Client = {
    socket,
    messages,
    send: (value) => socket.send(JSON.stringify(value)),
    sendRaw: (value) => socket.send(value),
    waitFor: (predicate, description) => {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`Timed out waiting for ${description}.`));
        }, 3000);
        waiters.push({ predicate, resolve, timer });
      });
    },
    close: async () => {
      if (socket.readyState === socket.CLOSED) return;
      const closed = once(socket, "close");
      socket.close();
      await closed;
    },
    terminate: () => socket.terminate(),
  };
  clients.push(client);
  return client;
}

function tryConnect(address: WebSocketAddress): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(`ws://${address.host}:${address.port}${address.path}`);
    const onOpen = () => {
      socket.removeListener("error", onError);
      resolve(socket);
    };
    const onError = (error: Error) => {
      socket.removeListener("open", onOpen);
      reject(error);
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
  });
}

async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

it("rejects new connections as soon as shutdown starts", async () => {
  fixture = await chatFixture();
  runtime = await EventRuntime.open({ workspace: await fixture.workspace() });
  server = new WebSocketInterface({ runtime, host: "127.0.0.1", port: 0, sendTimeoutMs: 100 });
  const address = await server.start();
  const stalled = await openClient(address);
  stalled.socket.pause();
  const stopping = server.stop();
  let newcomer: WebSocket | undefined;
  try {
    await expect(
      tryConnect(address).then((socket) => {
        newcomer = socket;
      }),
    ).rejects.toThrow();
  } finally {
    newcomer?.terminate();
    await stopping;
  }
});

it("closes incomplete HTTP connections during shutdown", async () => {
  fixture = await chatFixture();
  runtime = await EventRuntime.open({ workspace: await fixture.workspace() });
  server = new WebSocketInterface({ runtime, host: "127.0.0.1", port: 0, sendTimeoutMs: 10 });
  const address = await server.start();
  const socket = connect(address.port, address.host);
  await once(socket, "connect");
  const response = once(socket, "data");
  socket.write(
    "GET /other HTTP/1.1\r\nHost: localhost\r\n\r\nGET /ws HTTP/1.1\r\nHost: localhost\r\n",
  );
  expect((await response)[0].toString()).toContain("404");
  // A connected TCP peer with unfinished headers never reaches the HTTP handler.
  const stopping = server.stop();
  const timeout = AbortSignal.timeout(250);
  try {
    await expect(
      Promise.race([
        stopping,
        new Promise<void>((_resolve, reject) =>
          timeout.addEventListener("abort", () => reject(new Error("Shutdown timed out")), {
            once: true,
          }),
        ),
      ]),
    ).resolves.toBeUndefined();
  } finally {
    socket.destroy();
    await stopping;
  }
});

it("reports a busy bind port through bot startup without an unhandled server error", async () => {
  fixture = await chatFixture();
  const port = (fixture.server.address() as AddressInfo).port;
  const workspace = await fixture.workspace(
    fixture.root,
    `api:\n  enabled: true\n  host: 127.0.0.1\n  port: ${port}\n`,
  );
  const child = spawn(process.execPath, ["src/server.ts", "--workspace", workspace], {
    timeout: 5000,
  });
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr += data.toString();
  });
  const [code] = await once(child, "close");
  expect(code).toBe(1);
  expect(stderr).toContain("Error: listen EADDRINUSE");
  expect(stderr).not.toContain("Unhandled 'error' event");
});

it("runs Telegram and WebSocket together through one bot runtime and stops both", async () => {
  fixture = await chatFixture();
  const port = await freePort();
  const workspace = await fixture.workspace(
    fixture.root,
    `api:\n  enabled: true\n  host: 127.0.0.1\n  port: ${port}\nchannels:\n  enabled: true\n  telegram:\n    enabled: true\n    bot_token: offline-token\n    allowed_user_ids: []\n`,
  );
  const updates = Promise.withResolvers<TelegramPollResult>();
  const sends: { chatId: string; text: string }[] = [];
  const signals: AbortSignal[] = [];
  const api: TelegramApi = {
    async getMe() {
      return { id: "1" };
    },
    async getUpdates(offset, signal) {
      signals.push(signal);
      if (offset === 0) return updates.promise;
      return new Promise<TelegramPollResult>((_resolve, reject) => {
        const abort = () => reject(signal.reason);
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    },
    async sendMessage(chatId, text) {
      sends.push({ chatId, text });
    },
  };
  vi.spyOn(console, "log").mockImplementation(() => {});
  const controller = new AbortController();
  const listening = Promise.withResolvers<WebSocketAddress>();
  const bot = runBot(["--workspace", workspace], {
    createApi: () => api,
    signal: controller.signal,
    onListening: (bound) => listening.resolve(bound),
  });
  try {
    const client = await openClient(await listening.promise);
    client.send({ source: "web", content: "WebSocket input" });
    const webReply = await client.waitFor(
      (message) => message.type === "OutboundEvent",
      "WebSocket reply",
    );
    updates.resolve({
      updates: [{ updateId: 1, userId: "42", chatId: "-100", text: "Telegram input" }],
      nextOffset: 2,
    });
    const telegramInput = await client.waitFor(
      (message) =>
        message.type === "InboundEvent" && message.source === "platform-telegram:42:-100",
      "Telegram observation",
    );
    await client.waitFor(
      (message) =>
        message.type === "OutboundEvent" && message.session_id === telegramInput.session_id,
      "Telegram reply observation",
    );
    expect(webReply.session_id).not.toBe(telegramInput.session_id);
    await vi.waitFor(() => expect(sends).toEqual([{ chatId: "-100", text: "Hello!" }]));
    const history = await ConversationHistory.open(join(workspace, ".history"));
    await vi.waitFor(async () => {
      expect(await history.getPendingReplies(webReply.session_id as string)).toEqual([]);
      expect(await history.getPendingReplies(telegramInput.session_id as string)).toEqual([]);
    });
    expect(fixture.requests).toHaveLength(2);
    const log = await readFile(
      join(workspace, ".history", "sessions", `${webReply.session_id}.jsonl`),
      "utf8",
    );
    expect(
      log
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line).type),
    ).not.toContain("reply_failed");
  } finally {
    controller.abort();
    updates.resolve({ updates: [], nextOffset: 0 });
    expect(await bot).toBe(0);
  }
  expect(signals.length).toBeGreaterThan(0);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  await expect(tryConnect({ host: "127.0.0.1", port, path: "/ws" })).rejects.toThrow();
});
