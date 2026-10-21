import { once } from "node:events";
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  TelegramChannel,
  type TelegramDestination,
} from "../packages/host/src/channels/telegram.ts";
import {
  createTelegramApi,
  type TelegramApi,
  type TelegramUpdate,
} from "../packages/host/src/channels/telegram-api.ts";
import { loadHostSettings } from "../packages/host/src/config/host.ts";
import { Host, type HostConfiguration } from "../packages/host/src/host.ts";
import { runHost } from "../packages/host/src/index.ts";
import { waitForCheckpoint } from "./checkpoint.ts";
import { MailboxDriver } from "./host-fixture.ts";

const configuration: HostConfiguration = {
  owners: ["cli:local", "telegram:42"],
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
    { id: "owner-chat", channelType: "telegram", platformId: "42", instance: "telegram" },
  ],
};
const destinations: TelegramDestination[] = [{ id: "owner-chat", platformId: "42" }];
let root: string;
let host: Host | undefined;
let channel: TelegramChannel | undefined;
afterEach(async () => {
  await channel?.stop();
  channel = undefined;
  await host?.stop();
  host = undefined;
  if (root) await rm(root, { recursive: true, force: true });
});

function update(overrides: Partial<TelegramUpdate> = {}): TelegramUpdate {
  return { updateId: 1, userId: "42", chatId: "42", text: "Hello", ...overrides };
}

function recordingApi(options: { failSends?: boolean } = {}) {
  const sends: { chatId: string; text: string }[] = [];
  const api: TelegramApi = {
    async getMe() {
      return { id: "1", username: "test_bot", topicsEnabled: false };
    },
    async getUpdates(offset) {
      return { updates: [], nextOffset: offset };
    },
    async getChat() {
      return { isForum: true };
    },
    async createForumTopic() {
      return { topicId: "1" };
    },
    async sendMessage(chatId, text) {
      if (options.failSends) throw new Error("Telegram unavailable");
      sends.push({ chatId, text });
    },
  };
  return { api, sends };
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(path)));
    else files.push(path);
  }
  return files;
}

const settings = {
  owners: configuration.owners,
  agent: configuration.agent,
  destinations: configuration.destinations,
  cliDestinationId: "terminal",
  container: { image: "mybots-agent:mailbox", network: "mybots-isolated" },
  gateway: { url: "http://127.0.0.1:10254", proxyHost: "onecli" },
  telegram: { instance: "telegram" },
};

async function settingsFile(name: string, value: unknown): Promise<string> {
  const file = join(root, `${name}.json`);
  await writeFile(file, JSON.stringify(value));
  return file;
}

