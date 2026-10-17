import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connectGateway } from "../packages/host/src/config/gateway-network.ts";
import { command } from "./command.ts";
import { SetupError } from "./onecli.ts";
import { installSlug } from "./service-files.ts";
import type { SetupContext } from "./steps.ts";

export function isLocalGateway(url: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
}

/** Install the gateway itself; setup uses its HTTP API and needs no separate CLI. */
export async function installLocalGateway(context: SetupContext): Promise<void> {
  const directory = join(context.home, ".onecli");
  const file = join(directory, "docker-compose.yml");
  try {
    await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const response = await context.fetch(
      "https://raw.githubusercontent.com/onecli/onecli/v1.42.0/docker/docker-compose.yml",
      { signal: AbortSignal.timeout(30_000), redirect: "error" },
    );
    if (!response.ok) throw new SetupError("Could not download the OneCLI 1.42.0 Compose file.");
    const compose = (await response.text())
      .replaceAll(/\$\{ONECLI_VERSION:-latest\}/gu, "1.42.0")
      .replaceAll(/\$\{ONECLI_BIND_HOST:-127.0.0.1\}/gu, "127.0.0.1")
      // The gateway must not inherit credentials from an unrelated parent .env.
      .replace(/ {4}env_file:\n {6}- path: \.\.\/\.env\n {8}required: false\n/u, "");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(file, compose, { mode: 0o600 });
  }
  context.log("Starting the local OneCLI gateway.");
  await command(context, "docker", [
    "compose",
    "-p",
    "onecli",
    "-f",
    file,
    "up",
    "-d",
    "--wait",
    "--wait-timeout",
    "120",
  ]);
}

/** Attach the local gateway itself; the database stays on its backend network. */
export async function ensureDirectGateway(
  context: SetupContext,
  url: string,
  network: string,
  alias: string,
  image: string,
): Promise<void> {
  if (!isLocalGateway(url))
    throw new SetupError(
      "Direct gateway access requires a local OneCLI container; remote gateways through a relay are no longer supported.",
    );
  await connectGateway({ container: "onecli", network, alias }, (args) =>
    command(context, "docker", args),
  );
  // Probe the gateway's session IP, avoiding an old relay sharing its DNS alias.
  const probe = async (host: string) => {
    await command(context, "docker", [
      "run",
      "--rm",
      "--pull=never",
      "--network",
      network,
      "--entrypoint",
      "bun",
      image,
      "-e",
      'import { lookup } from "node:dns/promises"; const addresses = await lookup(process.argv[2], {all:true}); if (!addresses.length || addresses.some(({address}) => address !== process.argv[1])) process.exit(1); for (const [port,path] of [[10254,"/v1/health"],[10255,"/healthz"]]) { const r = await fetch("http://" + process.argv[2] + ":" + port + path, {signal: AbortSignal.timeout(5000)}); if (!r.ok) process.exit(1); }',
      networks[network].IPAddress,
      host,
    ]);
  };
  const gateway = await command(context, "docker", [
    "inspect",
    "onecli",
    "--format",
    "{{json .NetworkSettings.Networks}}",
  ]);
  const networks = JSON.parse(gateway.stdout) as Record<string, { IPAddress: string }>;
  const slug = installSlug(context.root, context.env.MYBOTS_INSTALL_ID || undefined);
  const name = `mybots-relay-${slug}`;
  const inspected = await context.exec("docker", ["inspect", name, "--format", "{{json .}}"]);
  if (inspected.code === 0) {
    const relay = JSON.parse(inspected.stdout) as {
      Config: { Image: string; Cmd: string[] };
      NetworkSettings: { Networks: Record<string, { Aliases?: string[] }> };
    };
    if (
      relay.Config.Image !== "alpine/socat" ||
      relay.Config.Cmd.length !== 2 ||
      relay.Config.Cmd[0] !== "TCP-LISTEN:10255,fork,reuseaddr" ||
      !/^TCP:[^:]+:10255$/.test(relay.Config.Cmd[1]) ||
      !Object.keys(relay.NetworkSettings.Networks).some(
        (name) => name !== network && networks[name],
      )
    )
      throw new SetupError(
        "The legacy relay does not match this installation; refusing to remove it.",
      );
    try {
      await probe(networks[network].IPAddress);
    } catch (error) {
      await command(context, "docker", ["network", "disconnect", network, "onecli"]);
      throw error;
    }
    const attached = relay.NetworkSettings.Networks[network];
    const aliases = attached?.Aliases ?? [];
    if (attached) await command(context, "docker", ["network", "disconnect", network, name]);
    try {
      await probe(alias);
    } catch (error) {
      if (attached)
        await command(context, "docker", [
          "network",
          "connect",
          ...aliases.flatMap((value) => ["--alias", value]),
          network,
          name,
        ]);
      await command(context, "docker", ["network", "disconnect", network, "onecli"]);
      throw error;
    }
    await command(context, "docker", ["rm", "-f", name]);
  } else {
    await probe(networks[network].IPAddress);
    await probe(alias);
  }
  context.log("Verified direct OneCLI access on the internal network.");
}
