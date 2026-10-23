import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { RunnerMailbox } from "@mybots/mailbox/node";
import { runMailbox } from "../packages/agent-runner/dist/poll-loop.js";
import { PiProvider } from "../packages/agent-runner/dist/providers/pi.js";
import { WebSocketChannel } from "../packages/host/dist/channels/websocket.js";
import { loadHostSettings } from "../packages/host/dist/config/host.js";
import { Host } from "../packages/host/dist/host.js";
import { longOriginal, markdownOriginal, wideOriginal } from "../tests/message-content.ts";
import { startPiService } from "../tests/pi-fixture.ts";

const root = process.argv[2];
const release = Promise.withResolvers();
const streamMore = Promise.withResolvers();
const streamEnd = Promise.withResolvers();
const service = await startPiService(async (request) => {
  const latest = JSON.stringify(
    request.messages.findLast((message) => message.role === "user")?.content,
  );
  if (latest.includes("Stream reply"))
    return {
      chunks: (async function* () {
        yield "A growing reply";
        await streamMore.promise;
        yield " with original text 🪐";
        await streamEnd.promise;
      })(),
    };
  if (latest.includes("Inspect original history")) {
    if (!request.messages.some((message) => message.role === "tool"))
      return {
        tool: "search_history",
        arguments: { query: "火星项目" },
        text: "Live original lookup",
      };
    await release.promise;
    return { text: markdownOriginal };
  }
  if (latest.includes("Panel reflow reply"))
    return { text: "A line of conversation remains in place while the panel changes. ".repeat(30) };
  if (latest.includes("Read wide original")) return { text: wideOriginal };
  if (latest.includes("Read long original")) return { text: longOriginal };
  return { text: `Remembered: ${latest}` };
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
  if (!(await host.threadDetail("personal")).tasks.length) {
    for (let i = 0; i < 3; i++) {
      const sent = await host.sendThread(
        "personal",
        { requestId: `seed-${i}`, text: `火星项目 original ${i}` },
        "new-task",
      );
      const deadline = Date.now() + 10000;
      while (
        !(await host.threadDetail("personal")).tasks.some((task) =>
          task.runs.some((run) => run.id === sent.runId && run.state === "succeeded"),
        )
      ) {
        if (Date.now() > deadline) throw new Error("Seed execution did not complete");
        await setTimeout(10);
      }
    }
  }
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
      if (message === "stream-more") streamMore.resolve();
      if (message === "stream-end") streamEnd.resolve();
    });
  });
} finally {
  release.resolve();
  streamMore.resolve();
  streamEnd.resolve();
  await channel?.close();
  await host.stop();
  await service.close();
  process.disconnect?.();
}
