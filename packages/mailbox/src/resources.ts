import type { AgentResources, WebConfiguration } from "./types.ts";

/** Validate the non-secret resource selection shared by host and runner. */
export function validateAgentResources(value: unknown): AgentResources | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Agent resources");
  const source = value as Record<string, unknown>;
  const result: AgentResources = {};
  if (source.skills !== undefined) {
    if (
      !Array.isArray(source.skills) ||
      !source.skills.every(
        (name) => typeof name === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name),
      ) ||
      new Set(source.skills).size !== source.skills.length
    )
      throw new Error("Invalid Agent Skill selection");
    result.skills = source.skills;
  }
  if (source.tools !== undefined) {
    if (
      !Array.isArray(source.tools) ||
      !source.tools.every((name) =>
        [
          "read",
          "write",
          "edit",
          "bash",
          "grep",
          "find",
          "ls",
          "web_search",
          "fetch_content",
        ].includes(name),
      ) ||
      new Set(source.tools).size !== source.tools.length
    )
      throw new Error("Invalid Agent tool selection");
    result.tools = source.tools;
  }
  if (Object.keys(source).some((key) => key !== "skills" && key !== "tools"))
    throw new Error("Invalid Agent resources");
  return result;
}

function webEndpoint(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid web configuration");
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("Invalid web configuration");
  }
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    !endpoint.hostname ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error("Invalid web configuration");
  return endpoint.href;
}

/** Validate the non-secret web provider/endpoint selection carried into runner context. */
export function validateWebConfiguration(value: unknown): WebConfiguration | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid web configuration");
  const source = value as Record<string, unknown>;
  if (Object.keys(source).some((key) => key !== "search" && key !== "fetch"))
    throw new Error("Invalid web configuration");
  const result: WebConfiguration = {};
  if (source.search !== undefined) {
    if (!source.search || typeof source.search !== "object" || Array.isArray(source.search))
      throw new Error("Invalid web configuration");
    const search = source.search as Record<string, unknown>;
    if (
      Object.keys(search).some((key) => key !== "provider" && key !== "endpoint") ||
      (search.provider !== "brave" && search.provider !== "serpapi")
    )
      throw new Error("Invalid web configuration");
    result.search = { provider: search.provider, endpoint: webEndpoint(search.endpoint) };
  }
  if (source.fetch !== undefined) {
    if (typeof source.fetch !== "boolean") throw new Error("Invalid web configuration");
    result.fetch = source.fetch;
  }
  return result;
}

/**
 * Require configuration for every explicitly selected web tool. The runner needs
 * no web configuration for tools the Agent did not select.
 */
export function resolveWebTools(
  resources: AgentResources | undefined,
  web: WebConfiguration | undefined,
): WebConfiguration | undefined {
  const tools = resources?.tools ?? [];
  if (tools.includes("web_search") && !web?.search)
    throw new Error("Web search requires a configured provider and endpoint");
  if (tools.includes("fetch_content") && web?.fetch !== true)
    throw new Error("Content fetching requires configured web access");
  return web;
}
