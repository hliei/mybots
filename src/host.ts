import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { validateHostConfiguration } from "./config/host.ts";
import { provisionSession } from "./container-runner.ts";
import { HostStore, type SavedSession, type SessionRoute } from "./db/index.ts";
import type {
  ModelConfiguration,
  SessionDriver,
  SessionHandle,
  SessionMaterial,
} from "./drivers/types.ts";
import { HostMailbox } from "./mailbox/node.ts";
import type { OutboundMessage } from "./mailbox/types.ts";

export interface HostConfiguration {
  owner: string;
  agent: {
    id: string;
    name: string;
    folder: string;
    model: ModelConfiguration;
    instructions?: string;
  };
  destinations: { id: string; channelType: string; platformId: string; instance: string }[];
}

export interface HostChannel {
  channelType: string;
  instance: string;
  deliver(message: OutboundMessage, signal: AbortSignal): Promise<void>;
}

export type HostEvent =
  | { type: "input"; sessionId: string; messageId: string; destinationId: string }
  | { type: "output"; sessionId: string; message: OutboundMessage }
  | { type: "failure"; sessionId?: string; error: string };

interface SessionExecution {
  route: SessionRoute;
  material: SessionMaterial;
  mailbox: HostMailbox;
  starting?: Promise<void>;
  handle?: SessionHandle;
  exited?: Promise<void>;
  delivering?: Promise<void>;
}

export class Host {
  private readonly store: HostStore;
  private readonly root: string;
  private readonly driver: SessionDriver;
  private readonly controller = new AbortController();
  private readonly prepared = new Map<string, Promise<SessionExecution>>();
  private readonly channels = new Map<string, HostChannel>();
  private readonly observers = new Set<(event: HostEvent) => void>();
  private polling?: Promise<void>;
  private stopping?: Promise<void>;
  private stopped = false;
  private closed = false;
  private constructor(root: string, store: HostStore, driver: SessionDriver) {
    this.root = root;
    this.store = store;
    this.driver = driver;
  }

  static async start(options: {
    root: string;
    configuration: HostConfiguration;
    driver: SessionDriver;
  }): Promise<Host> {
    const configuration = validateHostConfiguration(options.configuration);
    await mkdir(resolve(options.root), { recursive: true });
    const root = await realpath(options.root);
    const data = join(root, "data");
    await mkdir(data, { recursive: true, mode: 0o700 });
    if ((await lstat(data)).isSymbolicLink())
      throw new Error("Host data must use a real directory");
    await chmod(data, 0o700);
    await mkdir(join(data, "host.lock"), { mode: 0o700 }).catch(() => {
      throw new Error(
        "Host state is already owned; verify the previous host has stopped before clearing data/host.lock",
      );
    });
    let store: HostStore;
    try {
      store = new HostStore(join(data, "host.db"), configuration);
    } catch (error) {
      await rm(join(data, "host.lock"), { recursive: true });
      throw error;
    }
    const host = new Host(root, store, options.driver);
    try {
      for (const session of host.store.sessions()) {
        const execution = await host.prepare(host.store.route(session));
        host.store.containerStatus(session.id, "stopped");
        // Wake only unclaimed input. Abandoned processing recovery is a separate policy.
        const claimed = new Set(execution.mailbox.acknowledgements().map((ack) => ack.message_id));
        if (
          execution.mailbox
            .inputs()
            .some((input) => input.status === "pending" && !claimed.has(input.id))
        )
          host.wake(execution);
      }
      host.polling = host.poll();
      return host;
    } catch (error) {
      await host.stop();
      throw error;
    }
  }

  private prepare(route: SessionRoute): Promise<SessionExecution> {
    let pending = this.prepared.get(route.session.id);
    if (!pending) {
      pending = provisionSession({
        root: this.root,
        key: { agentGroupId: route.session.agent_group_id, sessionId: route.session.id },
        folder: route.folder,
        model: route.model,
        instructions: route.instructions,
      }).then((material) => ({
        route,
        material,
        mailbox: new HostMailbox(material.directory),
      }));
      this.prepared.set(route.session.id, pending);
      void pending.catch(() => this.prepared.delete(route.session.id));
    }
    return pending;
  }

  async accept(input: {
    destinationId: string;
    userId: string;
    text: string;
  }): Promise<{ sessionId: string; messageId: string }> {
    if (this.stopped) throw new Error("Host is stopped");
    if (!input.text.trim()) throw new Error("Input text is required");
    const route = this.store.resolve(input.destinationId, input.userId);
    const execution = await this.prepare(route);
    if (this.stopped) throw new Error("Host is stopped");
    const messageId = randomUUID();
    execution.mailbox.submit({
      id: messageId,
      content: input.text,
      channel_type: route.channel_type,
      platform_id: route.platform_id,
      thread_id: route.session.thread_id,
    });
    this.emit({
      type: "input",
      sessionId: route.session.id,
      messageId,
      destinationId: input.destinationId,
    });
    this.wake(execution);
    return { sessionId: route.session.id, messageId };
  }

