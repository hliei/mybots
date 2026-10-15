import type { AgentResources } from "./types.ts";

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
        ["read", "write", "edit", "bash", "grep", "find", "ls"].includes(name),
      ) ||
      new Set(source.tools).size !== source.tools.length
    )
      throw new Error("Invalid Agent tool selection");
    result.tools = source.tools;
  }
  return result;
}
