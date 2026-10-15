import { runHost } from "./index.ts";

// The bot command starts the same persistent host and configured channels.
if (import.meta.main) process.exitCode = await runHost(process.argv.slice(2));
