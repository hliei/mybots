import { type ChildProcess, fork } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { ChatView, WorkerCommand, WorkerMessage, WorkerStatus } from "@mybots/contracts";

interface WorkerClient {
  status: WorkerStatus;
  request(command: WorkerCommand): Promise<unknown>;
  subscribe(id: string, botId: string, publish: (view: ChatView) => void): void;
  unsubscribe(id: string): void;
  onStatus: Set<(status: WorkerStatus) => void>;
  close(): Promise<void>;
}

export async function startWorker(root: string, signal?: AbortSignal): Promise<WorkerClient> {
  const source = import.meta.url.endsWith(".ts");
  // Capture the launch environment once: replacements use the same installation configuration.
  const env = { ...process.env };
  const subscriptions = new Map<string, { botId: string; publish(view: ChatView): void }>();
  const onStatus = new Set<(status: WorkerStatus) => void>();
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const stopping = new AbortController();
  let child: ChildProcess | undefined;
  let exited: Promise<void> = Promise.resolve();
  let serial = 0;
  let attempts = 0;
  let ready = false;
  let closing: Promise<void> | undefined;
  let recovering: Promise<void> | undefined;
  let status: WorkerStatus = { state: "recovering", attempt: 0 };
  function publish(value: WorkerStatus): void {
    status = value;
    for (const listener of onStatus) listener(value);
  }
  function unavailable(): Error {
    return new Error(
      status.state === "failed" ? status.error : "Worker recovering. Wait before retrying.",
    );
  }
  async function request(command: WorkerCommand): Promise<unknown> {
    if (!ready || stopping.signal.aborted || !child?.connected) throw unavailable();
    const id = ++serial;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child?.send({ id, command }, (error) => {
        if (error) {
          pending.delete(id);
          reject(new Error("Worker connection lost. Check chat before retrying input."));
        }
      });
    });
  }
  async function launch(): Promise<void> {
    stopping.signal.throwIfAborted();
    ready = false;
    const next = fork(
      fileURLToPath(
        new URL(
          source ? "../../worker/src/index.ts" : "../../worker/dist/index.js",
          import.meta.url,
        ),
      ),
      [root],
      {
        env,
        execArgv: source ? ["--conditions=mybots-source"] : ["--no-strip-types"],
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      },
    );
    child = next;
    let resolveReady: () => void;
    let rejectReady: (error: Error) => void;
    const startup = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    let startupError: string | undefined;
    exited = new Promise<void>((resolve) => {
      next.once("close", () => {
        ready = false;
        rejectReady(new Error(startupError ?? "Worker unavailable. Check data-root ownership."));
        for (const request of pending.values())
          request.reject(new Error("Worker connection lost. Check chat before retrying input."));
        pending.clear();
        resolve();
        if (!stopping.signal.aborted) {
          // The current launch/recovery loop owns retries until it has settled.
          if (!recovering) recover();
        }
      });
    });
    next.once("disconnect", () => {
      if (!stopping.signal.aborted) next.kill("SIGKILL");
    });
    next.once("error", () =>
      rejectReady(new Error("Worker could not start. Check Node.js and installation files.")),
    );
    next.on("message", (message: WorkerMessage) => {
      if (stopping.signal.aborted) return;
      if (message.type === "startup-error") startupError = message.error;
      else if (message.type === "ready") resolveReady();
      else if (message.type === "view")
        subscriptions.get(message.subscription)?.publish(message.value);
      else {
        const request = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) request?.reject(new Error(message.error));
        else request?.resolve(message.value);
      }
    });
    const timeout = setTimeout(() => {
      rejectReady(
        new Error("Worker startup timed out. Check Computer cleanup and data-root ownership."),
      );
      next.kill("SIGKILL");
    }, 10000);
    try {
      await startup;
      stopping.signal.throwIfAborted();
      ready = true;
      for (const [subscription, { botId }] of subscriptions) {
        if (subscriptions.has(subscription))
          await request({ action: "subscribe", botId, subscription });
      }
      stopping.signal.throwIfAborted();
      if (!ready) throw unavailable();
      publish({ state: attempts ? "recovered" : "ready" });
    } catch (error) {
      next.kill("SIGKILL");
      await exited;
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  function recover(): void {
    recovering = (async () => {
      let error = "Worker unavailable.";
      for (const backoff of [250, 1000, 4000].slice(attempts)) {
        attempts++;
        publish({ state: "recovering", attempt: attempts });
        try {
          await delay(backoff, undefined, { signal: stopping.signal });
          await launch();
          return;
        } catch (failure) {
          if (stopping.signal.aborted) return;
          error = failure instanceof Error ? failure.message : "Worker unavailable.";
        }
      }
      publish({
        state: "failed",
        error: `${error} Automatic recovery stopped. Resolve the problem and restart the application.`,
      });
    })().finally(() => {
      recovering = undefined;
    });
  }
  function close(): Promise<void> {
    if (closing) return closing;
    stopping.abort();
    signal?.removeEventListener("abort", abort);
    closing = (async () => {
      const current = child;
      const wasReady = ready;
      let code: number | null | undefined;
      current?.once("exit", (value) => {
        code = value;
      });
      const timeout = setTimeout(() => current?.kill("SIGKILL"), 5000);
      try {
        if (current?.connected) {
          if (wasReady) current.send({ id: ++serial, command: { action: "close" } }, () => {});
          else current.kill("SIGTERM");
        }
        await exited;
        await recovering;
      } finally {
        clearTimeout(timeout);
        subscriptions.clear();
        onStatus.clear();
      }
      if (wasReady && code !== 0)
        throw new Error("Worker shutdown failed; Computer cleanup could not be confirmed");
    })();
    return closing;
  }
  function abort(): void {
    void close().catch(() => {});
  }
  signal?.addEventListener("abort", abort, { once: true });
  // Initial startup has one attempt; failed initial launch leaves no supervisor behind.
  recovering = launch();
  try {
    if (signal?.aborted) abort();
    await recovering;
  } catch (error) {
    await close();
    throw error;
  } finally {
    recovering = undefined;
  }
  return {
    get status() {
      return status;
    },
    onStatus,
    request(command) {
      if (status.state === "recovering" || status.state === "failed")
        return Promise.reject(unavailable());
      return request(command);
    },
    subscribe(id, botId, publishView) {
      subscriptions.set(id, { botId, publish: publishView });
      if (status.state === "ready" || status.state === "recovered")
        void request({ action: "subscribe", botId, subscription: id }).catch(() => {
          if (ready && subscriptions.has(id))
            publish({
              state: "failed",
              error: "Worker subscription failed. Reload the page or restart the application.",
            });
        });
    },
    unsubscribe(id) {
      subscriptions.delete(id);
      if (ready) void request({ action: "unsubscribe", subscription: id }).catch(() => {});
    },
    close,
  };
}
