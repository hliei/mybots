import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { TelegramChannel } from "../packages/host/src/channels/telegram.ts";
import type { TelegramApi } from "../packages/host/src/channels/telegram-api.ts";
import { WebSocketChannel } from "../packages/host/src/channels/websocket.ts";
import { CliChannel } from "../packages/host/src/cli/socket-server.ts";
import { loadHostSettings } from "../packages/host/src/config/host.ts";
import { Host } from "../packages/host/src/host.ts";
import { waitForCheckpoint } from "./checkpoint.ts";
import { MailboxDriver } from "./host-fixture.ts";

test("three channels use one Thread while delivery and restart retain input routing", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mybots-channels-")));
  const { configuration } = await loadHostSettings("examples/host/host-telegram.json");
  const executionStarted = Promise.withResolvers<void>();
  const releaseExecution = Promise.withResolvers<void>();
  let host: Host | undefined;
  let cli: CliChannel | undefined;
  let web: WebSocketChannel | undefined;
  let telegram: TelegramChannel | undefined;
  let socket: Socket | undefined;
  let observer: WebSocket | undefined;
  let driver = new MailboxDriver();
  let frames: Record<string, unknown>[] = [];
  let terminal = "";
  const sends: string[] = [];
  const api: TelegramApi = {
    async getMe() {
      return { id: "1", topicsEnabled: false };
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
      expect(chatId).toBe("123456789");
      sends.push(text);
    },
  };
  async function open() {
    host = await Host.start({ root, configuration, driver });
    cli = await CliChannel.listen({ host, root, destinationId: "terminal", owner: "cli:local" });
    web = await WebSocketChannel.listen({ root, host, configuration, port: 0 });
    telegram = TelegramChannel.listen({
      host,
      api,
      instance: "telegram",
      owners: configuration.owners,
      destinations: [{ id: "owner-chat", platformId: "123456789" }],
    });
    socket = connect(join(root, "data", "cli.sock"));
    terminal = "";
    socket.on("data", (chunk) => {
      terminal += chunk.toString();
    });
    await waitForCheckpoint(once(socket, "connect"), "CLI connection");
    frames = [];
    observer = new WebSocket(`ws://127.0.0.1:${web.address.port}/ws`, {
      headers: {
        Authorization: `Bearer ${(await readFile(join(root, "data", "client-credential"), "utf8")).trim()}`,
      },
    });
    observer.on("message", (data) => frames.push(JSON.parse(data.toString())));
    await waitForCheckpoint(once(observer, "open"), "WebSocket connection");
  }
  async function close() {
    observer?.terminate();
    socket?.destroy();
    await web?.close();
    await cli?.close();
    await telegram?.stop();
    await host?.stop();
    observer = undefined;
    socket = undefined;
    web = undefined;
    cli = undefined;
    telegram = undefined;
    host = undefined;
  }
  try {
    driver.respond = async (input, material, signal) => {
      if (input.content === "Hold terminal") {
        executionStarted.resolve();
        await Promise.race([
          releaseExecution.promise,
          new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          ),
        ]);
        return "Terminal completed";
      }
      const shared = join(material.workspace, "shared.txt");
      if (input.content === "Save shared material") {
        await writeFile(shared, "amber orchard");
        return "Saved amber orchard";
      }
      return `Read ${await readFile(shared, "utf8")}`;
    };
    await open();
    expect(
      await telegram?.dispatch({ updateId: 1, userId: "7", chatId: "7", text: "Denied" }),
    ).toBeUndefined();
    socket?.write(`${JSON.stringify({ text: "Hold terminal" })}\n`);
    await waitForCheckpoint(executionStarted.promise, "held CLI execution");
    observer?.send(
      JSON.stringify({ type: "input", destination: "desktop", content: "Save shared material" }),
    );
    expect(frames.some((frame) => frame.content === "Saved amber orchard")).toBe(false);
    releaseExecution.resolve();
    await vi.waitFor(() =>
      expect(frames).toContainEqual(expect.objectContaining({ content: "Saved amber orchard" })),
    );
    expect(
      await telegram?.dispatch({
        updateId: 2,
        userId: "123456789",
        chatId: "123456789",
        text: "Read shared material",
      }),
    ).toBeUndefined();
    expect(
      await telegram?.dispatch({
        updateId: 4,
        userId: "123456789",
        chatId: "123456789",
        text: "approve",
        threadId: "3",
      }),
    ).toBeUndefined();
    expect(sends).toEqual([]);
    expect(terminal).toContain("Terminal completed");
    releaseExecution.resolve();
    await vi.waitFor(() => expect(terminal).toContain("Terminal completed"));
    const sessions = host?.sessions() ?? [];
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(new Set(sessions.map((session) => session.agent_group_id))).toEqual(
      new Set(["personal"]),
    );
    expect(new Set(driver.launches.map((launch) => launch.material.workspace))).toEqual(
      new Set([join(root, "groups", "personal")]),
    );
    const continuations = new Map(
      await Promise.all(
        sessions.map(
          async (session) => [session.id, (await host?.inspect(session.id))?.continuation] as const,
        ),
      ),
    );
    for (const continuation of continuations.values()) expect(continuation).toMatch(/^pi:/);
    await close();
    expect(new Set(driver.stopped)).toEqual(new Set(driver.launches.map((launch) => launch.ref)));

    driver = new MailboxDriver();
    await open();
    expect(sends).toEqual([]);
    expect(driver.launches).toHaveLength(0);
    expect(
      host
        ?.sessions()
        .map((session) => session.id)
        .sort(),
    ).toEqual(sessions.map((session) => session.id).sort());
    socket?.write(`${JSON.stringify({ text: "Continue terminal" })}\n`);
    observer?.send(
      JSON.stringify({ type: "input", destination: "desktop", content: "Continue desktop" }),
    );
    expect(
      await telegram?.dispatch({
        updateId: 3,
        userId: "123456789",
        chatId: "123456789",
        text: "Continue chat",
      }),
    ).toBeUndefined();
    await vi.waitFor(() => expect(driver.launches.length).toBeGreaterThanOrEqual(1));
    for (const launch of driver.launches) expect(launch.continuation).toBeUndefined();
    expect(sends).toEqual([]);
    await vi.waitFor(() => expect(terminal).toContain("Reply: Continue terminal"));
    await vi.waitFor(() =>
      expect(frames).toContainEqual(
        expect.objectContaining({ destination: "desktop", content: "Reply: Continue desktop" }),
      ),
    );
  } finally {
    releaseExecution.resolve();
    await close();
    await rm(root, { recursive: true, force: true });
  }
});
