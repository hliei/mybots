import { runStartup } from "./startup.ts";

process.exitCode = runStartup("cli", process.argv.slice(2));