it("keeps the Bot API token out of runner material and shared resources", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-telegram-")));
  const token = "offline-secret-token";
  const requests: string[] = [];
  const api = createTelegramApi({
    token,
    baseUrl: "https://telegram.test",
    fetch: async (url) => {
      requests.push(String(url));
      return new Response(
        JSON.stringify(
          String(url).includes("getUpdates")
            ? { ok: true, result: [] }
            : { ok: true, result: true },
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  const driver = new MailboxDriver();
  host = await Host.start({ root, configuration, driver });
  channel = TelegramChannel.listen({
    host,
    api,
    instance: "telegram",
    destinations,
    owners: configuration.owners,
  });
  const accepted = await host.accept({
    destinationId: "terminal",
    userId: "cli:local",
    text: "Hello",
  });
  expect(await channel.dispatch(update())).toBeUndefined();
  const running = channel.start();
  await vi.waitFor(() => expect(requests.some((url) => url.includes(token))).toBe(true));
  expect(host.sessions().map((session) => session.id)).toEqual([accepted.sessionId]);
  expect(JSON.stringify(await host.inspect(accepted.sessionId))).not.toContain(token);
  await channel.stop();
  await running;
  await channel.stop();
  channel = undefined;
  await host.stop();
  host = undefined;
  const visible = [
    ...(await filesUnder(join(root, "data"))),
    ...(await filesUnder(join(root, "groups"))),
  ];
  expect(visible.some((file) => file.includes("host.db"))).toBe(true);
  expect(visible.some((file) => file.includes(".context"))).toBe(true);
  for (const file of visible)
    expect(await readFile(file, "latin1"), `${file} must not hold the token`).not.toContain(token);
});

it("keeps Telegram text out of the Thread while CLI work survives restart", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-telegram-")));
  let driver = new MailboxDriver();
  host = await Host.start({ root, configuration, driver });
  const first = recordingApi();
  channel = TelegramChannel.listen({
    host,
    api: first.api,
    instance: "telegram",
    destinations,
    owners: configuration.owners,
  });
  expect(await channel.dispatch(update({ text: "Telegram first" }))).toBeUndefined();
  expect(
    await channel.dispatch(update({ text: "approve", threadId: "9", updateId: 2 })),
  ).toBeUndefined();
  const cliFirst = await host.accept({
    destinationId: "terminal",
    userId: "cli:local",
    text: "CLI first",
  });
  expect(host.sessions().map((session) => session.id)).toEqual([cliFirst.sessionId]);
  expect(first.sends).toEqual([]);
  expect(driver.launches.map((launch) => launch.material.workspace)).toEqual([
    join(root, "groups", "personal"),
  ]);
  await channel.stop();
  channel = undefined;
  await host.stop();
  host = undefined;

  driver = new MailboxDriver();
  host = await Host.start({ root, configuration, driver });
  const resumed = recordingApi();
  channel = TelegramChannel.listen({
    host,
    api: resumed.api,
    instance: "telegram",
    destinations,
    owners: configuration.owners,
  });
  expect(await channel.dispatch(update({ text: "Telegram second" }))).toBeUndefined();
  const cliSecond = await host.accept({
    destinationId: "terminal",
    userId: "cli:local",
    text: "CLI second",
  });
  expect(cliSecond.sessionId).toBe(cliFirst.sessionId);
  expect(resumed.sends).toEqual([]);
  expect(host.sessions().map((session) => session.messaging_group_id)).not.toContain("owner-chat");
  expect((await host.threadDetail("personal")).tasks.length).toBeGreaterThan(0);
});

it("does not turn ordinary Telegram text into chat replies", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-telegram-")));
  const driver = new MailboxDriver();
  host = await Host.start({ root, configuration, driver });
  const { api, sends } = recordingApi();
  channel = TelegramChannel.listen({
    host,
    api,
    instance: "telegram",
    destinations,
    owners: configuration.owners,
  });
  expect(await channel.dispatch(update())).toBeUndefined();
  expect(host.sessions()).toEqual([]);
  expect(sends).toEqual([]);
  expect(driver.launches).toEqual([]);
});

it("advances polling offsets, ignores unsupported updates, and stops within a bounded shutdown", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-telegram-")));
  const driver = new MailboxDriver();
  host = await Host.start({ root, configuration, driver });
  const { api: base, sends } = recordingApi();
  const offsets: number[] = [];
  const signals: AbortSignal[] = [];
  const polling: TelegramApi = {
    ...base,
    async getUpdates(offset, signal) {
      offsets.push(offset);
      signals.push(signal);
      if (offsets.length === 1)
        return {
          updates: [
            update({ updateId: 1, userId: "7", chatId: "7", text: "Unknown sender" }),
            update({ updateId: 2, text: "Hello" }),
          ],
          nextOffset: 10,
        };
      return await new Promise<never>((_resolve, reject) => {
        const abort = () => reject(signal.reason ?? new Error("aborted"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    },
  };
  channel = TelegramChannel.listen({
    host,
    api: polling,
    instance: "telegram",
    destinations,
    owners: configuration.owners,
    onError: () => {},
  });
  const running = channel.start();
  await vi.waitFor(() => expect(offsets).toEqual([0, 10]));
  expect(sends).toEqual([]);
  await channel.stop();
  await expect(running).resolves.toBeUndefined();
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect(host.sessions()).toEqual([]);
});

it("ignores unknown senders, non-private chats and unconfigured chats without accepted work", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-telegram-")));
  const driver = new MailboxDriver();
  host = await Host.start({ root, configuration, driver });
  const { api, sends } = recordingApi();
  channel = TelegramChannel.listen({
    host,
    api,
    instance: "telegram",
    destinations,
    owners: configuration.owners,
  });
  expect(await channel.dispatch(update({ userId: "7", chatId: "7" }))).toBeUndefined();
  expect(await channel.dispatch(update({ userId: "42", chatId: "-100" }))).toBeUndefined();
  expect(await channel.dispatch(update({ userId: "42", chatId: "99" }))).toBeUndefined();
  await expect(
    host.accept({ destinationId: "owner-chat", userId: "telegram:999", text: "Spoofed" }),
  ).rejects.toThrow("Owner identity required");
  expect(host.sessions()).toEqual([]);
  expect(driver.launches).toEqual([]);
  expect(sends).toEqual([]);
});

it("does not admit an owner private message or topic callback as chat", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-telegram-")));
  const driver = new MailboxDriver();
  host = await Host.start({ root, configuration, driver });
  const { api, sends } = recordingApi();
  channel = TelegramChannel.listen({
    host,
    api,
    instance: "telegram",
    destinations,
    owners: configuration.owners,
  });
  expect(await channel.dispatch(update())).toBeUndefined();
  expect(await channel.dispatch(update({ threadId: "4", text: "approve" }))).toBeUndefined();
  expect(host.sessions()).toEqual([]);
  expect(sends).toEqual([]);
  expect(driver.launches).toEqual([]);
});

it("requires coherent Telegram host settings before opening services", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-telegram-")));
  await expect(loadHostSettings(await settingsFile("valid", settings))).resolves.toMatchObject({
    telegram: { instance: "telegram" },
  });
  await expect(
    loadHostSettings(await settingsFile("missing", { ...settings, telegram: undefined })),
  ).rejects.toThrow("Invalid host configuration");
  await expect(
    loadHostSettings(
      await settingsFile("instance", {
        ...settings,
        telegram: { instance: "other" },
      }),
    ),
  ).rejects.toThrow("Invalid host configuration");
  await expect(
    loadHostSettings(await settingsFile("owner", { ...settings, owners: ["cli:local"] })),
  ).rejects.toThrow("Invalid host configuration");
});

it("fails host startup clearly when a configured Telegram token is absent", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-telegram-")));
  const file = await settingsFile("absent", settings);
  vi.stubEnv("TELEGRAM_BOT_TOKEN", undefined);
  const createTelegramApi = vi.fn();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const status = await runHost(["--root", root, "--config", file], { createTelegramApi });
    expect(status).toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain("TELEGRAM_BOT_TOKEN");
    expect(createTelegramApi).not.toHaveBeenCalled();
  } finally {
    error.mockRestore();
  }
});

