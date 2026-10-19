import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { HostMailbox, RunnerMailbox } from "@mybots/mailbox/node";
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
configuration.approvedModels = [
  configuration.agent.model,
  { ...configuration.agent.model, id: "deepseek-reasoner" },
];
const driver = new MailboxDriver();
const started = Promise.withResolvers();
const release = Promise.withResolvers();
const chatRelease = Promise.withResolvers();
let releaseStop = () => {};
let stopGate = process.env.MYBOTS_HOLD_STOP
  ? new Promise((resolve) => {
      releaseStop = resolve;
    })
  : Promise.resolve();
let failStop = false;
let stops = 0;
const execution = {
  async start(material, signal) {
    const handle = await driver.start(material, signal);
    return {
      ref: handle.ref,
      wait: () => handle.wait(),
      stop: async () => {
        stops += 1;
        if (failStop) throw new Error("Controlled stop failure");
        // The browser harness completes its initial inspection before owner stops.
        if (process.env.MYBOTS_HOLD_STOP && stops > 1) await stopGate;
        await handle.stop();
      },
    };
  },
};
driver.respond = async (input, _material, signal) => {
  started.resolve();
  await Promise.race([
    input.content === "Hold chat" ? chatRelease.promise : release.promise,
    new Promise((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", resolve, { once: true });
    }),
  ]);
  return input.content === "Inspect this session" ? "Controlled reply" : `Final: ${input.content}`;
};
const host = await Host.start({ root, configuration, driver: execution });
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
      if (message === "complete-chat") chatRelease.resolve();
      if (message === "hold-stop")
        stopGate = new Promise((resolve) => {
          releaseStop = resolve;
        });
      if (message === "release-stop") releaseStop();
      if (message === "fail-stop") failStop = true;
      if (message === "allow-stop") failStop = false;
      if (message === "write-late") {
        const directory = driver.launches.at(-1)?.material.directory;
        const input = directory ? new HostMailbox(directory).inputs().at(-1) : undefined;
        if (directory && input)
          new RunnerMailbox(directory).reply(input, "Late evidence after stop", "message");
      }
    });
  });
} finally {
  release.resolve();
  chatRelease.resolve();
  failStop = false;
  releaseStop();
  await channel?.close();
  await host.stop();
  process.disconnect?.();
}
