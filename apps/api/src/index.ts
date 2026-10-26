import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { startApi } from "./server.ts";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      root: { type: "string", default: "data" },
      port: { type: "string", default: "4173" },
    },
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port");
  const startup = new AbortController();
  const abortStartup = () => startup.abort();
  process.on("SIGTERM", abortStartup);
  process.on("SIGINT", abortStartup);
  let api: Awaited<ReturnType<typeof startApi>>;
  try {
    api = await startApi(resolve(values.root), port, startup.signal);
  } finally {
    process.off("SIGTERM", abortStartup);
    process.off("SIGINT", abortStartup);
  }
  if (startup.signal.aborted) {
    await api.close();
    return;
  }
  console.log(`Local chat on ${api.url}`);
  process.send?.({ url: api.url });
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void api.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
}
main().catch(() => {
  console.error(
    "Local chat startup failed. Check the selected data root and provider credential storage.",
  );
  process.exitCode = 1;
});
