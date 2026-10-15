import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createTelegramApi, type TelegramApi } from "../channels/telegram-api.ts";
import { readWorkspaceSettings } from "../config/workspace.ts";
import { EventRuntime } from "../core/runtime.ts";
import { type WebSocketAddress, WebSocketInterface } from "../websocket/interface.ts";
import { TelegramChannel, telegramTransport } from "./telegram.ts";

export interface BotDependencies {
  createApi?: (options: { token: string }) => TelegramApi;
  /** Test/embedding hook that requests the same shutdown as SIGINT. */
  signal?: AbortSignal;
  /** Called once the WebSocket listener is bound. */
  onListening?: (address: WebSocketAddress) => void;
}

function printHelp(): void {
  console.log("Usage: npm run start:bot -- [--workspace PATH | -w PATH]");
  console.log("Workspace defaults to ../default_workspace.");
  console.log(
    "Telegram polling starts when channels.enabled and channels.telegram.enabled are true in the Workspace configuration.",
  );
  console.log(
    "The local WebSocket interface serves /ws when api.enabled is true in the Workspace configuration.",
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Own the bot process: embed one shared runtime for the configured Telegram
 * channel and local WebSocket interface. Close both interfaces before runtime
 * cleanup. `--help` and disabled interfaces need no credentials or connections.
 */
export async function runBot(args: string[], dependencies: BotDependencies = {}): Promise<number> {
  let runtime: EventRuntime | undefined;
  let channel: TelegramChannel | undefined;
  let webSocket: WebSocketInterface | undefined;
  const controller = new AbortController();
  const abort = () => controller.abort();
  try {
    const { values } = parseArgs({
      args,
      options: {
        workspace: { type: "string", short: "w" },
        help: { type: "boolean", short: "h" },
      },
    });
    if (values.help) {
      printHelp();
      return 0;
    }
    const workspace = resolve(values.workspace ?? "../default_workspace");
    const settings = await readWorkspaceSettings(workspace);
    const telegram =
      settings.channels.enabled && settings.channels.telegram?.enabled
        ? settings.channels.telegram
        : undefined;
    if (!telegram && !settings.api.enabled) {
      console.log(
        "Telegram is disabled and the WebSocket interface is disabled. Enable channels.enabled and channels.telegram.enabled, or api.enabled, in the Workspace configuration to start the bot.",
      );
      return 0;
    }
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    dependencies.signal?.addEventListener("abort", abort, { once: true });
    if (dependencies.signal?.aborted) abort();
    if (controller.signal.aborted) return 0;
    const api = telegram
      ? (dependencies.createApi ?? createTelegramApi)({ token: telegram.bot_token })
      : undefined;
    const identity = await api?.getMe(controller.signal);
    if (controller.signal.aborted) return 0;
    runtime = await EventRuntime.open({
      workspace,
      ...(api
        ? { delivery: { transports: [telegramTransport(api)], ownedPlatforms: ["telegram"] } }
        : {}),
    });
    if (api && telegram) {
      channel = new TelegramChannel({
        api,
        runtime,
        allowedUserIds: telegram.allowed_user_ids,
        onError: (error) => console.error(`Error: ${describe(error)}`),
      });
    }
    const bind = runtime.activeConfig.api;
    if (bind.enabled) {
      webSocket = new WebSocketInterface({ runtime, host: bind.host, port: bind.port });
      const address = await webSocket.start();
      dependencies.onListening?.(address);
      console.log(
        `WebSocket interface listening on ws://${address.host}:${address.port}${address.path}. Press Ctrl+C to stop.`,
      );
    }
    if (channel) {
      console.log(
        `Telegram bot${identity?.username ? ` @${identity.username}` : ""} is running. Press Ctrl+C to stop.`,
      );
      await channel.start(controller.signal);
    } else {
      await new Promise<void>((resolvePromise) => {
        if (controller.signal.aborted) {
          resolvePromise();
          return;
        }
        controller.signal.addEventListener("abort", () => resolvePromise(), { once: true });
      });
    }
    return 0;
  } catch (error) {
    console.error(`Error: ${describe(error)}`);
    return 1;
  } finally {
    abort();
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    dependencies.signal?.removeEventListener("abort", abort);
    try {
      await webSocket?.stop();
    } finally {
      try {
        await channel?.stop();
      } finally {
        await runtime?.stop();
      }
    }
  }
}
