import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { WebSocketChannel } from "../packages/host/dist/channels/websocket.js";
import { loadHostSettings } from "../packages/host/dist/config/host.js";
import { Host } from "../packages/host/dist/host.js";
import { MailboxDriver } from "../tests/host-fixture.ts";

const root = process.argv[2];
const release = Promise.withResolvers();
const driver = new MailboxDriver();
driver.respond = async (input, _material, signal) => {
  await Promise.race([
    release.promise,
    new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })),
  ]);
  return `Routine result: ${input.content}`;
};
const { configuration } = await loadHostSettings(
  new URL("../examples/host/host.json", import.meta.url),
);
const host = await Host.start({
  root,
  configuration,
  driver,
  now: () => Date.parse(process.argv[4] ?? "2026-10-20T00:00:00Z"),
});
let channel;
try {
  channel = await WebSocketChannel.listen({
    root,
    host,
    configuration,
    port: Number(process.argv[3]),
  });
  process.send?.({
    url: `http://127.0.0.1:${channel.address.port}`,
    credential: (await readFile(join(root, "data/client-credential"), "utf8")).trim(),
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
