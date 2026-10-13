import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { EventRuntime } from "../core/runtime.ts";
import { type WebSocketAddress, WebSocketInterface } from "../websocket/interface.ts";

export interface BotDependencies {
  /** Test/embedding hook that requests the same shutdown as SIGINT. */
  signal?: AbortSignal;
  /** Called once the WebSocket listener is bound. */
  onListening?: (address: WebSocketAddress) => void;
}

function printHelp(): void {
  console.log("Usage: npm run start:bot -- [--workspace PATH | -w PATH]");
  console.log("Workspace defaults to ../default_workspace.");
  console.log(
    "The local WebSocket interface serves /ws when api.enabled is true in the Workspace configuration.",
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Own the bot process: load the Workspace, embed one shared runtime, serve the
 * local WebSocket interface when `api.enabled` is set, and close the listener,
 * clients, and runtime on shutdown. `--help` and a disabled interface need no
 * credentials and open no listener. Telegram is added by its own delivery.
 */
export async function runBot(args: string[], dependencies: BotDependencies = {}): Promise<number> {
  let runtime: EventRuntime | undefined;
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
    runtime = await EventRuntime.open({ workspace });
    const api = runtime.activeConfig.api;
    if (!api.enabled) {
      console.log(
        "The WebSocket interface is disabled. Set api.enabled in the Workspace configuration to serve /ws.",
      );
      return 0;
    }
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    dependencies.signal?.addEventListener("abort", abort, { once: true });
    if (dependencies.signal?.aborted) abort();
    webSocket = new WebSocketInterface({ runtime, host: api.host, port: api.port });
    const address = await webSocket.start();
    dependencies.onListening?.(address);
    console.log(
      `WebSocket interface listening on ws://${address.host}:${address.port}${address.path}. Press Ctrl+C to stop.`,
    );
    await new Promise<void>((resolvePromise) => {
      if (controller.signal.aborted) {
        resolvePromise();
        return;
      }
      controller.signal.addEventListener("abort", () => resolvePromise(), { once: true });
    });
    return 0;
  } catch (error) {
    console.error(`Error: ${describe(error)}`);
    return 1;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    dependencies.signal?.removeEventListener("abort", abort);
    await webSocket?.stop();
    await runtime?.stop();
  }
}
