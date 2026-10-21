import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createTelegramApi } from "../packages/host/dist/channels/telegram-api.js";
import { WebSocketChannel } from "../packages/host/dist/channels/websocket.js";
import { loadHostSettings } from "../packages/host/dist/config/host.js";
import { Host } from "../packages/host/dist/host.js";
import { MailboxDriver } from "../tests/host-fixture.ts";

// Built Host and client, real stores/mailboxes, controlled execution and Telegram HTTP.
const [root, port, now, telegramUrl] = process.argv.slice(2);
const { configuration } = await loadHostSettings(
  new URL("../examples/host/host.json", import.meta.url),
);
const driver = new MailboxDriver();
const report = Promise.withResolvers();
driver.respond = async (input, _material, signal) => {
  const stopped = new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", resolve, { once: true });
  });
  await Promise.race([report.promise, stopped]);
  return `Completed: ${input.content}`;
};
const host = await Host.start({
  root,
  configuration,
  driver,
  now: () => Date.parse(now),
});
host.attachTelegramNotices(
  createTelegramApi({ token: "offline-token", baseUrl: telegramUrl, fetch: globalThis.fetch }),
  "123456789",
);
let channel;
try {
  channel = await WebSocketChannel.listen({ root, host, configuration, port: Number(port) });
  process.send?.({
    url: `http://127.0.0.1:${channel.address.port}`,
    credential: (await readFile(join(root, "data/client-credential"), "utf8")).trim(),
  });
  await new Promise((resolve) => {
    process.once("SIGTERM", resolve);
    process.once("disconnect", resolve);
    process.on("message", (message) => {
      if (message === "complete") report.resolve();
    });
  });
} finally {
  report.resolve();
  await channel?.close();
  await host.stop();
  process.disconnect?.();
}
