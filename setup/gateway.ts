import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

interface Network {
  IPAddress?: string;
  Aliases?: string[];
}

interface Relay {
  State: { Running: boolean };
  Config: { Cmd: string[] };
  HostConfig: { NetworkMode: string; RestartPolicy: { Name: string } };
  NetworkSettings: { Networks: Record<string, Network> };
}

/** Only the proxy relay joins the internal runner network, never the vault. */
export async function ensureRelay(
  context: SetupContext,
  url: string,
  network: string,
  alias: string,
): Promise<void> {
  let backend = "bridge";
  let host = isLocalGateway(url) ? "host.docker.internal" : new URL(url).hostname;
  if (isLocalGateway(url)) {
    const gateway = await context.exec("docker", [
      "inspect",
      "onecli",
      "--format",
      "{{json .NetworkSettings.Networks}}",
    ]);
    if (gateway.code === 0) {
      const networks = JSON.parse(gateway.stdout) as Record<string, Network>;
      const connection = Object.entries(networks).find(
        ([name, value]) => name !== network && value.IPAddress,
      );
      if (!connection) throw new SetupError("The local gateway has no separate backend network.");
      backend = connection[0];
      host = connection[1].IPAddress ?? host;
    }
  }
  const slug = installSlug(context.root, context.env.MYBOTS_INSTALL_ID || undefined);
  const name = `mybots-relay-${slug}`;
  const args = ["TCP-LISTEN:10255,fork,reuseaddr", `TCP:${host}:10255`];
  const inspected = await context.exec("docker", ["inspect", name, "--format", "{{json .}}"]);
  let existing = inspected.code === 0 ? (JSON.parse(inspected.stdout) as Relay) : undefined;
  if (
    existing &&
    (existing.HostConfig.NetworkMode !== backend ||
      JSON.stringify(existing.Config.Cmd) !== JSON.stringify(args))
  ) {
    await command(context, "docker", ["rm", "-f", name]);
    existing = undefined;
  }
  if (!existing) {
    await command(context, "docker", [
      "run",
      "--detach",
      "--restart",
      "unless-stopped",
      "--network",
      backend,
      "--name",
      name,
      "--add-host",
      "host.docker.internal:host-gateway",
      "alpine/socat",
      ...args,
    ]);
  } else {
    if (existing.HostConfig.RestartPolicy.Name !== "unless-stopped")
      await command(context, "docker", ["update", "--restart", "unless-stopped", name]);
    if (!existing.State.Running) await command(context, "docker", ["start", name]);
    const attached = existing.NetworkSettings.Networks[network];
    if (attached?.Aliases?.includes(alias)) {
      context.log("Using the existing proxy relay.");
      return;
    }
    if (attached) await command(context, "docker", ["network", "disconnect", network, name]);
  }
  await command(context, "docker", ["network", "connect", "--alias", alias, network, name]);
  context.log("Attached the proxy relay to the internal network.");
}
