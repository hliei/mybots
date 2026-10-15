import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, lstat, mkdir, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout } from "node:timers/promises";
import type { AgentResources, OutboundMessage, WebConfiguration } from "@mybots/mailbox";
import { HostMailbox } from "@mybots/mailbox/node";
import { validateHostConfiguration } from "./config/host.ts";
import { provisionSession } from "./container-runner.ts";
import { HostStore, type SavedSession, type SessionRoute } from "./db/index.ts";
import type {
  ModelConfiguration,
  SessionDriver,
  SessionHandle,
  SessionMaterial,
  SessionObservation,
} from "./drivers/types.ts";
import { observesSessions } from "./drivers/types.ts";
import {
  decideStallAction,
  type RecoveryOutcome,
  recoverAbandonedClaims,
  recoverUnclaimedInput,
} from "./reconcile-session.ts";

/** Total platform-delivery attempts for one outbound reply, including the first. */
const MAX_DELIVERY_ATTEMPTS = 3;

/** Bounded, credential-free text persisted for an in-flight delivery failure. */
function deliveryFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 200) || "Delivery failed";
}

export interface HostConfiguration {
  /** Namespaced platform identities of the single personal owner, e.g. `cli:local` or `telegram:42`. */
  owners: string[];
  agent: {
    id: string;
    name: string;
    folder: string;
    model: ModelConfiguration;
    instructions?: string;
    resources?: AgentResources;
    web?: WebConfiguration;
  };
  destinations: { id: string; channelType: string; platformId: string; instance: string }[];
}

export interface HostChannel {
  channelType: string;
  instance: string;
  deliver(message: OutboundMessage, signal: AbortSignal, context: ChannelDelivery): Promise<void>;
}

/** Routing identity of one outbound delivery, independent of the mailbox row. */
export interface ChannelDelivery {
  sessionId: string;
  destinationId: string;
}

export type HostEvent =
  | {
      type: "input";
      sessionId: string;
      messageId: string;
      destinationId: string;
      channelType: string;
      platformId: string;
      threadId: string | null;
      content: string;
      timestamp: string;
    }
  | { type: "output"; sessionId: string; destinationId: string; message: OutboundMessage }
  | { type: "failure"; sessionId?: string; error: string };

interface SessionExecution {
  route: SessionRoute;
  material: SessionMaterial;
  mailbox: HostMailbox;
  /** Fencing token for this host's ownership of the session. */
  incarnation: number;
  /** Clock time at which the current container incarnation began. */
  startedAtMs: number;
  starting?: Promise<void>;
  replacing?: Promise<void>;
  handle?: SessionHandle;
  /** Handles deliberately stopped by replacement, whose exit is not a crash. */
  superseded: Set<SessionHandle>;
  cleanups: Set<Promise<void>>;
  delivering?: Promise<void>;
}

interface LockOwner {
  instanceId: string;
  pid: number;
  startedAt: string;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLockOwner(lock: string): LockOwner | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
    if (
      value &&
      typeof value === "object" &&
      "pid" in value &&
      typeof value.pid === "number" &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0
    )
      return value as LockOwner;
  } catch {
    /* A lock without a readable owner record is an abandoned lock. */
  }
  return undefined;
}

/**
 * Claim the data directory for one live host. An existing lock whose recorded
 * process is gone is an abandoned host from an abnormal exit; the new host
 * adopts its persisted state during reconciliation.
 */
