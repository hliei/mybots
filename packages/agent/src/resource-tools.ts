import { defineTool, type Extension } from "@earendil-works/pi-durable";
import type { ProductDatabase } from "@mybots/db";
import { Type } from "typebox";

export function resourceContext(database: ProductDatabase, botId: string): string {
  return [
    "Shared Skill catalog. Discover relevant Skills here and use skill_read to load full instructions before applying them. Full bodies are not loaded by default. User Skills are shared; built-ins are read-only:",
    JSON.stringify(database.skills().map(({ content: _content, ...skill }) => skill)),
    "Deliberate Markdown memory follows as background data. It can be outdated. Use memory tools only to deliberately retain or correct knowledge. Other Bots' private memory is unavailable. Removing memory does not erase earlier transcript entries.",
    JSON.stringify({
      owner: database.memory("owner").content,
      bot: database.memory("bot", botId).content,
    }),
  ].join("\n");
}

export function resourceTools(
  database: ProductDatabase,
  botForConversation: (id: number) => string,
): Extension {
  const scope = Type.Union([Type.Literal("owner"), Type.Literal("bot")]);
  const output = (value: unknown) => ({
    output: [{ type: "text" as const, text: JSON.stringify(value) }],
  });
  return {
    name: "resources",
    tools: [
      defineTool({
        name: "skill_read",
        description: "Read a shared Skill's full instructions by catalog name.",
        parameters: Type.Object({ name: Type.String() }),
        replay: "safe",
        execute: async (args) => output(database.skill(args.name)),
      }),
      defineTool({
        name: "skill_write",
        description:
          "Create or replace a shared user Skill. Built-ins are read-only. Names use lowercase letters, numbers and hyphens; start with a letter. Markdown content limit is 16000 characters; description limit is 1000.",
        parameters: Type.Object({
          name: Type.String(),
          description: Type.String(),
          content: Type.String(),
        }),
        replay: "unsafe",
        execute: async (args) => output(database.writeSkill(args.name, args)),
      }),
      defineTool({
        name: "skill_delete",
        description: "Remove a shared user Skill. Built-ins are read-only.",
        parameters: Type.Object({ name: Type.String() }),
        replay: "unsafe",
        execute: async (args) => {
          database.deleteSkill(args.name);
          return output({ removed: true });
        },
      }),
      defineTool({
        name: "memory_read",
        description:
          "Read current Markdown memory: owner is shared, bot belongs only to the current Bot.",
        parameters: Type.Object({ scope }),
        replay: "safe",
        execute: async (args, api) =>
          output(
            database.memory(
              args.scope,
              args.scope === "bot" ? botForConversation(api.conversationId) : undefined,
            ),
          ),
      }),
      defineTool({
        name: "memory_write",
        description:
          "Deliberately replace scoped Markdown memory (16000 characters maximum). Read first to preserve useful records. owner is shared; bot is the current Bot only. Do not copy the transcript.",
        parameters: Type.Object({ scope, content: Type.String() }),
        replay: "unsafe",
        execute: async (args, api) =>
          output(
            database.writeMemory(
              args.scope,
              args.content,
              args.scope === "bot" ? botForConversation(api.conversationId) : undefined,
            ),
          ),
      }),
      defineTool({
        name: "memory_delete",
        description:
          "Remove current scoped memory. Does not erase earlier transcript entries or guarantee forgetting. bot is the current Bot only.",
        parameters: Type.Object({ scope }),
        replay: "unsafe",
        execute: async (args, api) => {
          database.deleteMemory(
            args.scope,
            args.scope === "bot" ? botForConversation(api.conversationId) : undefined,
          );
          return output({ removed: true });
        },
      }),
    ],
  };
}
