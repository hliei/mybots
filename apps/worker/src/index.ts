import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HostModel } from "@mybots/agent";
import type { WorkerRequest } from "@mybots/contracts";
import { openWorker } from "./worker.ts";

async function main(): Promise<void> {
  const root = process.argv[2];
  if (!root || !process.send) throw new Error("Worker requires a local parent process");
  const raw: unknown = JSON.parse(await readFile(join(root, "models.json"), "utf8"));
  if (
    !Array.isArray(raw) ||
    raw.some((value) => {
      if (!value || typeof value !== "object") return true;
      const model = value as Record<string, unknown>;
      return (
        ["id", "name", "modelId", "baseUrl", "apiKey"].some(
          (key) => typeof model[key] !== "string",
        ) ||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(String(model.id)) ||
        !/^https?:\/\//.test(String(model.baseUrl)) ||
        !Number.isSafeInteger(model.contextWindow) ||
        Number(model.contextWindow) < 4096 ||
        !Number.isSafeInteger(model.maxTokens) ||
        Number(model.maxTokens) <= 0
      );
    }) ||
    new Set(raw.map((model) => model.id)).size !== raw.length
  )
    throw new Error("Invalid host models.json configuration");
  const models = raw as HostModel[];
  const worker = await openWorker(root, models, (subscription, value) =>
    process.send?.({ type: "view", subscription, value }),
  );
  let closing = false;
  async function close(): Promise<void> {
    if (closing) return;
    closing = true;
    await worker.close();
    process.disconnect?.();
  }
  process.on("message", (message: WorkerRequest) => {
    if (message.command.action === "close") {
      void close().catch(() => {
        process.exitCode = 1;
      });
      return;
    }
    void worker.command(message.command).then(
      (value) => process.send?.({ type: "response", id: message.id, value }),
      () => process.send?.({ type: "response", id: message.id, error: "Worker operation failed" }),
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
  process.send({ type: "ready", models: models.map(({ id, name }) => ({ id, name })) });
}

main().catch(() => {
  console.error("Worker startup failed. Check the host model configuration and data root.");
  process.exitCode = 1;
  process.disconnect?.();
});
