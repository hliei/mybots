import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CliChannel } from "./channels/cli.ts";
import { loadHostSettings } from "./config/host.ts";
import { DockerDriver } from "./drivers/docker-driver.ts";
import { OneCliGateway } from "./gateway-providers/onecli.ts";
import { Host } from "./host.ts";

export async function runHost(args: string[]): Promise<number> {
  let host: Host | undefined;
  let cli: CliChannel | undefined;
  let status = 0;
  const finished = Promise.withResolvers<void>();
  const stop = () => finished.resolve();
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
        "Start one owner-local host. Defaults: current directory and host.json. Requires an isolated Docker network, runner image and OneCLI gateway.",
      );
      return 0;
    }
    const root = resolve(values.root ?? ".");
    const settings = await loadHostSettings(resolve(values.config ?? join(root, "host.json")));
    const gateway = new OneCliGateway({
      ...settings.gateway,
      apiKey: process.env.MYBOTS_ONECLI_API_KEY,
      projectId: process.env.MYBOTS_ONECLI_PROJECT_ID,
      trustDirectory: join(root, "data", "gateway-trust"),
    });
    const driver = new DockerDriver({ gateway, image: settings.image, network: settings.network });
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    host = await Host.start({ root, configuration: settings.configuration, driver });
    const destination = settings.configuration.destinations.find(
      (destination) => destination.id === settings.cliDestinationId,
    );
    cli = await CliChannel.listen({
      host,
      root,
      destinationId: settings.cliDestinationId,
      owner: settings.configuration.owner,
      instance: destination?.instance,
    });
    host.observe((event) => {
      if (event.type === "failure") console.error(`Error: ${event.error}`);
    });
    console.log(`Mybots host listening on ${join(root, "data", "cli.sock")}`);
    await finished.promise;
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : "Host startup failed"}`);
    status = 1;
  } finally {
    try {
      await cli?.close();
      await host?.stop();
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : "Host shutdown failed"}`);
      status = 1;
    }
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
  return status;
}

if (import.meta.main) process.exitCode = await runHost(process.argv.slice(2));
