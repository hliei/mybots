import { once } from "node:events";
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { TelegramChannel, type TelegramDestination } from "../src/channels/telegram.ts";
import {
  createTelegramApi,
  TELEGRAM_CHUNK_LIMIT,
  type TelegramApi,
  type TelegramUpdate,
} from "../src/channels/telegram-api.ts";
import { loadHostSettings } from "../src/config/host.ts";
import { Host, type HostConfiguration } from "../src/host.ts";
import { runHost } from "../src/index.ts";
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
      return { id: "1", username: "test_bot" };
    },
    async getUpdates(offset) {
      return { updates: [], nextOffset: offset };
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
  telegram: { instance: "telegram", botTokenEnv: "MYBOTS_TEST_TELEGRAM_TOKEN" },
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
  const accepted = await channel.dispatch(update());
  await vi.waitFor(async () =>
    expect((await host?.inspect(accepted?.sessionId ?? ""))?.deliveries).toEqual([
      expect.objectContaining({ status: "delivered" }),
    ]),
  );
  expect(requests.some((url) => url.includes(token))).toBe(true);
  const visible = [
    ...(await filesUnder(join(root, "data"))),
    ...(await filesUnder(join(root, "groups"))),
  ];
  expect(visible.some((file) => file.includes("host.db"))).toBe(true);
  expect(visible.some((file) => file.includes(".context"))).toBe(true);
  for (const file of visible)
    expect(await readFile(file, "latin1"), `${file} must not hold the token`).not.toContain(token);
  expect(JSON.stringify(await host.inspect(accepted?.sessionId ?? ""))).not.toContain(token);
});

it("keeps Telegram and CLI conversations separate within one shared workspace across restart", async () => {
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
  const telegramFirst = await channel.dispatch(update({ text: "Telegram first" }));
  const cliFirst = await host.accept({
    destinationId: "terminal",
    userId: "cli:local",
    text: "CLI first",
  });
  expect(telegramFirst?.sessionId).not.toBe(cliFirst.sessionId);
  await vi.waitFor(() =>
    expect(first.sends).toEqual([{ chatId: "42", text: "Reply: Telegram first" }]),
  );
  expect(driver.launches.map((launch) => launch.material.workspace)).toEqual([
    join(root, "groups", "personal"),
    join(root, "groups", "personal"),
  ]);
  expect(driver.launches[0].material.directory).not.toBe(driver.launches[1].material.directory);
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
  const telegramSecond = await channel.dispatch(update({ text: "Telegram second" }));
  const cliSecond = await host.accept({
    destinationId: "terminal",
    userId: "cli:local",
    text: "CLI second",
  });
  expect(telegramSecond?.sessionId).toBe(telegramFirst?.sessionId);
  expect(cliSecond.sessionId).toBe(cliFirst.sessionId);
  await vi.waitFor(() =>
    expect(resumed.sends).toEqual([{ chatId: "42", text: "Reply: Telegram second" }]),
  );
  const telegramLaunch = driver.launches.find((launch) =>
    launch.material.directory.endsWith(telegramFirst?.sessionId ?? ""),
  );
  expect(telegramLaunch?.continuation).toMatch(/^pi:/);
});

