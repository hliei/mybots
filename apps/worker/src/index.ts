import type { WorkerRequest } from "@mybots/contracts";
import { openWorker } from "./worker.ts";

async function main(): Promise<void> {
  const root = process.argv[2];
  if (!root || !process.send) throw new Error("Worker requires a local parent process");
  const worker = await openWorker(root, (subscription, value) =>
    process.send?.({ type: "view", subscription, value }),
  );
  let closing = false;
  async function close(): Promise<void> {
    if (closing) return;
    closing = true;
    try {
      await worker.close();
    } catch {
      console.error("Worker shutdown failed. Computer cleanup could not be confirmed.");
      process.exitCode = 1;
    } finally {
      if (process.connected) process.disconnect?.();
    }
  }
  process.on("message", (message: WorkerRequest) => {
    if (message.command.action === "close") {
      void close();
      return;
    }
    void worker.command(message.command).then(
      (value) => process.send?.({ type: "response", id: message.id, value }),
      () =>
        process.send?.({
          type: "response",
          id: message.id,
          error:
            message.command.action === "send"
              ? "Model unavailable. Choose a supported model and save its key in Provider settings."
              : "Worker operation failed",
        }),
    );
  });
  process.on("disconnect", () => {
    void close();
  });
  process.on("SIGTERM", () => {
    void close();
  });
  process.on("SIGINT", () => {
    void close();
  });
  process.send({ type: "ready" });
}

main().catch(() => {
  console.error("Worker startup failed. Check the data root and provider credential storage.");
  process.exitCode = 1;
  process.disconnect?.();
});
