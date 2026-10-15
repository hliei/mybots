import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { WebSocketChannel, type WebSocketChannelAddress } from "../src/channels/websocket.ts";
import { Host, type HostConfiguration } from "../src/host.ts";
import { waitForCheckpoint } from "./checkpoint.ts";
import { MailboxDriver } from "./host-fixture.ts";

const configuration: HostConfiguration = {
  owner: "local:owner",
  agent: {
    id: "personal",
    name: "Personal",
    folder: "personal",
    model: {
      provider: "deepseek",
      id: "deepseek-chat",
      baseUrl: "https://api.deepseek.com",
      contextWindow: 128000,
      maxTokens: 4096,
    },
  },
  destinations: [
    { id: "terminal", channelType: "cli", platformId: "local", instance: "cli" },
    { id: "desktop", channelType: "websocket", platformId: "desktop", instance: "ws" },
  ],
};

interface Client {
  socket: WebSocket;
  messages: Record<string, unknown>[];
  send(value: unknown): void;
  sendRaw(value: string): void;
  waitFor(
    predicate: (message: Record<string, unknown>) => boolean,
    description: string,
  ): Promise<Record<string, unknown>>;
  terminate(): void;
}

let root: string | undefined;
let host: Host | undefined;
let channel: WebSocketChannel | undefined;
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    if (client.socket.readyState !== client.socket.CLOSED) client.socket.terminate();
  }
  await channel?.close();
  channel = undefined;
  await host?.stop();
  host = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

it("submits local input and receives correlated inbound and outbound envelopes", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-ws-")));
  const driver = new MailboxDriver();
  host = await Host.start({ root, configuration, driver });
  channel = await WebSocketChannel.listen({ host, configuration, port: 0 });
  const client = await openClient(channel.address);

  client.send({ type: "input", destination: "desktop", content: "Remember Alice" });
  const inbound = await client.waitFor((message) => message.type === "inbound", "inbound");
  const outbound = await client.waitFor((message) => message.type === "outbound", "outbound");

  expect(inbound).toMatchObject({
    type: "inbound",
    session_id: expect.any(String),
    message_id: expect.any(String),
    destination: "desktop",
    channel_type: "websocket",
    platform_id: "desktop",
    thread_id: null,
    content: "Remember Alice",
    timestamp: expect.stringMatching(/^\d{4}-/u),
  });
  expect(outbound).toMatchObject({
    type: "outbound",
    session_id: inbound.session_id,
    message_id: expect.any(String),
    in_reply_to: inbound.message_id,
    destination: "desktop",
    channel_type: "websocket",
    platform_id: "desktop",
    thread_id: null,
    kind: "message",
    content: "Reply: Remember Alice",
  });
  expect(host.sessions()).toEqual([
    expect.objectContaining({
      id: inbound.session_id,
      agent_group_id: "personal",
      messaging_group_id: "desktop",
    }),
  ]);
  expect((await host.inspect(inbound.session_id as string)).deliveries).toEqual([
    expect.objectContaining({ id: outbound.message_id, status: "delivered" }),
  ]);
});

