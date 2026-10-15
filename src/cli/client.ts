import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { runChat } from "./chat.ts";

export async function runCli(args: string[]): Promise<number> {
  try {
    const { values } = parseArgs({
      args,
      options: { root: { type: "string", short: "r" }, help: { type: "boolean", short: "h" } },
    });
    if (values.help) {
      console.log("Usage: npm run start:cli -- [--root PATH | -r PATH]");
      console.log(
        "Connect to the owner-local host at PATH/data/cli.sock (PATH defaults to the current directory).",
      );
      console.log(
        "Enter messages; quit, exit, q, EOF or Ctrl+C disconnect the terminal. Agent work stays on the host. /reset starts a fresh conversation after current work.",
      );
      return 0;
    }
    return await runChat(resolve(values.root ?? "."));
  } catch {
    console.error(
      "Error: Cannot connect to the local host; check --root and start the host first.",
    );
    return 1;
  }
}

if (import.meta.main) process.exitCode = await runCli(process.argv.slice(2));
