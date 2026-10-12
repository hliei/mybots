import { runCli } from "./cli/chat.ts";

if (import.meta.main) process.exitCode = await runCli(process.argv.slice(2));
