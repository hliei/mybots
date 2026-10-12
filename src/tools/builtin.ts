import { readFile, writeFile } from "node:fs/promises";
import { runShell } from "./shell.ts";
import type { Tool } from "./toolbox.ts";

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String(error.code) : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Shared filesystem failures whose reference wording depends only on the action. */
function pathError(code: string | undefined, path: string, action: string): string | undefined {
  if (code === "EISDIR") return `Error: Path is a directory, not a file: ${path}`;
  if (code === "EACCES" || code === "EPERM") return `Error: Permission denied ${action}: ${path}`;
  return undefined;
}

export const builtinTools: Tool[] = [
  {
    name: "read",
    description: "Read the contents of a text file",
    arguments: [{ name: "path", description: "Path to the file to read" }],
    async execute({ path }, { signal }) {
      try {
        return await readFile(path, { encoding: "utf8", signal });
      } catch (error) {
        const code = errorCode(error);
        const denied = pathError(code, path, "reading");
        if (denied) return denied;
        if (code === "ENOENT") return `Error: File not found: ${path}`;
        return `Error reading file: ${errorMessage(error)}`;
      }
    },
  },
  {
    name: "write",
    description: "Write content to a file",
    arguments: [
      { name: "path", description: "Path to the file to write" },
      { name: "content", description: "Content to write to the file" },
    ],
    async execute({ path, content }, { signal }) {
      try {
        await writeFile(path, content, { encoding: "utf8", signal });
        return `Successfully wrote to: ${path}`;
      } catch (error) {
        const denied = pathError(errorCode(error), path, "writing to");
        if (denied) return denied;
        return `Error writing file: ${errorMessage(error)}`;
      }
    },
  },
  {
    name: "edit",
    description: "Edit a file by replacing a string with new content",
    arguments: [
      { name: "path", description: "Path to the file to edit" },
      { name: "old_text", description: "The text to replace" },
      { name: "new_text", description: "The new text to replace with" },
    ],
    async execute({ path, old_text, new_text }, { signal }) {
      try {
        const content = await readFile(path, { encoding: "utf8", signal });
        if (!content.includes(old_text)) return `Error: '${old_text}' not found in ${path}`;
        await writeFile(
          path,
          old_text === ""
            ? ["", ...content, ""].join(new_text)
            : content.replaceAll(old_text, () => new_text),
          { encoding: "utf8", signal },
        );
        return `Successfully edited ${path}`;
      } catch (error) {
        const code = errorCode(error);
        const denied = pathError(code, path, "editing");
        if (denied) return denied;
        if (code === "ENOENT") return `Error: File not found: ${path}`;
        return `Error editing file: ${errorMessage(error)}`;
      }
    },
  },
  {
    name: "bash",
    description: "Execute a bash shell command",
    arguments: [{ name: "command", description: "The bash command to execute" }],
    async execute({ command }, { signal }) {
      return await runShell(command, signal);
    },
  },
];
