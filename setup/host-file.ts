import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface JsonRecord {
  [key: string]: unknown;
}

function object(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid host.json");
  return value as JsonRecord;
}

/** Create host.json from the example, then refresh only the env-backed fields. */
export async function ensureHostJson(
  root: string,
  values: Record<string, string>,
): Promise<JsonRecord> {
  const example = object(JSON.parse(await readFile(join(root, "examples/host/host.json"), "utf8")));
  let current = example;
  try {
    current = object(JSON.parse(await readFile(join(root, "host.json"), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const agent = object(current.agent ?? example.agent);
  const model = object(agent.model ?? object(example.agent).model);
  const container = object(current.container ?? example.container);
  const gateway = object(current.gateway ?? example.gateway);
  if (values.MODEL_PROVIDER) model.provider = values.MODEL_PROVIDER;
  if (values.MODEL_ID) model.id = values.MODEL_ID;
  if (values.MODEL_BASE_URL) model.baseUrl = values.MODEL_BASE_URL;
  if (values.MODEL_CONTEXT_WINDOW) model.contextWindow = Number(values.MODEL_CONTEXT_WINDOW);
  if (values.MODEL_MAX_TOKENS) model.maxTokens = Number(values.MODEL_MAX_TOKENS);
  if (values.CONTAINER_IMAGE) container.image = values.CONTAINER_IMAGE;
  if (values.CONTAINER_NETWORK) container.network = values.CONTAINER_NETWORK;
  if (values.ONECLI_URL) gateway.url = values.ONECLI_URL;
  if (values.GATEWAY_PROXY_HOST) gateway.proxyHost = values.GATEWAY_PROXY_HOST;
  const searchProvider = values.WEB_SEARCH_PROVIDER;
  const searchEndpoint = values.WEB_SEARCH_ENDPOINT;
  if (searchProvider && searchEndpoint) {
    const web = object(agent.web ?? {});
    web.search = { provider: searchProvider, endpoint: searchEndpoint };
    agent.web = web;
  }
  agent.model = model;
  const next: JsonRecord = { ...example, ...current, agent, container, gateway };
  await writeFile(join(root, "host.json"), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export async function enableTelegram(root: string): Promise<void> {
  const current = object(JSON.parse(await readFile(join(root, "host.json"), "utf8")));
  current.telegram = { instance: "telegram" };
  await writeFile(join(root, "host.json"), `${JSON.stringify(current, null, 2)}\n`);
}

export async function ensureWorkspaceInstructions(root: string): Promise<void> {
  const target = join(root, "groups", "personal", "AGENTS.md");
  try {
    await readFile(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(join(root, "groups", "personal"), { recursive: true });
    await copyFile(join(root, "examples/host/groups/personal/AGENTS.md"), target);
  }
}

export function agentId(settings: JsonRecord): string {
  const agent = object(settings.agent);
  const id = agent.id;
  return typeof id === "string" && id ? id : "personal";
}

export function hostnameOf(url: string): string {
  return new URL(url).hostname;
}
