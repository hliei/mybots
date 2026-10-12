import type { ToolCall, ToolSchema } from "../core/messages.ts";

export interface ToolArgument {
  name: string;
  description: string;
  type?: "string" | "integer" | "array";
  optional?: boolean;
  nonempty?: boolean;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
}

export interface ToolContext {
  signal?: AbortSignal;
}

export interface Tool<Arguments extends object = Record<string, string>> {
  name: string;
  description: string;
  arguments: ToolArgument[];
  exclusiveArguments?: string[];
  strictArguments?: boolean;
  execute(args: Arguments, context: ToolContext): Promise<string>;
}

function argumentSchema(argument: ToolArgument): Record<string, unknown> {
  const stringConstraints = argument.nonempty ? { minLength: 1, pattern: "\\S" } : {};
  return {
    type: argument.type ?? "string",
    description: argument.description,
    ...(argument.type === "array"
      ? { items: { type: "string", ...stringConstraints } }
      : stringConstraints),
    ...(argument.enum ? { enum: argument.enum } : {}),
    ...(argument.minimum !== undefined ? { minimum: argument.minimum } : {}),
    ...(argument.maximum !== undefined ? { maximum: argument.maximum } : {}),
    ...(argument.minItems !== undefined ? { minItems: argument.minItems } : {}),
    ...(argument.maxItems !== undefined ? { maxItems: argument.maxItems } : {}),
  };
}

/** Ordered collection of tools available to one Agent session. */
export class Toolbox {
  private readonly tools: Tool<object>[];

  constructor(tools: Tool<object>[]) {
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
            tool.arguments.map((argument) => [argument.name, argumentSchema(argument)]),
          ),
          required: tool.arguments
            .filter((argument) => !argument.optional)
            .map((argument) => argument.name),
          ...(tool.strictArguments ? { additionalProperties: false } : {}),
          ...(tool.exclusiveArguments
            ? { oneOf: tool.exclusiveArguments.map((name) => ({ required: [name] })) }
            : {}),
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
      const values: Record<string, string | number | string[]> = {};
      for (const argument of tool.arguments) {
        const value: unknown = (args as Record<string, unknown>)[argument.name];
        if (value === undefined && argument.optional) continue;
        if (argument.type === "array") {
          if (!Array.isArray(value)) throw new Error(`${argument.name} must be a string array.`);
          const items: unknown[] = value;
          if (!items.every((item): item is string => typeof item === "string"))
            throw new Error(`${argument.name} must be a string array.`);
          if (argument.minItems !== undefined && items.length < argument.minItems)
            throw new Error(`${argument.name} must be at least ${argument.minItems} items.`);
          if (argument.maxItems !== undefined && items.length > argument.maxItems)
            throw new Error(`${argument.name} must be at most ${argument.maxItems} items.`);
          if (argument.nonempty && items.some((item) => !item.trim()))
            throw new Error(`${argument.name} must be an array of nonempty strings.`);
          values[argument.name] = items;
          continue;
        }
        if (argument.type === "integer") {
          if (typeof value !== "number" || !Number.isInteger(value))
            throw new Error(`${argument.name} must be an integer.`);
          if (argument.minimum !== undefined && value < argument.minimum)
            throw new Error(`${argument.name} must be at least ${argument.minimum}.`);
          if (argument.maximum !== undefined && value > argument.maximum)
            throw new Error(`${argument.name} must be at most ${argument.maximum}.`);
          values[argument.name] = value;
          continue;
        }
        if (typeof value !== "string") throw new Error(`${argument.name} must be a string.`);
        if (argument.nonempty && !value.trim())
          throw new Error(`${argument.name} must be a nonempty string.`);
        // Legacy implicit string arguments keep Skill-loader enum error handling.
        if (argument.type === "string" && argument.enum && !argument.enum.includes(value))
          throw new Error(`${argument.name} must be one of ${argument.enum.join(", ")}.`);
        values[argument.name] = value;
      }
      if (
        tool.exclusiveArguments &&
        tool.exclusiveArguments.filter((name) => name in values).length !== 1
      )
        throw new Error(`Exactly one of ${tool.exclusiveArguments.join(", ")} is required.`);
      if (tool.strictArguments) {
        for (const name of Object.keys(args)) {
          if (!tool.arguments.some((argument) => argument.name === name))
            throw new Error(`Unknown argument: ${name}.`);
        }
      }
      return await tool.execute(values, { signal });
    } catch (error) {
      return `Error executing tool: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