it("rejects malformed or unconfigured input without creating host work", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-ws-")));
  const driver = new MailboxDriver();
  host = await Host.start({ root, configuration, driver });
  channel = await WebSocketChannel.listen({ host, configuration, port: 0 });
  const client = await openClient(channel.address);

  client.sendRaw("not json");
  expect(await client.waitFor((message) => message.type === "error", "json error")).toMatchObject({
    type: "error",
    message: expect.stringContaining("JSON"),
  });
  client.send({ type: "input", destination: "desktop", content: "   " });
  expect(
    await client.waitFor(
      (message) => message.type === "error" && /content/u.test(String(message.message)),
      "content error",
    ),
  ).toMatchObject({ type: "error" });
  client.send({ type: "input", destination: "missing", content: "Hello" });
  expect(
    await client.waitFor(
      (message) => message.type === "error" && /destination/u.test(String(message.message)),
      "destination error",
    ),
  ).toMatchObject({ type: "error" });
  client.send({ type: "message", destination: "desktop", content: "Hello" });
  expect(
    await client.waitFor(
      (message) => message.type === "error" && /type/u.test(String(message.message)),
      "frame type error",
    ),
  ).toMatchObject({ type: "error" });
  client.send({ destination: "desktop", content: "Hello" });
  expect(
    await client.waitFor(
      (message) => message.type === "error" && /type/u.test(String(message.message)),
      "missing type error",
    ),
  ).toMatchObject({ type: "error" });
  client.socket.send(Buffer.from("binary"));
  expect(
    await client.waitFor(
      (message) => message.type === "error" && /text frame/u.test(String(message.message)),
      "binary frame error",
    ),
  ).toMatchObject({ type: "error" });

  expect(host.sessions()).toHaveLength(0);
  expect(driver.launches).toHaveLength(0);

  client.send({ type: "input", destination: "desktop", content: "Hello" });
  const outbound = await client.waitFor((message) => message.type === "outbound", "valid reply");
  expect(outbound).toMatchObject({ content: "Reply: Hello" });
});

it("keeps WebSocket and CLI conversations separate while sharing the Agent workspace", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-ws-")));
  const driver = new MailboxDriver();
  host = await Host.start({ root, configuration, driver });
  channel = await WebSocketChannel.listen({ host, configuration, port: 0 });
  const client = await openClient(channel.address);
  const cliReplies: string[] = [];
  host.attachChannel({
    channelType: "cli",
    instance: "cli",
    async deliver(message) {
      cliReplies.push(message.content);
    },
  });

  const viaCli = await host.accept({
    destinationId: "terminal",
    userId: "local:owner",
    text: "From the terminal",
  });
  client.send({ type: "input", destination: "desktop", content: "From the desktop" });
  const inbound = await client.waitFor(
    (message) => message.type === "inbound" && message.content === "From the desktop",
    "desktop inbound",
  );

  expect(inbound.session_id).not.toBe(viaCli.sessionId);
  expect(host.sessions()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: viaCli.sessionId, agent_group_id: "personal" }),
      expect.objectContaining({ id: inbound.session_id, agent_group_id: "personal" }),
    ]),
  );
  expect(driver.launches.map((launch) => launch.material.workspace)).toEqual([
    join(root, "groups", "personal"),
    join(root, "groups", "personal"),
  ]);
  expect(driver.launches[0].material.directory).not.toBe(driver.launches[1].material.directory);
  await vi.waitFor(() => expect(cliReplies).toEqual(["Reply: From the terminal"]));
});

it("observes another channel's output without acknowledging its delivery", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-ws-")));
  const observedConfiguration: HostConfiguration = {
    ...configuration,
    destinations: [
      ...configuration.destinations,
      { id: "chat", channelType: "telegram", platformId: "42", instance: "telegram" },
    ],
  };
  const driver = new MailboxDriver();
  host = await Host.start({ root, configuration: observedConfiguration, driver });
  const running = host;
  channel = await WebSocketChannel.listen({ host, configuration: observedConfiguration, port: 0 });
  const observer = await openClient(channel.address);
  const started = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  const delivered: string[] = [];
  host.attachChannel({
    channelType: "telegram",
    instance: "telegram",
    async deliver(message, signal) {
      started.resolve();
      const release = () => held.resolve();
      signal.addEventListener("abort", release, { once: true });
      try {
        await held.promise;
      } finally {
        signal.removeEventListener("abort", release);
      }
      delivered.push(message.content);
    },
  });

  const accepted = await host.accept({
    destinationId: "chat",
    userId: "local:owner",
    text: "Telegram input",
  });
  await waitForCheckpoint(started.promise, "held Telegram delivery");
  const inbound = await observer.waitFor(
    (message) => message.type === "inbound" && message.content === "Telegram input",
    "Telegram inbound observation",
  );
  const outbound = await observer.waitFor(
    (message) => message.type === "outbound",
    "Telegram outbound observation",
  );
  expect(inbound).toMatchObject({
    destination: "chat",
    channel_type: "telegram",
    platform_id: "42",
  });
  expect(outbound).toMatchObject({
    session_id: accepted.sessionId,
    destination: "chat",
    channel_type: "telegram",
    platform_id: "42",
    content: "Reply: Telegram input",
  });
  expect((await host.inspect(accepted.sessionId)).deliveries).toEqual([
    expect.objectContaining({ id: outbound.message_id, status: undefined }),
  ]);

  held.resolve();
  await vi.waitFor(() => expect(delivered).toEqual(["Reply: Telegram input"]));
  await vi.waitFor(async () =>
    expect((await running.inspect(accepted.sessionId)).deliveries).toEqual([
      expect.objectContaining({ id: outbound.message_id, status: "delivered" }),
    ]),
  );
  expect(
    observer.messages.filter(
      (message) => message.type === "outbound" && message.message_id === outbound.message_id,
    ),
  ).toHaveLength(1);
});

