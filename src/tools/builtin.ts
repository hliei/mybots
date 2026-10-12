import { readFile, writeFile } from "node:fs/promises";
import type { ToolCall } from "../core/messages.ts";
import { runShell } from "./shell.ts";

const definitions: { name: string; description: string; fields: Record<string, string> }[] = [
  {
    name: "read",
    description: "Read the contents of a text file",
    fields: { path: "Path to the file to read" },
  },
  {
    name: "write",
    description: "Write content to a file",
    fields: { path: "Path to the file to write", content: "Content to write to the file" },
  },
  {
    name: "edit",
    description: "Edit a file by replacing a string with new content",
    fields: {
      path: "Path to the file to edit",
      old_text: "The text to replace",
      new_text: "The new text to replace with",
    },
  },
  {
    name: "bash",
    description: "Execute a bash shell command",
    fields: { command: "The bash command to execute" },
  },
];

export const toolSchemas = definitions.map(({ name, description, fields }) => ({
  type: "function" as const,
  function: {
    name,
    description,
    parameters: {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(fields).map(([key, description]) => [key, { type: "string", description }]),
      ),
      required: Object.keys(fields),
    },
  },
}));

export async function executeTool(call: ToolCall, signal?: AbortSignal): Promise<string> {
  const name = call.function.name;
  try {
    signal?.throwIfAborted();
    const args: unknown = JSON.parse(call.function.arguments);
    if (!args || typeof args !== "object" || Array.isArray(args))
      throw new Error("Arguments must be an object.");
    const definition = definitions.find((definition) => definition.name === name);
    if (!definition) throw new Error(`Tool not found: ${name}`);
    const values: Record<string, string> = {};
    for (const field of Object.keys(definition.fields)) {
      const value: unknown = (args as Record<string, unknown>)[field];
      if (typeof value !== "string") throw new Error(`${field} must be a string.`);
      values[field] = value;
    }
    if (name === "bash") return await runShell(values.command, signal);
    try {
      if (name === "read") return await readFile(values.path, { encoding: "utf8", signal });
      if (name === "edit") {
        const content = await readFile(values.path, { encoding: "utf8", signal });
        if (!content.includes(values.old_text))
          return `Error: '${values.old_text}' not found in ${values.path}`;
        await writeFile(
          values.path,
          values.old_text === ""
            ? ["", ...content, ""].join(values.new_text)
            : content.replaceAll(values.old_text, () => values.new_text),
          { encoding: "utf8", signal },
        );
        return `Successfully edited ${values.path}`;
      }
      await writeFile(values.path, values.content, { encoding: "utf8", signal });
      return `Successfully wrote to: ${values.path}`;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if ((name === "read" || name === "edit") && code === "ENOENT")
        return `Error: File not found: ${values.path}`;
      if (code === "EISDIR") return `Error: Path is a directory, not a file: ${values.path}`;
      if (code === "EACCES" || code === "EPERM")
        return name === "read"
          ? `Error: Permission denied reading: ${values.path}`
          : name === "edit"
            ? `Error: Permission denied editing: ${values.path}`
            : `Error: Permission denied writing to: ${values.path}`;
      return `Error ${name === "read" ? "reading" : name === "edit" ? "editing" : "writing"} file: ${error instanceof Error ? error.message : String(error)}`;
    }
  } catch (error) {
    return `Error executing tool: ${error instanceof Error ? error.message : String(error)}`;
  }
}
