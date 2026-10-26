import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ChatView, WorkerCommand, WorkerMessage } from "@mybots/contracts";

interface WorkerClient {
  closed: Promise<void>;
  request(command: WorkerCommand): Promise<unknown>;
  subscribers: Map<string, (value: ChatView) => void>;
  close(): Promise<void>;
}

export async function startWorker(root: string): Promise<WorkerClient> {
  const source = import.meta.url.endsWith(".ts");
  const child = fork(
    fileURLToPath(
      new URL(source ? "../../worker/src/index.ts" : "../../worker/dist/index.js", import.meta.url),
    ),
    [root],
    {
      execArgv: source ? ["--conditions=mybots-source"] : ["--no-strip-types"],
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    },
  );
  let serial = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const subscribers = new Map<string, (value: ChatView) => void>();
  let readyResolve: () => void;
  let readyReject: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  let alive = true;
  let exitCode: number | null | undefined;
  const exited = new Promise<void>((resolve) =>
    child.once("exit", (code) => {
      exitCode = code;
      alive = false;
      const error = new Error("Worker unavailable");
      readyReject(error);
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      resolve();
    }),
  );
  child.once("error", (error) => readyReject(error));
  child.on("message", (message: WorkerMessage) => {
    if (message.type === "ready") {
      readyResolve();
    } else if (message.type === "view") subscribers.get(message.subscription)?.(message.value);
    else {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request?.reject(new Error(message.error));
      else request?.resolve(message.value);
    }
  });
  const startupTimeout = setTimeout(() => {
    readyReject(new Error("Worker startup timed out"));
    child.kill();
  }, 10000);
  try {
    await ready;
  } finally {
    clearTimeout(startupTimeout);
  }
  return {
    closed: exited,
    async request(command: WorkerCommand): Promise<unknown> {
      if (!alive) throw new Error("Worker unavailable");
      const id = ++serial;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.send({ id, command }, (error) => {
          if (error) {
            pending.delete(id);
            reject(error);
          }
        });
      });
    },
    subscribers,
    async close(): Promise<void> {
      const requested = alive;
      if (alive) child.send({ id: ++serial, command: { action: "close" } });
      await exited;
      if (requested && exitCode !== 0)
        throw new Error("Worker shutdown failed; Computer cleanup could not be confirmed");
    },
  };
}
