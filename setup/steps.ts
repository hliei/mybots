import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";

import {
  completePairing,
  createPairingCode,
  readPairingState,
  writePairingState,
} from "../packages/host/src/channels/telegram-pairing.ts";
import { readPairedTelegram } from "../packages/host/src/db/index.ts";
import { command } from "./command.ts";
import { ensureOperatorDefaults, readEnvFile, upsertEnv } from "./env.ts";
import { ensureRelay, installLocalGateway, isLocalGateway } from "./gateway.ts";
import {
  agentId,
  enableTelegram,
  ensureHostJson,
  ensureWorkspaceInstructions,
  hostnameOf,
} from "./host-file.ts";
import { checkGatewayHealth, registerBearerSecret, SetupError } from "./onecli.ts";
import {
  installSlug,
  launchdPlistPath,
  proxyAssignments,
  renderLaunchdPlist,
  renderStartScript,
  renderSystemdUnit,
  serviceLabel,
  serviceUnitName,
  systemdSystemPath,
  systemdUserPath,
} from "./service-files.ts";

export const SETUP_STEPS = [
  "container",
  "gateway",
  "provider-auth",
  "service",
  "pair-telegram",
  "verify",
] as const;

export type SetupStepName = (typeof SETUP_STEPS)[number];

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SetupContext {
  root: string;
  env: NodeJS.ProcessEnv;
  platform: "darwin" | "linux" | "wsl";
  uid: number;
  home: string;
  nodePath: string;
  isTTY: boolean;
  fetch: typeof fetch;
  exec(command: string, args: string[]): Promise<CommandResult>;
  prompt(spec: { secret: boolean; message: string }): Promise<string>;
  log(line: string): void;
  waitForPairing?(root: string): Promise<void>;
}

const TOKEN_PATTERN = /^[0-9]+:[A-Za-z0-9_-]{35,}$/u;

async function prepare(context: SetupContext): Promise<Record<string, string>> {
  const values = await ensureOperatorDefaults(context.root, context.env);
  await ensureHostJson(context.root, values);
  await ensureWorkspaceInstructions(context.root);
  return values;
}

export async function runSetupStep(step: SetupStepName, context: SetupContext): Promise<void> {
  if (step === "container") await containerStep(context);
  else if (step === "gateway") await gatewayStep(context);
  else if (step === "provider-auth") await providerAuthStep(context);
  else if (step === "service") await serviceStep(context);
  else if (step === "pair-telegram") await pairTelegramStep(context);
  else await verifyStep(context);
}

async function containerStep(context: SetupContext): Promise<void> {
  const values = await prepare(context);
  const image = values.CONTAINER_IMAGE ?? "mybots-agent:mailbox";
  const network = values.CONTAINER_NETWORK ?? "mybots-isolated";
  context.log(`Building ${image}.`);
  await command(context, "docker", [
    "build",
    "-t",
    image,
    "-f",
    join(context.root, "container/Dockerfile"),
    context.root,
  ]);
  const inspected = await context.exec("docker", [
    "network",
    "inspect",
    network,
    "--format",
    "{{.Internal}}",
  ]);
  if (inspected.code !== 0) {
    context.log(`Creating internal network ${network}.`);
    await command(context, "docker", ["network", "create", "--internal", network]);
    return;
  }
  if (inspected.stdout.trim() !== "true") {
    throw new SetupError(
      `Docker network ${network} exists and is not internal. Refusing to recreate it.`,
    );
  }
  context.log(`Using internal network ${network}.`);
}