function acquireHostLock(lock: string, owner: LockOwner): void {
  // Serialize owner inspection/publication across processes with the host-local
  // SQLite write lock. A crash releases that lock before another takeover.
  const guard = new DatabaseSync(join(dirname(lock), "host.db"));
  try {
    guard.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE;");
    try {
      mkdirSync(lock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const previous = readLockOwner(lock);
      if (previous && processAlive(previous.pid))
        throw new Error(
          "Host state is already owned; verify the previous host has stopped before clearing data/host.lock",
        );
    }
    writeFileSync(join(lock, "owner.json"), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
    guard.exec("COMMIT");
  } finally {
    guard.close();
  }
}

export class Host {
  private readonly store: HostStore;
  private readonly root: string;
  private readonly driver: SessionDriver;
  private readonly instanceId: string;
  private readonly clock: () => number;
  private readonly reconcileMs: number;
  private readonly controller = new AbortController();
  private readonly prepared = new Map<string, Promise<SessionExecution>>();
  private readonly channels = new Map<string, HostChannel>();
  private readonly observers = new Set<(event: HostEvent) => void>();
  /** Highest outbound sequence already observed per session; seeded at startup. */
  private readonly observed = new Map<string, number>();
  private polling?: Promise<void>;
  private stopping?: Promise<void>;
  private stopped = false;

  private constructor(
    root: string,
    store: HostStore,
    driver: SessionDriver,
    instanceId: string,
    clock: () => number,
    reconcileMs: number,
  ) {
    this.root = root;
    this.store = store;
    this.driver = driver;
    this.instanceId = instanceId;
    this.clock = clock;
    this.reconcileMs = reconcileMs;
  }

  private timestamp(): string {
    return new Date(this.clock()).toISOString();
  }

  static async start(options: {
    root: string;
    configuration: HostConfiguration;
    driver: SessionDriver;
    /** Controlled clock; defaults to the system clock. */
    now?: () => number;
    /** Interval of the background reconciliation pass. */
    reconcileMs?: number;
  }): Promise<Host> {
    const configuration = validateHostConfiguration(options.configuration);
    await mkdir(resolve(options.root), { recursive: true });
    const root = await realpath(options.root);
    const data = join(root, "data");
    await mkdir(data, { recursive: true, mode: 0o700 });
    if ((await lstat(data)).isSymbolicLink())
      throw new Error("Host data must use a real directory");
    await chmod(data, 0o700);
    const instanceId = randomUUID();
    const lock = join(data, "host.lock");
    await acquireHostLock(lock, {
      instanceId,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
    let store: HostStore;
    try {
      store = new HostStore(join(data, "host.db"), configuration);
    } catch (error) {
      await rm(lock, { recursive: true });
      throw error;
    }
    const host = new Host(
      root,
      store,
      options.driver,
      instanceId,
      options.now ?? Date.now,
      options.reconcileMs ?? 60000,
    );
    try {
      store.stopOpenHostInstances(host.timestamp());
      store.registerHostInstance(instanceId, process.pid, host.timestamp());
      await host.reconcileStartup();
      host.polling = host.poll();
      return host;
    } catch (error) {
      await host.stop();
      throw error;
    }
  }

  /**
   * Startup reconciliation: discover persisted sessions and the runtime
   * containers actually running, take over each session's claim, then adopt
   * observed execution or recover what was abandoned.
   */
  private async reconcileStartup(): Promise<void> {
    const signal = this.controller.signal;
    const sessions = this.store.sessions();
    let observations: SessionObservation[] = [];
    if (sessions.length > 0 && observesSessions(this.driver)) {
      // Unknown runtime state cannot authorize writes to runner-owned claims.
      observations = await this.driver.list(signal);
    }
    for (const session of sessions) {
      const execution = await this.prepare(this.store.route(session));
      const incarnation = this.store.tryClaimSession({
        sessionId: session.id,
        instanceId: this.instanceId,
        expectedIncarnation: this.store.currentClaim(session.id)?.incarnation ?? 0,
        containerRef: null,
        now: this.timestamp(),
      });
      if (incarnation === undefined) continue;
      execution.incarnation = incarnation;
      this.store.containerStatus(session.id, "stopped");
      // Pre-existing outbound rows are delivered, not replayed as observations.
      this.observed.set(session.id, execution.mailbox.outputs().at(-1)?.seq ?? 0);
      const observation = observations.find(
        (item) =>
          item.key.sessionId === session.id && item.key.agentGroupId === session.agent_group_id,
      );
      if (observation) await this.adopt(execution, observation);
      else await this.reconcileSession(execution);
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
        resources: route.resources,
        web: route.web,
      }).then((material) => ({
        route,
        material,
        mailbox: new HostMailbox(material.directory),
        incarnation: 0,
        startedAtMs: 0,
        superseded: new Set<SessionHandle>(),
        cleanups: new Set<Promise<void>>(),
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
    if (input.text.trim() === "/reset") return this.reset(input);
    return this.enqueue(input, "message");
  }

  /** Queue an owner control; the runner executes it after the active SDK query settles. */
  reset(input: {
    destinationId: string;
    userId: string;
  }): Promise<{ sessionId: string; messageId: string }> {
    return this.enqueue({ ...input, text: "Conversation reset by owner." }, "reset");
  }

  private async enqueue(
    input: { destinationId: string; userId: string; text: string },
    kind: "message" | "reset",
  ): Promise<{ sessionId: string; messageId: string }> {
    if (this.stopped) throw new Error("Host is stopped");
    if (!input.text.trim()) throw new Error("Input text is required");
    const route = this.store.resolve(input.destinationId, input.userId);
    const execution = await this.prepare(route);
    if (this.stopped) throw new Error("Host is stopped");
    const messageId = randomUUID();
    const message = execution.mailbox.submit({
      id: messageId,
      kind,
      content: input.text,
      channel_type: route.channel_type,
      platform_id: route.platform_id,
      thread_id: route.session.thread_id,
    });
    this.emit({
      type: "input",
      sessionId: route.session.id,
      messageId: message.id,
      destinationId: input.destinationId,
      channelType: message.channel_type,
      platformId: message.platform_id,
      threadId: message.thread_id,
      content: message.content,
      timestamp: message.timestamp,
    });
    this.wake(execution, { force: true });
    return { sessionId: route.session.id, messageId };
  }

  /** Adopt a container the runtime already reports as running for this session. */
  private async adopt(execution: SessionExecution, observation: SessionObservation): Promise<void> {
    const driver = this.driver;
    if (!observesSessions(driver)) return;
    const id = execution.route.session.id;
    if (this.stopped || execution.starting || execution.handle) return;
    execution.starting = (async () => {
      try {
        const handle = await driver.adopt(observation, execution.material, this.controller.signal);
        if (this.stopped) {
          await handle.stop().catch(() => {});
          return;
        }
        this.install(execution, handle, this.clock());
        this.store.markContainerRef(id, handle.ref ?? observation.ref, this.timestamp());
      } catch {
        throw new Error("Observed session container is unavailable; runtime state is uncertain");
      }
    })().finally(() => {
      execution.starting = undefined;
    });
    await execution.starting;
  }

  /** Start a fresh container for a session with no live execution. */
  private wake(execution: SessionExecution, options: { force?: boolean } = {}): void {
    if (this.stopped || execution.starting || execution.replacing || execution.handle) return;
    const id = execution.route.session.id;
    if (!options.force && this.store.containerStatusOf(id) === "failed") return;
    execution.starting = (async () => {
      const incarnation = this.store.tryClaimSession({
        sessionId: id,
        instanceId: this.instanceId,
        expectedIncarnation: execution.incarnation,
        containerRef: null,
        now: this.timestamp(),
      });
      if (incarnation === undefined) return;
      execution.incarnation = incarnation;
      this.store.containerStatus(id, "starting");
      try {
        const handle = await this.driver.start(execution.material, this.controller.signal);
        if (this.stopped) {
          await handle.stop().catch(() => {});
          return;
        }
        this.install(execution, handle, this.clock());
        this.store.markContainerRef(id, handle.ref ?? null, this.timestamp());
      } catch {
        if (!this.stopped) {
          this.store.containerStatus(id, "failed");
          this.emit({
            type: "failure",
            sessionId: id,
            error: "Session driver unavailable; check container and gateway configuration",
          });
        }
      }
    })().finally(() => {
      execution.starting = undefined;
    });
  }

  /**
   * Register a live container and fence its later exit to this incarnation.
   * A superseded incarnation must not change status or clear a newer handle.
   */
  private install(execution: SessionExecution, handle: SessionHandle, startedAtMs: number): void {
    const id = execution.route.session.id;
    const incarnation = execution.incarnation;
    execution.handle = handle;
    execution.startedAtMs = startedAtMs;
    this.store.containerStatus(id, "running");
    const cleanup = (async () => {
      await handle
        .wait()
        .then(
          () => {
            this.settle(execution, incarnation, handle, undefined);
          },
          () => {
            this.settle(execution, incarnation, handle, "Agent runner exited unsuccessfully");
          },
        )
        .catch(() => {});
      await handle.stop().catch(() => {
        if (!this.stopped && execution.incarnation === incarnation)
          this.emit({ type: "failure", sessionId: id, error: "Agent runner cleanup failed" });
      });
      execution.superseded.delete(handle);
      if (execution.handle === handle) execution.handle = undefined;
    })();
    execution.cleanups.add(cleanup);
    void cleanup.then(() => execution.cleanups.delete(cleanup));
  }

  private settle(
    execution: SessionExecution,
    incarnation: number,
    handle: SessionHandle,
    error?: string,
  ): void {
    if (this.stopped) return;
    if (execution.incarnation !== incarnation) return;
    const id = execution.route.session.id;
    this.store.containerStatus(id, "stopped");
    this.store.markContainerRef(id, null, this.timestamp());
    // A deliberate replacement is not a crash, and unclaimed work keeps its
    // bounded recovery schedule instead of restarting forever.
    if (!execution.superseded.has(handle)) {
      if (error) this.emit({ type: "failure", sessionId: id, error });
      this.recordRecovery(execution, recoverUnclaimedInput(execution.mailbox, this.clock()));
    }
  }

  private recordRecovery(execution: SessionExecution, outcome: RecoveryOutcome): void {
    if (outcome.failed.length === 0) return;
    this.emit({
      type: "failure",
      sessionId: execution.route.session.id,
      error: "Unfinished Agent work exhausted its recovery retries",
    });
  }

  /** Reconcile every prepared session against observed runtime and mailbox state. */
  async reconcile(): Promise<void> {
    this.store.touchHostInstance(this.instanceId, this.timestamp());
    for (const pending of [...this.prepared.values()]) {
      try {
        const execution = await pending;
        if (this.stopped) return;
        await this.reconcileSession(execution);
      } catch {
        if (!this.stopped) this.emit({ type: "failure", error: "Session mailbox unavailable" });
      }
    }
  }

  private async reconcileSession(
    execution: SessionExecution,
    now: number = this.clock(),
  ): Promise<void> {
    const id = execution.route.session.id;
    try {
      execution.mailbox.syncAcknowledgements();
      if (execution.handle) {
        await this.enforceStall(execution, now);
        return;
      }
      const outcome = recoverAbandonedClaims(execution.mailbox, now);
      this.recordRecovery(execution, outcome);
      const due = execution.mailbox
        .inputs()
        .some(
          (input) =>
            input.status === "pending" &&
            (!input.process_after || Date.parse(input.process_after) <= now),
        );
      if (due) this.wake(execution);
    } catch {
      if (!this.stopped)
        this.emit({ type: "failure", sessionId: id, error: "Session mailbox unavailable" });
    }
  }

  /** Replace a running container whose heartbeat and claims show no progress. */
  private async enforceStall(execution: SessionExecution, now: number): Promise<void> {
    if (execution.replacing) return;
    const id = execution.route.session.id;
    const heartbeatAtMs = execution.mailbox.heartbeat() ?? 0;
    const state = execution.mailbox.activity();
    const activeTool = state?.current_tool
      ? { name: state.current_tool, declaredTimeoutMs: state.tool_declared_timeout_ms ?? null }
      : null;
    const claims = execution.mailbox
      .processingClaims()
      .map((claim) => ({
        messageId: claim.message_id,
        claimedAtMs: Date.parse(claim.status_changed),
      }))
      .filter((claim) => Number.isFinite(claim.claimedAtMs));
    const decision = decideStallAction({
      now,
      heartbeatAtMs,
      startedAtMs: execution.startedAtMs,
      activeTool,
      claims,
    });
    if (decision.action === "keep") return;
    this.emit({
      type: "failure",
      sessionId: id,
      error:
        decision.reason === "stalled"
          ? "Agent execution stalled; replacing the session container"
          : "Agent execution stopped responding after claiming input; replacing the session container",
    });
    execution.replacing = (async () => {
      // Stop the old container before touching runner-owned state, then recover
      // its claims. The incarnation fence ignores the superseded handle's exit.
      const handle = execution.handle;
      if (handle) {
        execution.superseded.add(handle);
        try {
          await handle.stop();
        } catch {
          execution.superseded.delete(handle);
          this.emit({
            type: "failure",
            sessionId: id,
            error: "Session container could not be stopped; recovery deferred",
          });
          return;
        }
        if (execution.handle === handle) execution.handle = undefined;
      }
      this.store.containerStatus(id, "stopped");
      this.store.markContainerRef(id, null, this.timestamp());
    })().finally(() => {
      execution.replacing = undefined;
    });
    await execution.replacing;
    if (!execution.handle) await this.reconcileSession(execution, now);
  }

  private async poll(): Promise<void> {
    const signal = this.controller.signal;
    let nextReconcile = this.clock() + this.reconcileMs;
    while (!signal.aborted) {
      if (this.clock() >= nextReconcile) {
        nextReconcile = this.clock() + this.reconcileMs;
        await this.reconcile();
      }
      for (const pending of this.prepared.values()) {
        if (signal.aborted) break;
        try {
          const execution = await pending;
          if (signal.aborted) break;
          execution.mailbox.syncAcknowledgements();
          // Observe new rows even while an earlier channel delivery remains pending.
          const route = execution.route;
          if (!this.owned(route.session.id)) continue;
          for (const message of execution.mailbox.outputs()) {
            if (message.seq <= (this.observed.get(route.session.id) ?? 0)) continue;
            this.observed.set(route.session.id, message.seq);
            this.emit({
              type: "output",
              sessionId: route.session.id,
              destinationId: route.session.messaging_group_id,
              message,
            });
          }
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
        if (!this.owned(execution.route.session.id)) break;
        if (execution.mailbox.deliveryStatus(message.id)) continue;
        const route = execution.route;
        const attempt = this.store.deliveryAttempt(message.id);
        // Persisted eligibility boundary: the selected contract records no delay today.
        if (attempt?.next_attempt_at && attempt.next_attempt_at > new Date().toISOString())
          continue;
        // A crash can persist the final attempt before its terminal state; do not send again.
        if (attempt && attempt.attempts >= MAX_DELIVERY_ATTEMPTS) {
          this.failDelivery(execution, message);
          continue;
        }
        const input = execution.mailbox.inputs().find((input) => input.id === message.in_reply_to);
        if (
          !input ||
          message.channel_type !== input.channel_type ||
          message.platform_id !== input.platform_id ||
          message.thread_id !== input.thread_id
        ) {
          this.failDelivery(execution, message, "Outbound routing does not match its input");
          continue;
        }
        const channel = this.channels.get(this.channelKey(route.channel_type, route.instance));
        // A destination whose channel is not attached yet is not a failed send.
        if (!channel) continue;
        try {
          await channel.deliver(message, signal, {
            sessionId: route.session.id,
            destinationId: route.session.messaging_group_id,
          });
          if (signal.aborted) break;
          execution.mailbox.markDelivered(message.id, "delivered");
          this.store.clearDeliveryAttempt(message.id);
        } catch (error) {
          if (signal.aborted) break;
          this.recordDeliveryFailure(execution, message, deliveryFailureReason(error));
        }
      }
    } catch {
      if (!signal.aborted) this.emit({ type: "failure", error: "Session mailbox unavailable" });
    }
  }

  /** Record terminal failed delivery: no later host instance retries the message. */
  private failDelivery(
    execution: SessionExecution,
    message: OutboundMessage,
    error = "Channel delivery failed permanently",
  ): void {
    execution.mailbox.markDelivered(message.id, "failed");
    this.store.clearDeliveryAttempt(message.id);
    this.emit({ type: "failure", sessionId: execution.route.session.id, error });
  }

  /** Count a failed platform attempt; exhaustion records explicit failed delivery. */
  private recordDeliveryFailure(
    execution: SessionExecution,
    message: OutboundMessage,
    error: string,
  ): void {
    const attempts = this.store.recordDeliveryAttempt({
      messageId: message.id,
      sessionId: execution.route.session.id,
      at: new Date().toISOString(),
      nextAttemptAt: null,
      error,
    });
    if (attempts < MAX_DELIVERY_ATTEMPTS) return;
    this.failDelivery(execution, message);
  }

  private channelKey(channelType: string, instance: string): string {
    return JSON.stringify([channelType, instance]);
  }

  /** A session's persisted claim decides which host instance may act on it. */
  private owned(sessionId: string): boolean {
    return this.store.currentClaim(sessionId)?.claimed_by === this.instanceId;
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
      claim: this.store.currentClaim(sessionId),
      deliveries: execution.mailbox.outputs().map((message) => {
        const attempt = this.store.deliveryAttempt(message.id);
        return {
          id: message.id,
          status: execution.mailbox.deliveryStatus(message.id),
          attempts: attempt?.attempts ?? 0,
          lastAttemptAt: attempt?.last_attempt_at ?? null,
          lastError: attempt?.last_error ?? null,
        };
      }),
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
              await execution.replacing;
              if (execution.handle) await execution.handle.stop();
              await Promise.allSettled([...execution.cleanups]);
              await execution.delivering;
              this.store.containerStatus(execution.route.session.id, "stopped");
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
      if (clean) {
        this.store.releaseClaims(this.instanceId, this.timestamp());
        this.store.stopHostInstance(this.instanceId, this.timestamp());
      }
      this.store.close();
      if (clean) await rm(join(this.root, "data", "host.lock"), { recursive: true });
    }
  }
}
