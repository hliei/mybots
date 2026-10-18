import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { WebSocketChannel } from "../packages/host/dist/channels/websocket.js";
import { loadHostSettings } from "../packages/host/dist/config/host.js";
import { Host } from "../packages/host/dist/host.js";
import { MailboxDriver } from "../tests/host-fixture.ts";

// Real built Host and stores; only container execution is controlled.
const root = process.argv[2];
const port = Number(process.argv[3]);
const { configuration } = await loadHostSettings(
  new URL("../examples/host/host.json", import.meta.url),
);
const driver = new MailboxDriver();
const started = Promise.withResolvers();
const release = Promise.withResolvers();
driver.respond = async (_input, _material, signal) => {
  started.resolve();
  await Promise.race([
    release.promise,
    new Promise((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", resolve, { once: true });
    }),
  ]);
  return "Controlled reply";
};
const host = await Host.start({ root, configuration, driver });
let channel;
try {
  channel = await WebSocketChannel.listen({ root, host, configuration, port });
  let sessionId = host.sessions()[0]?.id;
  if (!sessionId) {
    ({ sessionId } = await host.accept({
      destinationId: "terminal",
      userId: "cli:local",
      text: "Inspect this session",
    }));
    await started.promise;
  }
  process.send?.({
    url: `http://127.0.0.1:${channel.address.port}`,
    credential: (await readFile(join(root, "data", "client-credential"), "utf8")).trim(),
    sessionId,
  });
  await new Promise((resolve) => {
    process.once("SIGTERM", resolve);
    process.once("disconnect", resolve);
    process.on("message", (message) => {
      if (message === "complete") release.resolve();
    });
  });
} finally {
  release.resolve();
  await channel?.close();
  await host.stop();
  process.disconnect?.();
}
