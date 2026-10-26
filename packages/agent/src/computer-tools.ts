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
    sections: [
      {
        key: "computer",
        render: ({ conversationId }) =>
          `The Team Computer is a shared Linux container with Python 3 and /bin/sh. Your default shell directory is /workspace/${path(conversationId)}; shared working files live in /workspace/shared. All Bots share the same files; Bot directories organize work, not access isolation. File-tool paths and shell cwd are workspace-relative: ordinary relative paths start in your Bot directory; shared/..., bots/... and /... start at the workspace root. Do not prefix those tool paths with /workspace; absolute paths inside shell commands use the actual Linux filesystem. The root filesystem is read-only. Write persistent files and local installs/caches under your Bot directory or shared workspace; /tmp is temporary. Do not assume Node, npm or other toolchains are installed; inspect before using them. shell returns after the command exits, with a 120-second deadline; it does not provide managed background services or a host preview URL. Stop cannot undo completed file effects. read_file and write_file handle UTF-8 files up to 1 MiB; writes replace contents. Shell output and SDK tool results are bounded. If output is truncated, obtain needed original slices with a shell command or explicitly write a log in the workspace before reading it.`,
      },
    ],
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
