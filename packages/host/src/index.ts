import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { TelegramChannel, type TelegramDestination } from "./channels/telegram.ts";
import { createTelegramApi, type TelegramApi } from "./channels/telegram-api.ts";
import { WebSocketChannel } from "./channels/websocket.ts";
import { CliChannel } from "./cli/socket-server.ts";
import {
  assertInternalNetwork,
  type DockerNetworkState,
  inspectDockerNetwork,
} from "./config/docker-network.ts";
import { readEnvFile } from "./config/env-file.ts";
import { type HostSettings, loadHostSettings } from "./config/host.ts";
import { applyOperatorEnvironment, mergePairedTelegram } from "./config/operator-env.ts";
import { readPairedTelegram } from "./db/index.ts";
import { DockerDriver } from "./drivers/docker-driver.ts";
import { OneCliGateway } from "./gateway-providers/onecli.ts";
import { Host } from "./host.ts";

const OPERATOR_ENV_KEYS = [
  "ONECLI_URL",
  "ONECLI_API_KEY",
  "ONECLI_PROJECT_ID",
  "TELEGRAM_BOT_TOKEN",
  "MODEL_PROVIDER",
  "MODEL_ID",
  "MODEL_BASE_URL",
  "MODEL_CONTEXT_WINDOW",
  "MODEL_MAX_TOKENS",
  "CONTAINER_IMAGE",
  "CONTAINER_NETWORK",
  "GATEWAY_PROXY_HOST",
  "EGRESS_LOCKDOWN",
  "WEB_SEARCH_PROVIDER",
  "WEB_SEARCH_ENDPOINT",
] as const;

export interface HostDependencies {
  /** Test/embedding hook for the Bot API boundary; production uses the Bot API. */
  createTelegramApi?: (options: { token: string }) => TelegramApi;
  /** Test/embedding hook that requests the same shutdown as SIGINT/SIGTERM. */
  signal?: AbortSignal;
  /** Test hook for the internal-network check. Production inspects Docker. */
  inspectNetwork?: (name: string) => Promise<DockerNetworkState>;
}

function describe(error: unknown, websocketPort?: number): string {
  const code =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (code === "EADDRINUSE" && websocketPort !== undefined) {
    return `WebSocket port ${websocketPort} is already in use. Change the websocket port in host.json and restart the service. (EADDRINUSE)`;
  }
  return error instanceof Error ? error.message : String(error);
}