async function gatewayStep(context: SetupContext): Promise<void> {
  const values = await prepare(context);
  const url = values.ONECLI_URL ?? "http://127.0.0.1:10254";
  if (!isLocalGateway(url) && !values.ONECLI_API_KEY) {
    throw new SetupError("ONECLI_API_KEY is required for a remote gateway.");
  }
  if (values.ONECLI_URL) {
    await checkGatewayHealth(url, context.fetch);
    context.log("Keeping the configured OneCLI gateway.");
  } else {
    try {
      await checkGatewayHealth(url, context.fetch);
      context.log("Reusing the local OneCLI gateway.");
    } catch (error) {
      if (error instanceof Error && error.message.includes("does not provide /v1")) throw error;
      await installLocalGateway(context);
      await checkGatewayHealth(url, context.fetch);
    }
  }
  await upsertEnv(context.root, {
    ONECLI_URL: url,
    ...(values.ONECLI_API_KEY ? { ONECLI_API_KEY: values.ONECLI_API_KEY } : {}),
  });
  const updated = await readEnvFile(
    context.root,
    ["ONECLI_URL", "GATEWAY_PROXY_HOST", "CONTAINER_NETWORK"],
    context.env,
  );
  await ensureHostJson(context.root, updated);
  await ensureRelay(
    context,
    url,
    values.CONTAINER_NETWORK ?? "mybots-isolated",
    values.GATEWAY_PROXY_HOST ?? "onecli",
  );
}

async function providerAuthStep(context: SetupContext): Promise<void> {
  const values = await prepare(context);
  if (!values.ONECLI_URL || (!isLocalGateway(values.ONECLI_URL) && !values.ONECLI_API_KEY)) {
    throw new SetupError("Configure the OneCLI gateway before registering a model key.");
  }
  const modelHost = hostnameOf(values.MODEL_BASE_URL ?? "https://api.deepseek.com");
  const searchHost =
    values.WEB_SEARCH_PROVIDER && values.WEB_SEARCH_ENDPOINT
      ? hostnameOf(values.WEB_SEARCH_ENDPOINT)
      : undefined;
  if (searchHost && searchHost === modelHost) {
    throw new SetupError(
      "The model endpoint and search endpoint use the same hostname. Use a different search host so the keys stay separate.",
    );
  }
  const settings = await ensureHostJson(context.root, values);
  const id = agentId(settings);
  const modelKey = await secretValue(context, "MYBOTS_MODEL_API_KEY", "Model API key: ");
  if (!modelKey.trim()) throw new SetupError("The model API key is empty.");
  await registerBearerSecret({
    url: values.ONECLI_URL,
    apiKey: values.ONECLI_API_KEY ?? "",
    ...(values.ONECLI_PROJECT_ID ? { projectId: values.ONECLI_PROJECT_ID } : {}),
    hostname: modelHost,
    value: modelKey,
    agentId: id,
    fetchImpl: context.fetch,
  });
  context.log(`Registered the model key for ${modelHost}.`);
  if (searchHost && values.WEB_SEARCH_ENDPOINT) {
    const searchKey = await secretValue(context, "MYBOTS_SEARCH_API_KEY", "Search API key: ");
    if (!searchKey.trim()) throw new SetupError("The search API key is empty.");
    await registerBearerSecret({
      url: values.ONECLI_URL,
      apiKey: values.ONECLI_API_KEY ?? "",
      ...(values.ONECLI_PROJECT_ID ? { projectId: values.ONECLI_PROJECT_ID } : {}),
      hostname: searchHost,
      value: searchKey,
      agentId: id,
      fetchImpl: context.fetch,
    });
    context.log(`Registered the search key for ${searchHost}.`);
  }
}

async function secretValue(context: SetupContext, name: string, message: string): Promise<string> {
  const present = context.env[name];
  if (typeof present === "string" && present.trim()) return present;
  if (!context.isTTY) throw new SetupError(`${name} is required when setup has no terminal.`);
  return context.prompt({ secret: true, message });
}

