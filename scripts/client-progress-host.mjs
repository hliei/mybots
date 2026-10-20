import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RunnerMailbox } from "@mybots/mailbox/node";
import { runMailbox } from "../packages/agent-runner/dist/poll-loop.js";
import { PiProvider } from "../packages/agent-runner/dist/providers/pi.js";
import { WebSocketChannel } from "../packages/host/dist/channels/websocket.js";
import { loadHostSettings } from "../packages/host/dist/config/host.js";
import { Host } from "../packages/host/dist/host.js";
import { startPiService } from "../tests/pi-fixture.ts";

const root = process.argv[2];
const release = Promise.withResolvers();
const service = await startPiService(async (request) => {
  const latest = JSON.stringify(
    request.messages.findLast((message) => message.role === "user")?.content,
  );
  if (!latest.includes("Publish archive progress")) return { text: "Standing by" };
  const tools = request.messages.filter((message) => message.role === "tool");
  if (tools.length === 0)
    return {
      tool: "publish_progress",
      arguments: { requestId: "shelf-note", text: "Reading shelf 3" },
      text: "Recording progress",
    };
  if (tools.length === 1)
    return {
      tool: "publish_result",
      arguments: { requestId: "shelf-result", text: "Shelf 3 holds the 1962 ledger" },
      text: "Recording result",
    };
  await release.promise;
  return { text: "Authoritative archive reply" };
});
const provider = new PiProvider({ modelRuntime: service.runtime, model: service.model });
const driver = {
  async start(material, signal) {
    const controller = new AbortController();
    const context = JSON.parse(await readFile(material.contextFile, "utf8"));
    const running = runMailbox({
      mailbox: new RunnerMailbox(material.directory),
      provider,
      cwd: material.workspace,
      sessionDir: join(material.directory, "pi"),
      runContext: context.runContext,
      signal: AbortSignal.any([signal, controller.signal]),
      pollMs: 5,
    });
    return {
      wait: () => running,
      stop: async () => {
        controller.abort();
        await running;
      },
    };
  },
};
const { configuration } = await loadHostSettings(
  new URL("../examples/host/host.json", import.meta.url),
);
const host = await Host.start({ root, configuration, driver });
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
    credential: (await readFile(join(root, "data", "client-credential"), "utf8")).trim(),
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
  await service.close();
  process.disconnect?.();
}
