import { defineTool, type Extension } from "@earendil-works/pi-durable";
import type { ComputerRef, SandboxProvider } from "@mybots/sandbox";
import { resolveWorkingPath } from "@mybots/sandbox";
import { Type } from "typebox";

export function computerTools(
  provider: SandboxProvider,
  computer: ComputerRef,
  botForConversation: (conversationId: number) => string,
): Extension {
  const path = (conversationId: number, value?: string) =>
    resolveWorkingPath(botForConversation(conversationId), value);
  const output = (text: string) => ({ output: [{ type: "text" as const, text }] });
  return {
    name: "computer-tools",
    tools: [
      defineTool({
        name: "shell",
        description:
          "Run a shell command on the shared Team Computer. Default cwd is your Bot directory. shared/... and /... resolve from the workspace root. Directories organize files; Bots share the Computer. Commands time out after 120 seconds. Interrupted effects are not rolled back.",
        parameters: Type.Object({ command: Type.String(), cwd: Type.Optional(Type.String()) }),
        replay: "unsafe",
        execute: async (args, api, context) => {
          const result = await provider.execute(
            computer,
            args.command,
            path(api.conversationId, args.cwd),
            context.abortSignal,
          );
          return output(JSON.stringify(result));
        },
      }),
      defineTool({
        name: "read_file",
        description:
          "Read UTF-8 working files from the Team Computer (up to 1 MiB). Relative paths use your Bot directory; shared/..., bots/... and /... use the workspace root.",
        parameters: Type.Object({ path: Type.String() }),
        replay: "safe",
        execute: async (args, api, context) =>
          output(
            await provider.readFile(
              computer,
              path(api.conversationId, args.path),
              context.abortSignal,
            ),
          ),
      }),
      defineTool({
        name: "write_file",
        description:
          "Write a UTF-8 working file on the shared Team Computer, creating parent directories (up to 1 MiB). Paths follow read_file. Replaces existing file contents.",
        parameters: Type.Object({ path: Type.String(), content: Type.String() }),
        replay: "unsafe",
        execute: async (args, api, context) => {
          await provider.writeFile(
            computer,
            path(api.conversationId, args.path),
            args.content,
            context.abortSignal,
          );
          return output("File written");
        },
      }),
    ],
  };
}