async function serviceStep(context: SetupContext): Promise<void> {
  const values = await prepare(context);
  context.log("Compiling the host.");
  await command(context, "npm", ["run", "build"]);
  const slug = installSlug(context.root, context.env.MYBOTS_INSTALL_ID || undefined);
  const proxy: Record<string, string> = {};
  for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY"] as const) {
    const value = values[key];
    if (value) proxy[key] = value;
  }
  const paths = {
    root: context.root,
    nodePath: context.nodePath,
    home: context.home,
    slug,
    path: context.env.PATH ?? "",
    proxy,
  };
  await mkdir(join(context.root, "logs"), { recursive: true });
  await mkdir(join(context.root, "data"), { recursive: true, mode: 0o700 });
  const proxyFile = join(context.root, "data", "service-proxy.env");
  if (Object.keys(proxy).length > 0) {
    await writeFile(proxyFile, proxyAssignments(proxy), { mode: 0o600 });
    await chmod(proxyFile, 0o600);
  } else {
    await rm(proxyFile, { force: true });
  }
  if (context.platform === "darwin") {
    const file = launchdPlistPath(context.home, slug);
    await mkdir(join(context.home, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(file, renderLaunchdPlist(paths), { mode: 0o644 });
    const domain = `gui/${context.uid}`;
    await context.exec("launchctl", ["bootout", domain, file]);
    await command(context, "launchctl", ["bootstrap", domain, file]);
    await command(context, "launchctl", ["kickstart", "-k", `${domain}/${serviceLabel(slug)}`]);
  } else if (context.platform === "linux") {
    const rootInstall = context.uid === 0;
    const file = rootInstall ? systemdSystemPath(slug) : systemdUserPath(context.home, slug);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, renderSystemdUnit(paths));
    const systemctl = rootInstall ? ["systemctl"] : ["systemctl", "--user"];
    await command(context, systemctl[0] ?? "systemctl", [...systemctl.slice(1), "daemon-reload"]);
    await command(context, systemctl[0] ?? "systemctl", [
      ...systemctl.slice(1),
      "enable",
      serviceUnitName(slug),
    ]);
    await restartService(context);
    if (!rootInstall) await command(context, "loginctl", ["enable-linger", context.env.USER ?? ""]);
  } else {
    const file = join(context.root, "start-mybots.sh");
    await writeFile(file, renderStartScript(paths), { mode: 0o755 });
    await chmod(file, 0o755);
    await command(context, "bash", [file]);
  }
  context.log("Started the host service.");
}

async function restartService(context: SetupContext): Promise<void> {
  const slug = installSlug(context.root, context.env.MYBOTS_INSTALL_ID || undefined);
  if (context.platform === "darwin") {
    await command(context, "launchctl", [
      "kickstart",
      "-k",
      `gui/${context.uid}/${serviceLabel(slug)}`,
    ]);
  } else if (context.platform === "linux") {
    const args =
      context.uid === 0
        ? ["restart", serviceUnitName(slug)]
        : ["--user", "restart", serviceUnitName(slug)];
    await command(context, "systemctl", args);
  } else {
    await command(context, "bash", [join(context.root, "start-mybots.sh")]);
  }
}

async function pairTelegramStep(context: SetupContext): Promise<void> {
  const values = await prepare(context);
  const existing = values.TELEGRAM_BOT_TOKEN;
  if (!existing && context.isTTY) {
    const answer = (await context.prompt({ secret: false, message: "Pair Telegram now? [Y/n] " }))
      .trim()
      .toLowerCase();
    if (answer.startsWith("n")) {
      context.log("Skipped Telegram.");
      return;
    }
  }
  let token: string | undefined = existing;
  if (existing && context.isTTY) {
    const answer = (
      await context.prompt({
        secret: false,
        message: "Keep the existing Telegram bot token? [Y/n] ",
      })
    )
      .trim()
      .toLowerCase();
    if (answer.startsWith("n")) token = undefined;
  }
  if (!token) {
    token = await secretValue(context, "TELEGRAM_BOT_TOKEN", "BotFather token: ");
  }
  if (!TOKEN_PATTERN.test(token)) throw new SetupError("The BotFather token format is invalid.");
  const identity = await context.fetch(`https://api.telegram.org/bot${token}/getMe`);
  if (!identity.ok) throw new SetupError("Telegram rejected the bot token.");
  await upsertEnv(context.root, { TELEGRAM_BOT_TOKEN: token });
  await enableTelegram(context.root);
  context.log("Saved the Telegram bot token.");
  try {
    await restartService(context);
  } catch {
    throw new SetupError("Restart the service with the service step before pairing Telegram.");
  }
  const code = createPairingCode();
  await writePairingState(context.root, { code, wrongs: 0 });
  const pairingFile = join(context.root, "data", "telegram-pairing.json");
  const discard = () => {
    void rm(pairingFile, { force: true });
  };
  process.once("SIGINT", discard);
  process.once("SIGTERM", discard);
  try {
    process.stdout.write(`Pairing code: ${code}\n`);
    context.log("Waiting for the Telegram pairing code.");
    if (context.waitForPairing) await context.waitForPairing(context.root);
    else await pollPairing(context.root);
  } finally {
    process.off("SIGINT", discard);
    process.off("SIGTERM", discard);
    await completePairing(context.root);
  }
  context.log("Telegram pairing completed.");
}

