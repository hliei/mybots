import { runStartup } from "./bot/startup.ts";

process.exitCode = runStartup("bot", process.argv.slice(2));
