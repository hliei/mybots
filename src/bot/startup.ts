import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { readWorkspaceSettings } from "../config/workspace.ts";
import { EventRuntime } from "../core/runtime.ts";
import { TelegramChannel, telegramTransport } from "./telegram.ts";
import { createTelegramApi, type TelegramApi } from "./telegram-api.ts";

export interface BotDependencies {
  createApi?: (options: { token: string }) => TelegramApi;
  signal?: AbortSignal;
}

function printHelp(): void {
  console.log("Usage: npm run start:bot -- [--workspace PATH | -w PATH]");
  console.log("Workspace defaults to ../default_workspace.");
  console.log(
    "Telegram polling starts when channels.enabled and channels.telegram.enabled are true in the Workspace configuration.",
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Own the bot process: load the Workspace, embed the shared runtime, run the
 * configured Telegram channel, and close polling and runtime resources on
 * shutdown. `--help` and a disabled Telegram channel need no credentials.
 */
export async function runBot(args: string[], dependencies: BotDependencies = {}): Promise<number> {
  let runtime: EventRuntime | undefined;
  let channel: TelegramChannel | undefined;
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
    const telegram = settings.channels.telegram;
    if (!settings.channels.enabled || !telegram?.enabled) {
      console.log(
        "Telegram is disabled. Set channels.enabled and channels.telegram.enabled in the Workspace configuration to start the bot.",
      );
      return 0;
    }
    const api = (dependencies.createApi ?? createTelegramApi)({ token: telegram.bot_token });
    if (controller.signal.aborted) return 0;
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    dependencies.signal?.addEventListener("abort", abort, { once: true });
    if (dependencies.signal?.aborted) abort();
    const identity = await api.getMe(controller.signal);
    runtime = await EventRuntime.open({
      workspace,
      delivery: { transports: [telegramTransport(api)] },
    });
    channel = new TelegramChannel({
      api,
      runtime,
      allowedUserIds: telegram.allowed_user_ids,
      onError: (error) => console.error(`Error: ${describe(error)}`),
    });
    console.log(
      `Telegram bot${identity.username ? ` @${identity.username}` : ""} is running. Press Ctrl+C to stop.`,
    );
    await channel.start(controller.signal);
    return 0;
  } catch (error) {
    console.error(`Error: ${describe(error)}`);
    return 1;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    dependencies.signal?.removeEventListener("abort", abort);
    await channel?.stop();
    await runtime?.stop();
  }
}
