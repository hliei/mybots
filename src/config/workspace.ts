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

export interface WorkspaceSettings {
  workspace: string;
  llm: ModelSettings;
  default_agent: string;
  agents_path: string;
  skills_path: string;
  history_path: string;
  websearch?: unknown;
  webread?: unknown;
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
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value))
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
  const provider = text(raw.provider ?? "deepseek", "llm.provider");
  if (provider !== "deepseek") throw new Error("Only the deepseek provider is supported.");
  const api_base = raw.api_base == null ? null : text(raw.api_base, "llm.api_base");
  if (api_base !== null) {
    const url = new URL(api_base);
    if (!["http:", "https:"].includes(url.protocol))
      throw new Error("llm.api_base must be an HTTP(S) URL.");
  }
  const temperature = raw.temperature ?? 0.7;
  if (
    typeof temperature !== "number" ||
    !Number.isFinite(temperature) ||
    temperature < 0 ||
    temperature > 2
  ) {
    throw new Error("llm.temperature must be between 0 and 2.");
  }
  const max_tokens = raw.max_tokens ?? 2048;
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
    model: text(raw.model ?? "deepseek-flash", "llm.model"),
    api_key: text(raw.api_key, "llm.api_key"),
    api_base,
    temperature,
    max_tokens,
    thinking: boolean(raw.thinking ?? true, "llm.thinking"),
  };
}

function yamlMapping(source: string, field: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = parse(source);
  } catch {
    throw new Error(`Invalid YAML in ${field}.`);
  }
  return mapping(value, field);
}

export async function loadSettings(
  workspace: string,
  agentId?: string,
): Promise<{
  config: WorkspaceSettings;
  definition: AgentDefinition;
}> {
  workspace = resolve(workspace);
  const raw = yamlMapping(
    await readFile(resolve(workspace, "config.user.yaml"), "utf8"),
    "workspace configuration",
  );
  const llm = modelSettings(mapping(raw.llm, "llm"));
  const config: WorkspaceSettings = {
    workspace,
    llm,
    default_agent: text(raw.default_agent, "default_agent"),
    agents_path: resolve(workspace, text(raw.agents_path ?? ".agents/bots", "agents_path")),
    skills_path: resolve(workspace, text(raw.skills_path ?? ".agents/skills", "skills_path")),
    history_path: resolve(workspace, text(raw.history_path ?? ".history", "history_path")),
    websearch: raw.websearch,
    webread: raw.webread,
  };
  const id = agentId ?? config.default_agent;
  const source = (await readFile(resolve(config.agents_path, id, "AGENT.md"), "utf8")).replace(
    /\r\n/g,
    "\n",
  );
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(source);
  const metadata = yamlMapping(frontmatter?.[1] ?? "", "Agent frontmatter");
  const definition: AgentDefinition = {
    id,
    name: text(metadata.name, "Agent name"),
    description:
      metadata.description === undefined
        ? ""
        : optionalText(metadata.description, "Agent description"),
    agent_md: (frontmatter?.[2] ?? source).trim(),
    llm: modelSettings({ ...llm, ...mapping(metadata.llm, "Agent llm") }),
    allow_skills: boolean(metadata.allow_skills ?? false, "allow_skills"),
  };
  return { config, definition };
}