it("drops a slow peer without blocking another client or session execution", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-ws-")));
  const driver = new MailboxDriver();
  const payload = "x".repeat(8_000_000);
  driver.respond = async (input) => (input.content === "Big" ? payload : `Reply: ${input.content}`);
  host = await Host.start({ root, configuration, driver });
  channel = await WebSocketChannel.listen({
    host,
    configuration,
    port: 0,
    sendTimeoutMs: 100,
  });
  const slow = await openClient(channel.address);
  const fast = await openClient(channel.address);
  slow.socket.pause();

  fast.send({ type: "input", destination: "desktop", content: "Big" });
  const outbound = await fast.waitFor((message) => message.type === "outbound", "big reply");
  expect(String(outbound.content)).toHaveLength(8_000_000);
  await vi.waitFor(() => expect(channel?.clientCount).toBe(1));

  fast.send({ type: "input", destination: "desktop", content: "After" });
  const next = await fast.waitFor(
    (message) => message.type === "outbound" && message.content === "Reply: After",
    "next reply",
  );
  expect(next.session_id).toBe(outbound.session_id);
  expect(channel.clientCount).toBe(1);
});

it("reconnects to the same conversation without replaying delivered events", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-ws-")));
  const driver = new MailboxDriver();
  host = await Host.start({ root, configuration, driver });
  const running = host;
  channel = await WebSocketChannel.listen({ host, configuration, port: 0 });
  const first = await openClient(channel.address);

  first.send({ type: "input", destination: "desktop", content: "Old conversation" });
  const firstInbound = await first.waitFor(
    (message) => message.type === "inbound",
    "first inbound",
  );
  const firstOutbound = await first.waitFor(
    (message) => message.type === "outbound",
    "first outbound",
  );
  const sessionId = firstOutbound.session_id;
  await vi.waitFor(async () =>
    expect((await running.inspect(sessionId as string)).deliveries).toEqual([
      expect.objectContaining({ status: "delivered" }),
    ]),
  );
  first.terminate();
  await vi.waitFor(() => expect(channel?.clientCount).toBe(0));

  const reconnected = await openClient(channel.address);
  reconnected.send({ type: "input", destination: "desktop", content: "Continue" });
  const nextInbound = await reconnected.waitFor(
    (message) => message.type === "inbound" && message.content === "Continue",
    "next inbound",
  );
  const nextOutbound = await reconnected.waitFor(
    (message) => message.type === "outbound" && message.content === "Reply: Continue",
    "next outbound",
  );
  expect(nextInbound.session_id).toBe(sessionId);
  expect(nextOutbound.session_id).toBe(sessionId);
  expect(
    reconnected.messages.filter((message) => message.message_id === firstOutbound.message_id),
  ).toEqual([]);
  expect(firstInbound.session_id).toBe(sessionId);
});

