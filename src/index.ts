import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CliChannel } from "./channels/cli.ts";
import { TelegramChannel, type TelegramDestination } from "./channels/telegram.ts";
import { createTelegramApi, type TelegramApi } from "./channels/telegram-api.ts";
import { loadHostSettings } from "./config/host.ts";
import { DockerDriver } from "./drivers/docker-driver.ts";
import { OneCliGateway } from "./gateway-providers/onecli.ts";
import { Host } from "./host.ts";

export interface HostDependencies {
  /** Test/embedding hook for the Bot API boundary; production uses the Bot API. */
  createTelegramApi?: (options: { token: string }) => TelegramApi;
  /** Test/embedding hook that requests the same shutdown as SIGINT/SIGTERM. */
  signal?: AbortSignal;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runHost(
  args: string[],
  dependencies: HostDependencies = {},
): Promise<number> {
  let host: Host | undefined;
  let cli: CliChannel | undefined;
  let telegram: TelegramChannel | undefined;
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
      console.log("Usage: npm run start:host -- [--root PATH | -r PATH] [--config FILE | -c FILE]");
      console.log(
        "Start one owner-local host. Defaults: current directory and host.json. Requires an isolated Docker network, runner image and OneCLI gateway. Configured Telegram destinations also poll the Bot API.",
      );
      return 0;
    }
    const root = resolve(values.root ?? ".");
    const settings = await loadHostSettings(resolve(values.config ?? join(root, "host.json")));
    const configuration = settings.configuration;
    const cliOwner = configuration.owners.find((owner) => owner.startsWith("cli:"));
    if (!cliOwner) throw new Error("Host configuration requires a CLI owner identity");
    const telegramDestinations: TelegramDestination[] = configuration.destinations
      .filter((destination) => destination.channelType === "telegram")
      .map((destination) => ({ id: destination.id, platformId: destination.platformId }));
    let api: TelegramApi | undefined;
    let botName: string | undefined;
    if (settings.telegram) {
      const token = process.env[settings.telegram.botTokenEnv];
      if (!token?.trim())
        throw new Error(`Telegram bot token is required in ${settings.telegram.botTokenEnv}`);
      api = (dependencies.createTelegramApi ?? createTelegramApi)({ token });
      const identity = await api.getMe(controller.signal);
      botName = identity.username ? ` @${identity.username}` : "";
    }
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    dependencies.signal?.addEventListener("abort", stop, { once: true });
    if (dependencies.signal?.aborted) stop();
    if (controller.signal.aborted) return 0;
    const gateway = new OneCliGateway({
      ...settings.gateway,
      apiKey: process.env.MYBOTS_ONECLI_API_KEY,
      projectId: process.env.MYBOTS_ONECLI_PROJECT_ID,
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
        onError: (error) => console.error(`Error: ${describe(error)}`),
      });
      void telegram.start(controller.signal).catch((error: unknown) => {
        if (!controller.signal.aborted) console.error(`Error: ${describe(error)}`);
      });
    }
    console.log(`Mybots host listening on ${join(root, "data", "cli.sock")}`);
    if (telegram) console.log(`Telegram bot${botName} is polling.`);
    await finished.promise;
  } catch (error) {
    console.error(`Error: ${describe(error)}`);
    status = 1;
  } finally {
    for (const cleanup of [() => cli?.close(), () => telegram?.stop(), () => host?.stop()]) {
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
