import type { WorkerMessage, WorkerRequest } from "@mybots/contracts";
import { openWorker } from "./worker.ts";

function send(message: WorkerMessage): void {
  if (process.connected) process.send?.(message, () => {});
}

async function main(): Promise<void> {
  const root = process.argv[2];
  if (!root || !process.send) throw new Error("Worker requires a local parent process");
  let closing = false;
  const startup = new AbortController();
  let worker: Awaited<ReturnType<typeof openWorker>> | undefined;
  process.on("disconnect", () => {
    void close();
  });
  process.on("SIGTERM", () => {
    void close();
  });
  process.on("SIGINT", () => {
    void close();
  });
  worker = await openWorker(
    root,
    (subscription, value) => send({ type: "view", subscription, value }),
    startup.signal,
  );
  if (closing || !process.connected) {
    await worker.close();
    if (process.connected) process.disconnect?.();
    return;
  }
  const opened = worker;
  async function close(): Promise<void> {
    if (closing) return;
    closing = true;
    startup.abort();
    if (!worker) return;
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
    if (closing) return;
    void opened.command(message.command).then(
      (value) => send({ type: "response", id: message.id, value }),
      () =>
        send({
          type: "response",
          id: message.id,
          error:
            message.command.action === "send"
              ? "Model unavailable. Choose a supported model and save its key in Provider settings."
              : "Worker operation failed",
        }),
    );
  });
  send({ type: "ready" });
}

main().catch((error: unknown) => {
  const detail =
    error instanceof Error &&
    /^(Computer recovery cleanup failed\.|Worker unavailable\.)/.test(error.message)
      ? error.message
      : "Worker startup failed. Check the data root and provider credential storage.";
  send({ type: "startup-error", error: detail });
  console.error("Worker startup failed. Check the data root and provider credential storage.");
  process.exitCode = 1;
  process.disconnect?.();
});
