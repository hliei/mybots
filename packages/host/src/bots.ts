import type { ModelConfiguration } from "./drivers/types.ts";
import { parseSkills, type SkillSelection } from "./skills.ts";

export interface BotSettings {
  name: string;
  instructions: string;
  model: { provider: string; id: string };
  tools: string[];
}

export interface BotConfigurationView {
  skills: SkillSelection[];
  instructions: string;
  model: { provider: string; id: string };
  tools: string[];
}

export type BotAvailability = "active" | "disabled" | "deleted";

export function isBotAvailability(value: unknown): value is BotAvailability {
  return value === "active" || value === "disabled" || value === "deleted";
}

/** Product deletion keeps evidence. It does not list feature files or offer restore or purge. */
export const logicalDeletionRetention =
  "Logical deletion keeps this Bot's configuration, history, results, workspace, memory, and materials, including copies held by other Bots. It does not restore the Bot or permanently purge retained data.";

export interface ManagedBot extends BotSettings {
  skills: SkillSelection[];
  id: string;
  availability: BotAvailability;
  /** Owned material relative to the installation root. */
  workspace: string;
  savedVersion: number;
  effectiveVersion: number;
  effective: BotConfigurationView;
}

export class BotRequestError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export function parseBotCreate(value: unknown): BotSettings & { requestId: string } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BotRequestError("Bot creation requires a JSON object.");
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) => !["requestId", "name", "instructions", "model", "tools"].includes(key),
    )
  )
    throw new BotRequestError(
      "Unsupported Bot setting. Endpoints and credentials belong to installation settings.",
    );
  if (typeof input.requestId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.requestId))
    throw new BotRequestError(
      "A stable requestId is required (1–128 letters, digits, underscores or hyphens).",
    );
  if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 120)
    throw new BotRequestError("Bot name is required (up to 120 characters).");
  if (
    typeof input.instructions !== "string" ||
    !input.instructions.trim() ||
    input.instructions.length > 32000
  )
    throw new BotRequestError("Role instructions are required (up to 32000 characters).");
  if (!input.model || typeof input.model !== "object" || Array.isArray(input.model))
    throw new BotRequestError("Select an installation-approved model.");
  const model = input.model as Record<string, unknown>;
  if (
    Object.keys(model).some((key) => key !== "provider" && key !== "id") ||
    typeof model.provider !== "string" ||
    typeof model.id !== "string"
  )
    throw new BotRequestError(
      "Select a model identifier; endpoints and credentials are installation settings.",
    );
  if (
    !Array.isArray(input.tools) ||
    !input.tools.every((tool) => typeof tool === "string") ||
    new Set(input.tools).size !== input.tools.length
  )
    throw new BotRequestError("Select a unique list of available tools.");
  return {
    requestId: input.requestId,
    name: input.name.trim(),
    instructions: input.instructions,
    model: { provider: model.provider, id: model.id },
    tools: input.tools,
  };
}

/** Role, approved model, tools and Skill revisions. Name, endpoints and per-Task overrides are not settings. */
export function parseBotSettings(
  value: unknown,
): BotSettings & { requestId: string; skills?: SkillSelection[] } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BotRequestError("Bot settings require a JSON object.");
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) => !["requestId", "instructions", "model", "tools", "skills"].includes(key),
    )
  )
    throw new BotRequestError(
      "Unsupported Bot setting. Endpoints, credentials and per-Task overrides are not Bot configuration.",
    );
  const { skills, ...settings } = input;
  const parsed = parseBotCreate({ ...settings, name: "settings" });
  return {
    requestId: parsed.requestId,
    name: "",
    ...(skills !== undefined ? { skills: parseSkills(skills) } : {}),
    instructions: parsed.instructions,
    model: parsed.model,
    tools: parsed.tools,
  };
}

export function publicModel(model: ModelConfiguration) {
  return { provider: model.provider, id: model.id };
}