async function pollPairing(root: string): Promise<void> {
  const deadline = Date.now() + 10 * 60 * 1000;
  let seen = (await readPairingState(root))?.code;
  while (Date.now() < deadline) {
    const state = await readPairingState(root);
    if (!state) throw new SetupError("Pairing stopped. Run pair-telegram again for a new code.");
    if (state.pairedOwner && readPairedTelegram(root)?.platformId === state.pairedOwner) return;
    if (state.code !== seen) {
      seen = state.code;
      process.stdout.write(`Pairing code: ${state.code}\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await rm(join(root, "data", "telegram-pairing.json"), { force: true });
  throw new SetupError("Pairing timed out. Run pair-telegram again for a new code.");
}

async function verifyStep(context: SetupContext): Promise<void> {
  const values = await prepare(context);
  const image = values.CONTAINER_IMAGE ?? "mybots-agent:mailbox";
  const network = values.CONTAINER_NETWORK ?? "mybots-isolated";
  await command(context, "docker", ["image", "inspect", image]);
  const inspected = await command(context, "docker", [
    "network",
    "inspect",
    network,
    "--format",
    "{{.Internal}}",
  ]);
  if (inspected.stdout.trim() !== "true") {
    throw new SetupError(`Docker network ${network} must exist and be internal.`);
  }
  if (!values.ONECLI_URL) throw new SetupError("ONECLI_URL is not configured.");
  await checkGatewayHealth(values.ONECLI_URL, context.fetch);
  try {
    await assertServiceRunning(context);
  } catch {
    throw new SetupError("The host service is not running. Run the service step.");
  }
  await assertCliSocket(context.root);
  context.log("Host service is running.");
  const hostFile = JSON.parse(await readFile(join(context.root, "host.json"), "utf8")) as {
    telegram?: unknown;
  };
  if (hostFile.telegram !== undefined) {
    if (!values.TELEGRAM_BOT_TOKEN) {
      throw new SetupError("TELEGRAM_BOT_TOKEN is required when Telegram is enabled.");
    }
    const identity = await context.fetch(
      `https://api.telegram.org/bot${values.TELEGRAM_BOT_TOKEN}/getMe`,
    );
    if (!identity.ok) throw new SetupError("Telegram getMe failed during verify.");
    context.log("Telegram getMe succeeded.");
  }
}

function assertCliSocket(root: string): Promise<void> {
  const file = join(root, "data", "cli.sock");
  return new Promise((resolve, reject) => {
    const socket = createConnection(file);
    const fail = () => reject(new SetupError("The CLI socket is not accepting connections."));
    socket.setTimeout(2000);
    socket.once("connect", () => {
      socket.end();
      resolve();
    });
    socket.once("timeout", () => {
      socket.destroy();
      fail();
    });
    socket.once("error", fail);
  });
}

async function assertServiceRunning(context: SetupContext): Promise<void> {
  const slug = installSlug(context.root, context.env.MYBOTS_INSTALL_ID || undefined);
  if (context.platform === "darwin") {
    await command(context, "launchctl", ["print", `gui/${context.uid}/${serviceLabel(slug)}`]);
  } else if (context.platform === "linux") {
    const args =
      context.uid === 0
        ? ["is-active", "--quiet", serviceUnitName(slug)]
        : ["--user", "is-active", "--quiet", serviceUnitName(slug)];
    await command(context, "systemctl", args);
  } else {
    await command(context, "bash", [
      "-c",
      `kill -0 "$(cat ${JSON.stringify(join(context.root, "mybots.pid"))})"`,
    ]);
  }
}