it("cancels Telegram identity lookup when shutdown arrives during host startup", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-telegram-")));
  const file = await settingsFile("startup-cancel", settings);
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "offline-token");
  const controller = new AbortController();
  const lookup = Promise.withResolvers<AbortSignal>();
  const release = Promise.withResolvers<void>();
  const { api: base } = recordingApi();
  const api: TelegramApi = {
    ...base,
    async getMe(signal) {
      lookup.resolve(signal);
      await Promise.race([
        release.promise,
        new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      ]);
      signal.throwIfAborted();
      return { id: "1", topicsEnabled: false };
    },
  };
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const running = runHost(["--root", root, "--config", file], {
    createTelegramApi: () => api,
    inspectNetwork: async () => "internal",
    signal: controller.signal,
  });
  try {
    const signal = await waitForCheckpoint(lookup.promise, "Telegram identity lookup");
    controller.abort();
    expect(signal.aborted).toBe(true);
    await expect(waitForCheckpoint(running, "startup cancellation")).resolves.toBe(0);
    expect(error).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await running;
    vi.unstubAllEnvs();
    error.mockRestore();
  }
});

it.each([false, true])(
  "starts and stops Telegram through the host with WebSocket enabled=%s",
  async (withWebSocket) => {
    root = await realpath(await mkdtemp(join(tmpdir(), "mybots-telegram-")));
    const file = await settingsFile(
      "wiring",
      withWebSocket
        ? {
            ...settings,
            destinations: [
              ...settings.destinations,
              {
                id: "desktop",
                channelType: "websocket",
                platformId: "desktop",
                instance: "ws",
              },
            ],
            websocket: { host: "127.0.0.1", port: 0, path: "/ws" },
          }
        : settings,
    );
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "offline-token");
    const controller = new AbortController();
    const polling = Promise.withResolvers<void>();
    const api: TelegramApi = {
      async getMe() {
        return { id: "1", username: "test_bot", topicsEnabled: false };
      },
      async getUpdates(_offset, signal) {
        polling.resolve();
        return await new Promise<never>((_resolve, reject) => {
          const abort = () => reject(signal.reason ?? new Error("aborted"));
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      },
      async getChat() {
        return { isForum: true };
      },
      async createForumTopic() {
        return { topicId: "1" };
      },
      async sendMessage() {},
    };
    const createTelegramApi = vi.fn(() => api);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let socket: WebSocket | undefined;
    const running = runHost(["--root", root, "--config", file], {
      createTelegramApi,
      inspectNetwork: async () => "internal",
      signal: controller.signal,
    });
    try {
      await waitForCheckpoint(polling.promise, "Telegram polling startup");
      let closed: Promise<unknown> | undefined;
      if (withWebSocket) {
        const prefix = "Local WebSocket interface on ";
        const address = log.mock.calls.flat().find((value) => String(value).startsWith(prefix));
        expect(address).toBeDefined();
        socket = new WebSocket(String(address).slice(prefix.length), {
          headers: {
            Authorization: `Bearer ${(await readFile(join(root, "data", "client-credential"), "utf8")).trim()}`,
          },
        });
        await waitForCheckpoint(once(socket, "open"), "WebSocket connection");
        closed = once(socket, "close");
      }
      controller.abort();
      await expect(waitForCheckpoint(running, "host channel shutdown")).resolves.toBe(0);
      if (closed) await waitForCheckpoint(closed, "WebSocket shutdown");
      expect(createTelegramApi).toHaveBeenCalledWith({ token: "offline-token" });
      expect(log.mock.calls.flat().join("\n")).toContain("Telegram bot @test_bot is polling.");
      expect(error).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      socket?.terminate();
      await running;
      vi.unstubAllEnvs();
      log.mockRestore();
      error.mockRestore();
    }
  },
);

it("normalizes raw Bot API updates before routing and drops unsupported input", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-telegram-")));
  const polls: Record<string, unknown>[] = [];
  const sends: Record<string, unknown>[] = [];
  let served = false;
  const api = createTelegramApi({
    token: "offline-token",
    baseUrl: "https://telegram.test",
    fetch: async (url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (String(url).includes("getUpdates")) {
        polls.push(body);
        if (!served) {
          served = true;
          return new Response(
            JSON.stringify({
              ok: true,
              result: [
                { update_id: 1, message: { text: "no sender", chat: { id: 42 } } },
                { update_id: 2, callback_query: { id: "cb", from: { id: 42 }, data: "approve" } },
                {
                  update_id: 3,
                  message: {
                    from: { id: 42 },
                    chat: { id: 42 },
                    message_thread_id: 9,
                    text: "Topic decision",
                  },
                },
                { update_id: 4, message: { from: { id: 42 }, chat: { id: 42 }, text: "Hello" } },
                { update_id: 5, message: { from: { id: 42 }, chat: { id: 42 }, text: "  " } },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        const signal = init?.signal as AbortSignal;
        return await new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(signal.reason ?? new Error("aborted"));
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      }
      sends.push(body);
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const driver = new MailboxDriver();
  host = await Host.start({ root, configuration, driver });
  channel = TelegramChannel.listen({
    host,
    api,
    instance: "telegram",
    destinations,
    owners: configuration.owners,
    onError: () => {},
  });
  const running = channel.start();
  await vi.waitFor(() => expect(polls).toHaveLength(2));
  expect(sends).toEqual([]);
  expect(polls[1]).toMatchObject({ offset: 6 });
  expect(host.sessions()).toEqual([]);
  await channel.stop();
  await expect(running).resolves.toBeUndefined();
});
