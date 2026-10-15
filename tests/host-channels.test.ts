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

test("three channels share working files while execution, delivery and restart stay independent", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mybots-channels-")));
  const { configuration } = await loadHostSettings("examples/host/host-telegram.json");
  const executionStarted = Promise.withResolvers<void>();
  const releaseExecution = Promise.withResolvers<void>();
  const sending = Promise.withResolvers<void>();
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
      return { id: "1" };
    },
    async getUpdates(offset) {
      return { updates: [], nextOffset: offset };
    },
    async sendMessage(chatId, text, signal) {
      expect(chatId).toBe("123456789");
      sending.resolve();
      // The first host cannot finish sending before it is stopped.
      if (sends.length === 0) {
        sends.push("blocked");
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new Error("Controlled platform interruption");
      }
      sends.push(text);
    },
  };
  async function open() {
    host = await Host.start({ root, configuration, driver });
    cli = await CliChannel.listen({ host, root, destinationId: "terminal", owner: "cli:local" });
    web = await WebSocketChannel.listen({ host, configuration, port: 0 });
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
    observer = new WebSocket(`ws://127.0.0.1:${web.address.port}/ws`);
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
    await vi.waitFor(() =>
      expect(frames).toContainEqual(expect.objectContaining({ content: "Saved amber orchard" })),
    );
    const accepted = await telegram?.dispatch({
      updateId: 2,
      userId: "123456789",
      chatId: "123456789",
      text: "Read shared material",
    });
    expect(accepted).toBeDefined();
    await waitForCheckpoint(sending.promise, "blocked Telegram delivery");
    await vi.waitFor(() =>
      expect(frames).toContainEqual(
        expect.objectContaining({
          type: "outbound",
          destination: "owner-chat",
          content: "Read amber orchard",
          in_reply_to: accepted?.messageId,
        }),
      ),
    );
    const pending = await host?.inspect(accepted?.sessionId ?? "");
    expect(pending?.inputs[0].status).toBe("completed");
    expect(pending?.deliveries).toEqual([expect.objectContaining({ status: undefined })]);
    expect(terminal).toBe("");
    releaseExecution.resolve();
    await vi.waitFor(() => expect(terminal).toContain("Terminal completed"));
    const sessions = host?.sessions() ?? [];
    expect(sessions).toHaveLength(3);
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
    await vi.waitFor(() => expect(sends).toEqual(["blocked", "Read amber orchard"]));
    // Persisted output is delivered without restarting model execution.
    expect(driver.launches).toHaveLength(0);
    expect(
      host
        ?.sessions()
        .map((session) => session.id)
        .sort(),
    ).toEqual(sessions.map((session) => session.id).sort());
    expect((await host?.inspect(accepted?.sessionId ?? ""))?.deliveries).toEqual([
      expect.objectContaining({ status: "delivered" }),
    ]);
    socket?.write(`${JSON.stringify({ text: "Continue terminal" })}\n`);
    observer?.send(
      JSON.stringify({ type: "input", destination: "desktop", content: "Continue desktop" }),
    );
    const resumed = await telegram?.dispatch({
      updateId: 3,
      userId: "123456789",
      chatId: "123456789",
      text: "Continue chat",
    });
    expect(resumed?.sessionId).toBe(accepted?.sessionId);
    await vi.waitFor(() => expect(driver.launches).toHaveLength(3));
    for (const launch of driver.launches)
      expect(launch.continuation).toBe(continuations.get(launch.material.key.sessionId));
    await vi.waitFor(() =>
      expect(sends).toEqual(["blocked", "Read amber orchard", "Reply: Continue chat"]),
    );
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
