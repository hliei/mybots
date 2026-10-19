import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runChat } from "./chat.ts";
import { startClient } from "./start.ts";

export async function runCli(args: string[]): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: { root: { type: "string", short: "r" }, help: { type: "boolean", short: "h" } },
    });
    if (values.help) {
      console.log("Usage: mbt [--root PATH | -r PATH]");
      console.log("       mbt start [--root PATH | -r PATH]");
      console.log("       npm run mbt -- [--root PATH | -r PATH]");
      console.log(
        "Connect to the owner-local host at PATH/data/cli.sock (PATH defaults to the current directory).",
      );
      console.log(
        "Enter messages; quit, exit, q, EOF or Ctrl+C disconnect the terminal. Agent work stays on the host. /reset starts a fresh conversation after current work.",
      );
      console.log(
        "mbt start opens the local Web client, starting its installed service if needed. Its root defaults to this installation, from any directory.",
      );
      return 0;
    }
    if (positionals.length === 1 && positionals[0] === "start")
      return await startClient(
        resolve(values.root ?? fileURLToPath(new URL("../../../../", import.meta.url))),
      );
    if (positionals.length) throw new Error("Unknown command");
    return await runChat(resolve(values.root ?? "."));
  } catch {
    console.error(
      "Error: Cannot connect to the local host; check --root and start the host first.",
    );
    return 1;
  }
}

if (import.meta.main) process.exitCode = await runCli(process.argv.slice(2));
