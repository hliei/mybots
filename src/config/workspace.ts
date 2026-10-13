import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";

export interface ModelSettings {
  provider: string;
  model: string;
  api_key: string;
  api_base: string | null;
  temperature: number;
  max_tokens: number;
  thinking: boolean;
  context_window?: number;
}

export interface WebSearchSettings {
  provider: "brave" | "serpapi";
  api_key: string;
  api_base?: string;
}

export type FetchContentSettings = Record<string, never>;

export interface TelegramSettings {
  enabled: boolean;
  bot_token: string;
  allowed_user_ids: string[];
}

export interface ChannelSettings {
  enabled: boolean;
  telegram?: TelegramSettings;
}

export interface ApiSettings {
  enabled: boolean;
  host: string;
  port: number;
}

export interface SourceSessionSettings {
  session_id: string;
}

export interface WorkspaceSettings {
  workspace: string;
  llm: ModelSettings;
  default_agent: string;
  agents_path: string;
  skills_path: string;
  history_path: string;
  logging_path: string;
  event_path: string;
  channels: ChannelSettings;
  api: ApiSettings;
  sources: Record<string, SourceSessionSettings>;
  default_delivery_source: string | null;
  web_search?: WebSearchSettings;
  fetch_content?: FetchContentSettings;
}

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  agent_md: string;
  llm: ModelSettings;
  allow_skills: boolean;
}

function mapping(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${field} must be a mapping.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${field} must be a nonempty string.`);
  return value;
}

function optionalText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  return value;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean.`);
  return value;
}

function modelSettings(raw: Record<string, unknown>): ModelSettings {
  const provider = text(raw.provider === undefined ? "deepseek" : raw.provider, "llm.provider");
  if (provider !== "deepseek") throw new Error("Only the deepseek provider is supported.");
  const api_base = raw.api_base == null ? null : text(raw.api_base, "llm.api_base");
  if (api_base !== null) {
    const url = new URL(api_base);
    if (!["http:", "https:"].includes(url.protocol))
      throw new Error("llm.api_base must be an HTTP(S) URL.");
  }
  const temperature = raw.temperature === undefined ? 0.7 : raw.temperature;
  if (
    typeof temperature !== "number" ||
    !Number.isFinite(temperature) ||
    temperature < 0 ||
    temperature > 2
  ) {
    throw new Error("llm.temperature must be between 0 and 2.");
  }
  const max_tokens = raw.max_tokens === undefined ? 2048 : raw.max_tokens;
  if (typeof max_tokens !== "number" || !Number.isInteger(max_tokens) || max_tokens <= 0) {
    throw new Error("llm.max_tokens must be a positive integer.");
  }
  const context_window = raw.context_window;
  if (
    context_window !== undefined &&
    (typeof context_window !== "number" ||
      !Number.isSafeInteger(context_window) ||
      context_window <= 0)
  ) {
    throw new Error("llm.context_window must be a positive integer.");
  }
  return {
    ...(context_window !== undefined ? { context_window } : {}),
    provider,
    model: text(raw.model === undefined ? "deepseek-flash" : raw.model, "llm.model"),
    api_key: text(raw.api_key, "llm.api_key"),
    api_base,
    temperature,
    max_tokens,
    thinking: boolean(raw.thinking === undefined ? true : raw.thinking, "llm.thinking"),
  };
}

export function parseSettingsSource(source: string, field: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = parse(source);
  } catch {
    throw new Error(`Invalid YAML in ${field}.`);
  }
  return mapping(value ?? {}, field);
}

function webSearchSettings(value: unknown): WebSearchSettings | undefined {
  if (value == null) return undefined;
  const raw = mapping(value, "web_search");
  const provider = raw.provider;
  if (provider !== "brave" && provider !== "serpapi")
    throw new Error("web_search.provider must explicitly select brave or serpapi.");
  const api_key = text(raw.api_key, "web_search.api_key");
  if (raw.api_base == null) return { provider, api_key };
  const api_base = text(raw.api_base, "web_search.api_base");
  let url: URL;
  try {
    url = new URL(api_base);
  } catch {
    throw new Error("web_search.api_base must be a complete HTTP(S) URL.");
  }
  if (!/^https?:\/\/[^/]/i.test(api_base) || !["http:", "https:"].includes(url.protocol))
    throw new Error("web_search.api_base must be a complete HTTP(S) URL.");
  return { provider, api_key, api_base };
}

function fetchContentSettings(value: unknown): FetchContentSettings | undefined {
  if (value == null) return undefined;
  const raw = mapping(value, "fetch_content");
  if (Object.keys(raw).length)
    throw new Error("fetch_content must be an empty mapping; no provider selector is supported.");
  return {};
}