export async function runHost(
  args: string[],
  dependencies: HostDependencies = {},
): Promise<number> {
  let host: Host | undefined;
  let cli: CliChannel | undefined;
  let webSocket: WebSocketChannel | undefined;
  let telegram: TelegramChannel | undefined;
  let websocketPort: number | undefined;
  let status = 0;
  const controller = new AbortController();
  const finished = Promise.withResolvers<void>();
  const stop = () => {
    controller.abort();
    finished.resolve();
  };
  try {
    const { values } = parseArgs({
      args,
      options: {
        root: { type: "string", short: "r" },
        config: { type: "string", short: "c" },
        help: { type: "boolean", short: "h" },
      },
    });
    if (values.help) {
      console.log("Usage: npm start -- [--root PATH | -r PATH] [--config FILE | -c FILE]");
      console.log(
        "Start one persistent host for owner-local CLI, Telegram and WebSocket channels. Defaults: current directory and host.json. Requires an isolated Docker network, runner image and OneCLI gateway. Configured Telegram destinations also poll the Bot API.",
      );
      return 0;
    }
    const root = resolve(values.root ?? ".");
    const loaded = await loadHostSettings(resolve(values.config ?? join(root, "host.json")));
    const operator = applyOperatorEnvironment(loaded, await readEnvFile(root, OPERATOR_ENV_KEYS));
    let settings: HostSettings = operator.settings;
    websocketPort = settings.websocket?.port;
    if (settings.telegram && !operator.credentials.telegramToken?.trim()) {
      throw new Error("Telegram bot token is required in TELEGRAM_BOT_TOKEN");
    }
    assertInternalNetwork(
      settings.network,
      await (dependencies.inspectNetwork ?? inspectDockerNetwork)(settings.network),
    );
    const paired = readPairedTelegram(root);
    if (settings.telegram && paired) {
      settings = {
        ...settings,
        configuration: mergePairedTelegram(
          settings.configuration,
          settings.telegram.instance,
          paired.platformId,
        ),
      };
    }
    const configuration = settings.configuration;
    const cliOwner = configuration.owners.find((owner) => owner.startsWith("cli:"));
    if (!cliOwner) throw new Error("Host configuration requires a CLI owner identity");
    const telegramDestinations: TelegramDestination[] = configuration.destinations
      .filter((destination) => destination.channelType === "telegram")
      .map((destination) => ({ id: destination.id, platformId: destination.platformId }));
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    dependencies.signal?.addEventListener("abort", stop, { once: true });
    if (dependencies.signal?.aborted) stop();
    if (controller.signal.aborted) return 0;
    let api: TelegramApi | undefined;
    let botName: string | undefined;
    if (settings.telegram && operator.credentials.telegramToken) {
      const token = operator.credentials.telegramToken;
      api = (dependencies.createTelegramApi ?? createTelegramApi)({ token });
      const identity = await api.getMe(controller.signal);
      botName = identity.username ? ` @${identity.username}` : "";
    }
    const gateway = new OneCliGateway({
      ...settings.gateway,
      apiKey: operator.credentials.apiKey,
      projectId: operator.credentials.projectId,
      trustDirectory: join(root, "data", "gateway-trust"),
    });
    const driver = new DockerDriver({ gateway, image: settings.image, network: settings.network });
    host = await Host.start({ root, configuration, driver });
    const cliDestination = configuration.destinations.find(
      (destination) => destination.id === settings.cliDestinationId,
    );
    cli = await CliChannel.listen({
      host,
      root,
      destinationId: settings.cliDestinationId,
      owner: cliOwner,
      instance: cliDestination?.instance,
    });
    if (settings.websocket) {
      webSocket = await WebSocketChannel.listen({
        root,
        host,
        configuration: settings.configuration,
        bindHost: settings.websocket.host,
        port: settings.websocket.port,
        path: settings.websocket.path,
      });
    }
    host.observe((event) => {
      if (event.type === "failure") console.error(`Error: ${event.error}`);
    });
    if (api && settings.telegram) {
      telegram = TelegramChannel.listen({
        host,
        api,
        instance: settings.telegram.instance,
        destinations: telegramDestinations,
        owners: configuration.owners,
        pairingRoot: root,
        registerOwner: (platformId) =>
          host?.registerTelegramOwner(platformId, settings.telegram?.instance),
        onError: (error) => console.error(`Error: ${describe(error)}`),
      });
      void telegram.start(controller.signal).catch((error: unknown) => {
        if (!controller.signal.aborted) console.error(`Error: ${describe(error)}`);
      });
    }
    console.log(`Mybots host listening on ${join(root, "data", "cli.sock")}`);
    if (webSocket) {
      const address = webSocket.address;
      const hostname = address.host.includes(":") ? `[${address.host}]` : address.host;
      console.log(`Local WebSocket interface on ws://${hostname}:${address.port}${address.path}`);
      console.log(`Local client on http://${hostname}:${address.port}/`);
      console.log(`Pair using the credential in ${join(root, "data", "client-credential")}`);
    }
    if (telegram) console.log(`Telegram bot${botName} is polling.`);
    await finished.promise;
  } catch (error) {
    if (!controller.signal.aborted) {
      console.error(`Error: ${describe(error, websocketPort)}`);
      status = 1;
    }
  } finally {
    for (const cleanup of [
      () => webSocket?.close(),
      () => cli?.close(),
      () => telegram?.stop(),
      () => host?.stop(),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        console.error(`Error: ${describe(error)}`);
        status = 1;
      }
    }
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    dependencies.signal?.removeEventListener("abort", stop);
  }
  return status;
}

if (import.meta.main) process.exitCode = await runHost(process.argv.slice(2));
