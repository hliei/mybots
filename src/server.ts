import { runStartup } from "./startup.ts";

process.exitCode = runStartup("bot", process.argv.slice(2));
