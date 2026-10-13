import { runBot } from "./bot/startup.ts";

if (import.meta.main) process.exitCode = await runBot(process.argv.slice(2));