it("splits a long reply into ordered platform-sized chat messages", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-telegram-")));
  const driver = new MailboxDriver();
  const expected = Array.from({ length: 5 }, (_, index) => String(index).repeat(1000)).join("\n\n");
  driver.respond = async () => expected;
  host = await Host.start({ root, configuration, driver });
  const { api, sends } = recordingApi();
  channel = TelegramChannel.listen({
    host,
    api,
    instance: "telegram",
    destinations,
    owners: configuration.owners,
  });
  await channel.dispatch(update());
  await vi.waitFor(() => expect(sends).toHaveLength(2));
  expect(sends.every((send) => send.chatId === "42")).toBe(true);
  expect(sends.every((send) => Array.from(send.text).length <= TELEGRAM_CHUNK_LIMIT)).toBe(true);
  expect(sends.map((send) => send.text).join("\n\n")).toBe(expected);
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
  await vi.waitFor(() => expect(sends).toEqual([{ chatId: "42", text: "Reply: Hello" }]));
  await vi.waitFor(() => expect(offsets).toEqual([0, 10]));
  await channel.stop();
  await expect(running).resolves.toBeUndefined();
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect(host.sessions()).toHaveLength(1);
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

it("routes an owner private message through the host and replies to its chat", async () => {
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
  const accepted = await channel.dispatch(update());
  expect(accepted).toBeDefined();
  await vi.waitFor(() => expect(sends).toEqual([{ chatId: "42", text: "Reply: Hello" }]));
  const session = host.sessions()[0];
  expect(session).toMatchObject({ agent_group_id: "personal", messaging_group_id: "owner-chat" });
  const inspected = await host.inspect(session.id);
  expect(inspected.outputs).toEqual([
    expect.objectContaining({
      channel_type: "telegram",
      platform_id: "42",
      in_reply_to: accepted?.messageId,
    }),
  ]);
});

it("requires coherent Telegram host settings before opening services", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-telegram-")));
  await expect(loadHostSettings(await settingsFile("valid", settings))).resolves.toMatchObject({
    telegram: { instance: "telegram", botTokenEnv: "MYBOTS_TEST_TELEGRAM_TOKEN" },
  });
  await expect(
    loadHostSettings(await settingsFile("missing", { ...settings, telegram: undefined })),
  ).rejects.toThrow("Invalid host configuration");
  await expect(
    loadHostSettings(
      await settingsFile("instance", {
        ...settings,
        telegram: { instance: "other", botTokenEnv: "MYBOTS_TEST_TELEGRAM_TOKEN" },
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
  vi.stubEnv("MYBOTS_TEST_TELEGRAM_TOKEN", undefined);
  const createTelegramApi = vi.fn();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const status = await runHost(["--root", root, "--config", file], { createTelegramApi });
    expect(status).toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain("MYBOTS_TEST_TELEGRAM_TOKEN");
    expect(createTelegramApi).not.toHaveBeenCalled();
  } finally {
    error.mockRestore();
  }
});

it("cancels Telegram identity lookup when shutdown arrives during host startup", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-telegram-")));
  const file = await settingsFile("startup-cancel", settings);
  vi.stubEnv("MYBOTS_TEST_TELEGRAM_TOKEN", "offline-token");
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
      return { id: "1" };
    },
  };
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const running = runHost(["--root", root, "--config", file], {
    createTelegramApi: () => api,
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
    vi.stubEnv("MYBOTS_TEST_TELEGRAM_TOKEN", "offline-token");
    const controller = new AbortController();
    const polling = Promise.withResolvers<void>();
    const api: TelegramApi = {
      async getMe() {
        return { id: "1", username: "test_bot" };
      },
      async getUpdates(_offset, signal) {
        polling.resolve();
        return await new Promise<never>((_resolve, reject) => {
          const abort = () => reject(signal.reason ?? new Error("aborted"));
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      },
      async sendMessage() {},
    };
    const createTelegramApi = vi.fn(() => api);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let socket: WebSocket | undefined;
    const running = runHost(["--root", root, "--config", file], {
      createTelegramApi,
      signal: controller.signal,
    });
    try {
      await waitForCheckpoint(polling.promise, "Telegram polling startup");
      let closed: Promise<unknown> | undefined;
      if (withWebSocket) {
        const prefix = "Local WebSocket interface on ";
        const address = log.mock.calls.flat().find((value) => String(value).startsWith(prefix));
        expect(address).toBeDefined();
        socket = new WebSocket(String(address).slice(prefix.length));
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
                { update_id: 2, message: { from: { id: 42 }, chat: { id: 42 }, text: "Hello" } },
                { update_id: 3, message: { from: { id: 42 }, chat: { id: 42 }, text: "  " } },
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
  await vi.waitFor(() => expect(sends).toEqual([{ chat_id: "42", text: "Reply: Hello" }]));
  await vi.waitFor(() => expect(polls).toHaveLength(2));
  expect(polls[1]).toMatchObject({ offset: 4 });
  expect(host.sessions()).toHaveLength(1);
  await channel.stop();
  await expect(running).resolves.toBeUndefined();
});