it("closes clients and admission within a bounded shutdown", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-ws-")));
  const driver = new MailboxDriver();
  host = await Host.start({ root, configuration, driver });
  channel = await WebSocketChannel.listen({
    host,
    configuration,
    port: 0,
    sendTimeoutMs: 50,
  });
  const address = channel.address;
  const client = await openClient(address);
  const stalled = await openClient(address);
  stalled.socket.pause();
  const closed = connectionClosed(client.socket);

  const stopping = channel.close();
  await closed;
  await expect(tryConnect(address)).rejects.toThrow();
  await expect(stopping).resolves.toBeUndefined();
  channel = undefined;
  expect(host.sessions()).toHaveLength(0);
});

it("refuses a non-loopback bind and invalid options", async () => {
  await expect(
    WebSocketChannel.listen({
      host: {} as Host,
      configuration,
      bindHost: "0.0.0.0",
      port: 0,
    }),
  ).rejects.toThrow(/loopback/u);
  await expect(
    WebSocketChannel.listen({ host: {} as Host, configuration, port: 0, sendTimeoutMs: 0 }),
  ).rejects.toThrow(/send timeout/u);
  await expect(
    WebSocketChannel.listen({
      host: {} as Host,
      configuration: {
        ...configuration,
        destinations: [
          ...configuration.destinations,
          { id: "desktop2", channelType: "websocket", platformId: "desktop", instance: "ws" },
        ],
      },
      port: 0,
    }),
  ).rejects.toThrow(/unique platform/u);
});

it("reports host failures to observers as explicit failure envelopes", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-ws-")));
  const driver = new MailboxDriver();
  driver.fail = true;
  host = await Host.start({ root, configuration, driver });
  channel = await WebSocketChannel.listen({ host, configuration, port: 0 });
  const client = await openClient(channel.address);

  client.send({ type: "input", destination: "desktop", content: "Persist before waking" });
  const failure = await client.waitFor((message) => message.type === "failure", "failure");
  expect(failure).toMatchObject({
    type: "failure",
    session_id: expect.any(String),
    error: expect.stringContaining("Session driver unavailable"),
  });
  expect(host.sessions()).toHaveLength(1);
});

it("answers plain HTTP requests with upgrade and not-found statuses", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-ws-")));
  const driver = new MailboxDriver();
  host = await Host.start({ root, configuration, driver });
  channel = await WebSocketChannel.listen({ host, configuration, port: 0 });
  const address = channel.address;
  const base = `http://${address.host}:${address.port}`;

  expect((await fetch(`${base}${address.path}`)).status).toBe(426);
  expect((await fetch(`${base}/other`)).status).toBe(404);
  await expect(tryConnect({ ...address, path: "/other" })).rejects.toThrow();
});

it("preserves the order of rapid inputs from one client", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-ws-")));
  const driver = new MailboxDriver();
  host = await Host.start({ root, configuration, driver });
  channel = await WebSocketChannel.listen({ host, configuration, port: 0 });
  const client = await openClient(channel.address);

  client.send({ type: "input", destination: "desktop", content: "First" });
  client.send({ type: "input", destination: "desktop", content: "Second" });
  await vi.waitFor(() =>
    expect(client.messages.filter((message) => message.type === "outbound")).toHaveLength(2),
  );

  const inbounds = client.messages.filter((message) => message.type === "inbound");
  const outbounds = client.messages.filter((message) => message.type === "outbound");
  expect(inbounds.map((message) => message.content)).toEqual(["First", "Second"]);
  expect(outbounds.map((message) => message.content)).toEqual(["Reply: First", "Reply: Second"]);
  expect(outbounds.map((message) => message.in_reply_to)).toEqual(
    inbounds.map((message) => message.message_id),
  );
});

async function openClient(address: WebSocketChannelAddress): Promise<Client> {
  const socket = await tryConnect(address);
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
    terminate: () => socket.terminate(),
  };
  clients.push(client);
  return client;
}

function tryConnect(address: WebSocketChannelAddress): Promise<WebSocket> {
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

async function connectionClosed(socket: WebSocket): Promise<void> {
  if (socket.readyState === socket.CLOSED) return;
  await once(socket, "close");
}
