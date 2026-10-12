import type { ToolCall, ToolSchema } from "../core/messages.ts";

export interface ToolArgument {
  name: string;
  description: string;
  enum?: string[];
}

export interface ToolContext {
  signal?: AbortSignal;
}

export interface Tool {
  name: string;
  description: string;
  arguments: ToolArgument[];
  execute(args: Record<string, string>, context: ToolContext): Promise<string>;
}

/** Ordered collection of tools available to one Agent session. */
export class Toolbox {
  private readonly tools: Tool[];

  constructor(tools: Tool[]) {
    this.tools = tools;
  }

  get schemas(): ToolSchema[] {
    return this.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: "object",
          properties: Object.fromEntries(
            tool.arguments.map((argument) => [
              argument.name,
              {
                type: "string",
                description: argument.description,
                ...(argument.enum ? { enum: argument.enum } : {}),
              },
            ]),
          ),
          required: tool.arguments.map((argument) => argument.name),
        },
      },
    }));
  }

  async execute(call: ToolCall, signal?: AbortSignal): Promise<string> {
    const name = call.function.name;
    try {
      signal?.throwIfAborted();
      const args: unknown = JSON.parse(call.function.arguments);
      if (!args || typeof args !== "object" || Array.isArray(args))
        throw new Error("Arguments must be an object.");
      const tool = this.tools.find((tool) => tool.name === name);
      if (!tool) throw new Error(`Tool not found: ${name}`);
      const values: Record<string, string> = {};
      for (const argument of tool.arguments) {
        const value: unknown = (args as Record<string, unknown>)[argument.name];
        if (typeof value !== "string") throw new Error(`${argument.name} must be a string.`);
        values[argument.name] = value;
      }
      return await tool.execute(values, { signal });
    } catch (error) {
      return `Error executing tool: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