function channelSettings(value: unknown): ChannelSettings {
  const raw = mapping(value, "channels");
  const enabled = boolean(raw.enabled === undefined ? false : raw.enabled, "channels.enabled");
  if (raw.telegram === undefined || raw.telegram === null) return { enabled };
  const telegram = mapping(raw.telegram, "channels.telegram");
  const telegramEnabled = boolean(
    telegram.enabled === undefined ? false : telegram.enabled,
    "channels.telegram.enabled",
  );
  const token =
    telegram.bot_token === undefined
      ? ""
      : optionalText(telegram.bot_token, "channels.telegram.bot_token");
  if (telegramEnabled) text(token, "channels.telegram.bot_token");
  const ids = telegram.allowed_user_ids === undefined ? [] : telegram.allowed_user_ids;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !/^\d+$/.test(id))) {
    throw new Error("channels.telegram.allowed_user_ids must be an array of numeric ID strings.");
  }
  return {
    enabled,
    telegram: { enabled: telegramEnabled, bot_token: token, allowed_user_ids: ids },
  };
}

function apiSettings(value: unknown): ApiSettings {
  const raw = mapping(value, "api");
  const port = raw.port === undefined ? 8000 : raw.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port >= 65536) {
    throw new Error("api.port must be an integer between 1 and 65535.");
  }
  return {
    enabled: boolean(raw.enabled === undefined ? false : raw.enabled, "api.enabled"),
    host: text(raw.host === undefined ? "127.0.0.1" : raw.host, "api.host"),
    port,
  };
}

function sourceSettings(value: unknown): Record<string, SourceSessionSettings> {
  return Object.fromEntries(
    Object.entries(mapping(value, "sources")).map(([source, entry]) => [
      text(source, "source"),
      {
        session_id: text(
          mapping(entry, `sources.${source}`).session_id,
          `sources.${source}.session_id`,
        ),
      },
    ]),
  );
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function mergeSettings(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    Object.defineProperty(result, key, {
      value: isMapping(result[key]) && isMapping(value) ? mergeSettings(result[key], value) : value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

export async function readSettingsFile(path: string): Promise<Record<string, unknown>> {
  try {
    return parseSettingsSource(await readFile(path, "utf8"), path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}

export async function readWorkspaceSettings(workspace: string): Promise<WorkspaceSettings> {
  workspace = resolve(workspace);
  try {
    return validateSettings(
      workspace,
      mergeSettings(
        await readSettingsFile(resolve(workspace, "config.user.yaml")),
        await readSettingsFile(resolve(workspace, "config.runtime.yaml")),
      ),
    );
  } catch (error) {
    throw new Error(
      `Invalid configuration in config.user.yaml/config.runtime.yaml: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function validateSettings(
  workspace: string,
  raw: Record<string, unknown>,
): WorkspaceSettings {
  if ("websearch" in raw || "webread" in raw)
    throw new Error(
      "Legacy websearch/webread configuration is unsupported. Migrate websearch to web_search with an explicit brave or serpapi provider and nonempty api_key; replace webread with fetch_content: {}.",
    );
  const llm = modelSettings(mapping(raw.llm, "llm"));
  const config: WorkspaceSettings = {
    workspace,
    llm,
    default_agent: text(raw.default_agent, "default_agent"),
    agents_path: resolve(
      workspace,
      text(raw.agents_path === undefined ? ".agents/bots" : raw.agents_path, "agents_path"),
    ),
    skills_path: resolve(
      workspace,
      text(raw.skills_path === undefined ? ".agents/skills" : raw.skills_path, "skills_path"),
    ),
    history_path: resolve(
      workspace,
      text(raw.history_path === undefined ? ".history" : raw.history_path, "history_path"),
    ),
    logging_path: resolve(
      workspace,
      text(raw.logging_path === undefined ? ".logs" : raw.logging_path, "logging_path"),
    ),
    event_path: resolve(
      workspace,
      text(raw.event_path === undefined ? ".event" : raw.event_path, "event_path"),
    ),
    channels: channelSettings(raw.channels),
    api: apiSettings(raw.api),
    sources: sourceSettings(raw.sources),
    default_delivery_source:
      raw.default_delivery_source == null
        ? null
        : text(raw.default_delivery_source, "default_delivery_source"),
    web_search: webSearchSettings(raw.web_search),
    fetch_content: fetchContentSettings(raw.fetch_content),
  };
  return config;
}

export async function loadAgentDefinition(
  config: WorkspaceSettings,
  id: string,
): Promise<AgentDefinition> {
  const source = (await readFile(resolve(config.agents_path, id, "AGENT.md"), "utf8")).replace(
    /\r\n/g,
    "\n",
  );
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(source);
  const metadata = parseSettingsSource(frontmatter?.[1] ?? "", "Agent frontmatter");
  const definition: AgentDefinition = {
    id,
    name: text(metadata.name, "Agent name"),
    description:
      metadata.description === undefined
        ? ""
        : optionalText(metadata.description, "Agent description"),
    agent_md: (frontmatter?.[2] ?? source).trim(),
    llm: modelSettings({ ...config.llm, ...mapping(metadata.llm ?? {}, "Agent llm") }),
    allow_skills: boolean(
      metadata.allow_skills === undefined ? false : metadata.allow_skills,
      "allow_skills",
    ),
  };
  return definition;
}

export async function loadSettings(
  workspace: string,
  agentId?: string,
): Promise<{
  config: WorkspaceSettings;
  definition: AgentDefinition;
}> {
  const config = await readWorkspaceSettings(workspace);
  return { config, definition: await loadAgentDefinition(config, agentId ?? config.default_agent) };
}
