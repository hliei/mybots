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
  const api = await startApi(resolve(values.root), port);
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
  console.error("Local chat startup failed. Check models.json in the selected data root.");
  process.exitCode = 1;
});