  private wake(execution: SessionExecution): void {
    if (this.stopped || execution.starting || execution.handle) return;
    const id = execution.route.session.id;
    this.store.containerStatus(id, "starting");
    execution.starting = (async () => {
      try {
        const handle = await this.driver.start(execution.material, this.controller.signal);
        if (this.stopped) {
          await handle.stop();
          return;
        }
        execution.handle = handle;
        this.store.containerStatus(id, "running");
        execution.exited = handle
          .wait()
          .then(
            () => {
              if (!this.stopped) this.store.containerStatus(id, "stopped");
            },
            () => {
              if (!this.stopped) this.fail(id, "Agent runner exited unsuccessfully");
            },
          )
          .finally(async () => {
            await handle.stop().catch(() => {
              if (!this.stopped) this.fail(id, "Agent runner cleanup failed");
            });
            execution.handle = undefined;
          });
      } catch {
        if (!this.stopped)
          this.fail(id, "Session driver unavailable; check container and gateway configuration");
      } finally {
        execution.starting = undefined;
      }
    })();
  }

  private fail(sessionId: string, error: string): void {
    this.store.containerStatus(sessionId, "failed");
    this.emit({ type: "failure", sessionId, error });
  }

  private async poll(): Promise<void> {
    const signal = this.controller.signal;
    while (!signal.aborted) {
      for (const pending of this.prepared.values()) {
        if (signal.aborted) break;
        try {
          const execution = await pending;
          if (signal.aborted) break;
          execution.mailbox.syncAcknowledgements();
          execution.delivering ??= this.deliver(execution).finally(() => {
            execution.delivering = undefined;
          });
        } catch {
          if (!signal.aborted) this.emit({ type: "failure", error: "Session mailbox unavailable" });
        }
      }
      await setTimeout(20, undefined, { signal }).catch((error) => {
        if (!signal.aborted) throw error;
      });
    }
  }

  private async deliver(execution: SessionExecution): Promise<void> {
    const signal = this.controller.signal;
    try {
      for (const message of execution.mailbox.outputs()) {
        if (signal.aborted) break;
        if (execution.mailbox.deliveryStatus(message.id)) continue;
        const route = execution.route;
        const input = execution.mailbox.inputs().find((input) => input.id === message.in_reply_to);
        if (
          !input ||
          message.channel_type !== input.channel_type ||
          message.platform_id !== input.platform_id ||
          message.thread_id !== input.thread_id
        ) {
          execution.mailbox.markDelivered(message.id, "failed");
          this.emit({
            type: "failure",
            sessionId: route.session.id,
            error: "Outbound routing does not match its input",
          });
          continue;
        }
        const channel = this.channels.get(this.channelKey(route.channel_type, route.instance));
        if (!channel) continue;
        try {
          await channel.deliver(message, signal);
          if (signal.aborted) break;
          execution.mailbox.markDelivered(message.id, "delivered");
          this.emit({ type: "output", sessionId: route.session.id, message });
        } catch {
          if (!signal.aborted) {
            execution.mailbox.markDelivered(message.id, "failed");
            this.emit({
              type: "failure",
              sessionId: route.session.id,
              error: "Channel delivery failed",
            });
          }
        }
      }
    } catch {
      if (!signal.aborted) this.emit({ type: "failure", error: "Session mailbox unavailable" });
    }
  }

  private channelKey(channelType: string, instance: string): string {
    return JSON.stringify([channelType, instance]);
  }

  attachChannel(channel: HostChannel): () => void {
    if (this.stopped) throw new Error("Host is stopped");
    const key = this.channelKey(channel.channelType, channel.instance);
    if (this.channels.has(key)) throw new Error("Channel already attached");
    this.channels.set(key, channel);
    return () => {
      this.channels.delete(key);
    };
  }

  observe(observer: (event: HostEvent) => void): () => void {
    this.observers.add(observer);
    return () => {
      this.observers.delete(observer);
    };
  }

  private emit(event: HostEvent): void {
    for (const observer of this.observers) {
      try {
        observer(event);
      } catch {
        /* Observation cannot prevent persisted work. */
      }
    }
  }

  sessions(): SavedSession[] {
    return this.store.sessions();
  }

  async inspect(sessionId: string) {
    const execution = await this.prepared.get(sessionId);
    if (!execution) throw new Error("Unknown session");
    return {
      session: this.store.sessions().find((session) => session.id === sessionId),
      inputs: execution.mailbox.inputs(),
      outputs: execution.mailbox.outputs(),
      continuation: execution.mailbox.continuation(),
      deliveries: execution.mailbox.outputs().map((message) => ({
        id: message.id,
        status: execution.mailbox.deliveryStatus(message.id),
      })),
    };
  }

  stop(options: { timeoutMs?: number } = {}): Promise<void> {
    this.stopping ??= this.shutdown(options.timeoutMs ?? 10000);
    return this.stopping;
  }

  private async shutdown(timeoutMs: number): Promise<void> {
    this.stopped = true;
    this.controller.abort();
    const deadline = new AbortController();
    const expired = setTimeout(timeoutMs, undefined, { signal: deadline.signal }).then(() => {
      throw new Error("Host shutdown timed out; session resources may still be stopping");
    });
    let clean = false;
    try {
      await Promise.race([
        (async () => {
          const preparations = await Promise.allSettled(this.prepared.values());
          await Promise.all(
            preparations.map(async (result) => {
              if (result.status !== "fulfilled") return;
              const execution = result.value;
              await execution.starting;
              if (execution.handle) await execution.handle.stop();
              await execution.exited;
              await execution.delivering;
              if (!this.closed) this.store.containerStatus(execution.route.session.id, "stopped");
            }),
          );
          await this.polling;
        })(),
        expired,
      ]);
      clean = true;
    } finally {
      deadline.abort();
      this.channels.clear();
      this.observers.clear();
      this.closed = true;
      this.store.close();
      if (clean) await rm(join(this.root, "data", "host.lock"), { recursive: true });
    }
  }
}
