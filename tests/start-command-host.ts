import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WebSocketChannel } from "../packages/host/src/channels/websocket.ts";
import { loadHostSettings } from "../packages/host/src/config/host.ts";
import { Host } from "../packages/host/src/host.ts";
import { MailboxDriver } from "./host-fixture.ts";

// Controlled service-manager process boundary, retaining the real Host and local API.
const root = process.argv[2] as string;
const { configuration, websocket } = await loadHostSettings(join(root, "host.json"));
const stopped = Promise.withResolvers<void>();
process.once("SIGTERM", () => stopped.resolve());
const driver = new MailboxDriver();
driver.respond = async (_input, _material, signal) => {
  await writeFile(join(root, "runner-active"), "active");
  await new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
  await writeFile(join(root, "runner-stopped"), "stopped");
  return "Interrupted fixture execution";
};
const host = await Host.start({ root, configuration, driver });
let channel: WebSocketChannel | undefined;
try {
  channel = await WebSocketChannel.listen({
    root,
    host,
    configuration,
    port: websocket?.port ?? 0,
  });
  await stopped.promise;
} finally {
  await channel?.close();
  await host.stop();
  await writeFile(join(root, "service-stopped"), "stopped");
}
