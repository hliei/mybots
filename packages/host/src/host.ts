import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { chmod, lstat, mkdir, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout } from "node:timers/promises";
import type {
  AgentResources,
  ExecutionRecord,
  ExecutionSnapshot,
  OutboundMessage,
  WebConfiguration,
} from "@mybots/mailbox";
import { HostMailbox } from "@mybots/mailbox/node";
import { BotRequestError, parseBotCreate, parseBotSettings, publicModel } from "./bots.ts";
import { ChatRequestError, chatInput } from "./chat.ts";
import { validateHostConfiguration } from "./config/host.ts";
import { provisionSession, replaceSessionContext } from "./container-runner.ts";
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
import { LocalSkills } from "./skills.ts";

/** Total platform-delivery attempts for one outbound reply, including the first. */
const MAX_DELIVERY_ATTEMPTS = 3;

/** Bounded, credential-free text persisted for an in-flight delivery failure. */
/** A wait is complete when no tool is current and every tool call has its result. */
function toolResultsComplete(records: ExecutionRecord[], currentTool: string | null): boolean {
  if (currentTool) return false;
  const open = new Set<string>();
  for (const record of records) {
    if (record.kind === "tool-call") {
      if (!record.toolCallId) return false;
      open.add(record.toolCallId);
    } else if (record.kind === "tool-result" && record.toolCallId) open.delete(record.toolCallId);
  }
  return open.size === 0;
}

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
  /** Installation-approved models; defaults to the bootstrap model. */
  approvedModels?: ModelConfiguration[];
  /** Bounds actual Attempt execution. Omitted means four active Attempts. */
  admission?: { activeExecutionLimit: number };
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
  | {
      type: "execution";
      botId: string;
      threadId: string;
      taskId: string;
      runId: string;
      snapshot: ExecutionSnapshot;
    }
  | { type: "failure"; sessionId?: string; error: string };

interface SessionExecution {
  route: SessionRoute;
  material: SessionMaterial;
  mailbox: HostMailbox;
  /** Fencing token for this host's ownership of the session. */
  incarnation: number;
  observedSnapshot?: string;
  /** Clock time at which the current container incarnation began. */
  startedAtMs: number;
  starting?: Promise<void>;
  replacing?: Promise<void>;
  handle?: SessionHandle;
  /** Handles deliberately stopped by replacement, whose exit is not a crash. */
  superseded: Set<SessionHandle>;
  cleanups: Set<Promise<void>>;
  delivering?: Promise<void>;
  /** Set while a stopped Attempt is being replaced with saved Bot configuration. */
  cutover?: "pending" | "applying";
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
  private readonly configuration: HostConfiguration;
  private readonly store: HostStore;
  private readonly root: string;
  private readonly driver: SessionDriver;
  private readonly instanceId: string;
  private readonly clock: () => number;
  private readonly reconcileMs: number;
  private readonly controller = new AbortController();
  private readonly prepared = new Map<string, Promise<SessionExecution>>();
  private readonly preparedExecutions = new Map<string, SessionExecution>();
  private readonly channels = new Map<string, HostChannel>();
  private readonly observers = new Set<(event: HostEvent) => void>();
  /** Highest outbound sequence already observed per session; seeded at startup. */
  private readonly observed = new Map<string, number>();
  private polling?: Promise<void>;
  private readonly stopJobs = new Map<string, Promise<void>>();
  private stopping?: Promise<void>;
  private stopped = false;
  private storeClosed = false;

  private constructor(
    root: string,
    store: HostStore,
    driver: SessionDriver,
    instanceId: string,
    clock: () => number,
    reconcileMs: number,
    configuration: HostConfiguration,
  ) {
    this.configuration = configuration;
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
      configuration,
    );
    try {
      store.stopOpenHostInstances(host.timestamp());
      store.registerHostInstance(instanceId, process.pid, host.timestamp());
      store.threads.configureAdmission(
        configuration.admission?.activeExecutionLimit ?? 4,
        host.timestamp(),
      );
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
      if (observation) {
        await this.adopt(execution, observation);
        // A completed Run must release its adopted container before startup resolves.
        this.syncChat(execution);
        if (execution.replacing) await execution.replacing;
        if (
          execution.route.session.purpose === "run" &&
          this.store.threads.run(session.id).state === "stopping"
        )
          void this.executeStop(execution);
      } else await this.reconcileSession(execution);
    }
    this.schedule();
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
        configurationVersion: route.configurationVersion,
        retainExistingContext: route.session.purpose === "run",
        runContext:
          route.session.purpose === "run"
            ? this.store.threads.context(route.session.id)
            : undefined,
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
      void pending.then(
        (execution) => {
          this.preparedExecutions.set(route.session.id, execution);
        },
        () => this.prepared.delete(route.session.id),
      );
    }
    return pending;
  }

  async accept(input: {
    destinationId: string;
    userId: string;
    text: string;
    requestId?: string;
  }): Promise<{ sessionId: string; messageId: string; backgroundBoundary?: number }> {
    if (this.stopped) throw new Error("Host is stopped");
    if (input.text.trim() === "/reset") return this.reset(input);
    const botId = this.store.ownerDestination(input.destinationId, input.userId);
    const parsed = chatInput({ requestId: input.requestId ?? randomUUID(), text: input.text }, [
      "text",
    ]);
    await this.threadDetail(botId);
    const admitted = this.store.threads.send(
      { requestId: parsed.requestId as string, botId, text: parsed.text as string, newTask: false },
      this.timestamp(),
      input.destinationId,
    );
    const execution = await this.prepare(
      this.store.route(this.store.threads.session(admitted.runId)),
    );
    this.syncChat(execution);
    const source = execution.mailbox.inputs().find((row) => row.id === admitted.messageId);
    if (source && !admitted.replayed)
      this.emit({
        type: "input",
        sessionId: admitted.runId,
        messageId: admitted.messageId,
        destinationId: input.destinationId,
        channelType: source.channel_type,
        platformId: source.platform_id,
        threadId: source.thread_id,
        content: source.content,
        timestamp: source.timestamp,
      });
    this.schedule();
    return { sessionId: admitted.runId, messageId: admitted.messageId };
  }

  async reset(input: { destinationId: string; userId: string }): Promise<{
    sessionId: string;
    messageId: string;
    backgroundBoundary: number;
  }> {
    const botId = this.store.ownerDestination(input.destinationId, input.userId);
    if (this.stopped) throw new Error("Host is stopped");
    const admitted = this.store.threads.reset(botId, randomUUID());
    return { sessionId: "", messageId: "", backgroundBoundary: admitted.backgroundBoundary };
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
    const botId = execution.route.session.agent_group_id;
    if (
      execution.route.session.purpose === "run" &&
      !["queued", "active"].includes(this.store.threads.run(id).state)
    )
      return;
    if (execution.route.session.purpose === "run") {
      if (!this.store.threads.holdsReservation(id)) return;
    } else if (this.store.threads.botIsReserved(botId)) return;
    if (!options.force && this.store.containerStatusOf(id) === "failed") {
      this.store.threads.abandonAdmission(id);
      return;
    }
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
      if (execution.route.session.purpose === "run")
        this.store.threads.startAttempt(id, incarnation, this.timestamp());
      this.store.containerStatus(id, "starting");
      try {
        this.alignContext(execution);
        execution.mailbox.setExecutionIncarnation(incarnation);
        const handle = await this.driver.start(execution.material, this.controller.signal);
        if (this.stopped) {
          await handle.stop().catch(() => {});
          return;
        }
        this.install(execution, handle, this.clock());
        this.store.markContainerRef(id, handle.ref ?? null, this.timestamp());
      } catch {
        if (!this.stopped) {
          this.store.threads.abandonAdmission(id);
          this.releaseBot(execution);
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
      this.releaseBot(execution, incarnation);
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
    if (this.stopped || execution.incarnation !== incarnation) return;
    const id = execution.route.session.id;
    this.store.containerStatus(id, "stopped");
    this.store.markContainerRef(id, null, this.timestamp());
    // A deliberate replacement is not a crash, and unclaimed work keeps its
    // bounded recovery schedule instead of restarting forever.
    if (!execution.superseded.has(handle)) {
      if (error) this.emit({ type: "failure", sessionId: id, error });
      // A runner can exit immediately after persisting final evidence, before the poll sees it.
      execution.mailbox.syncAcknowledgements();
      this.syncChat(execution);
      this.recordRecovery(execution, recoverAbandonedClaims(execution.mailbox, this.clock()));
      this.recordRecovery(execution, recoverUnclaimedInput(execution.mailbox, this.clock()));
    }
  }

  private recordRecovery(execution: SessionExecution, outcome: RecoveryOutcome): void {
    this.store.threads.failInputs(outcome.failed, this.timestamp());
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
      this.syncChat(execution);
      if (execution.route.session.purpose === "run") {
        const state = this.store.threads.run(id).state;
        if (state === "uncertain" || state === "closed") return;
        if (state === "stopping") {
          if (!execution.handle && !execution.starting && !execution.replacing)
            this.finishConfirmedStop(execution);
          return;
        }
      }
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
      this.refreshAdmission(execution);
      if (due && this.store.threads.holdsReservation(id) && this.executionReady(execution))
        this.wake(execution);
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
      for (const execution of this.preparedExecutions.values()) this.refreshAdmission(execution);
      this.schedule();
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
          this.syncChat(execution);
          this.reconcileDurableWait(execution);
          this.historyOperations(execution);
          if (!execution.handle && !execution.starting && !execution.replacing)
            await this.reconcileSession(execution);
          // Observe new rows even while an earlier channel delivery remains pending.
          const route = execution.route;
          if (!this.owned(route.session.id)) continue;
          for (const message of execution.mailbox.outputs()) {
            if (message.seq <= (this.observed.get(route.session.id) ?? 0)) continue;
            this.observed.set(route.session.id, message.seq);
            this.emit({
              type: "output",
              sessionId: route.session.id,
              destinationId:
                route.session.purpose === "run"
                  ? (this.store.threads
                      .inputs(route.session.id)
                      .find((input) => input.message_id === message.in_reply_to)?.destination_id ??
                    route.session.messaging_group_id)
                  : route.session.messaging_group_id,
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
        const destinationId =
          route.session.purpose === "run"
            ? this.store.threads
                .inputs(route.session.id)
                .find((row) => row.message_id === message.in_reply_to)?.destination_id
            : route.session.messaging_group_id;
        const destination = destinationId ? this.store.threads.destination(destinationId) : route;
        const channel = this.channels.get(
          this.channelKey(destination.channel_type, destination.instance),
        );
        // A destination whose channel is not attached yet is not a failed send.
        if (!channel) continue;
        try {
          await channel.deliver(message, signal, {
            sessionId: route.session.id,
            destinationId: destinationId ?? route.session.messaging_group_id,
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

  botOptions() {
    const tools = ["read", "write", "edit", "bash", "grep", "find", "ls"];
    if (this.configuration.agent.web?.search) tools.push("web_search");
    if (this.configuration.agent.web?.fetch) tools.push("fetch_content");
    return {
      models: (this.configuration.approvedModels ?? [this.configuration.agent.model]).map(
        publicModel,
      ),
      tools,
    };
  }

  managedBots() {
    return this.store.managedBots();
  }

  createBot(value: unknown) {
    if (this.stopped) throw new Error("Host is stopped");
    const input = parseBotCreate(value);
    const admitted = this.store.botCreation(input);
    if (admitted) return { requestId: input.requestId, bot: admitted, replayed: true };
    const model = (this.configuration.approvedModels ?? [this.configuration.agent.model]).find(
      (model) => model.provider === input.model.provider && model.id === input.model.id,
    );
    if (!model) throw new BotRequestError("Select an installation-approved model.");
    const available = this.botOptions().tools;
    if (input.tools.some((tool) => !available.includes(tool)))
      throw new BotRequestError("Select only available tools.");
    const id = `ag-${randomUUID()}`;
    const folder = id;
    const groups = join(this.root, "groups");
    const workspace = join(groups, folder);
    try {
      mkdirSync(groups, { recursive: true });
      if (lstatSync(groups).isSymbolicLink() || !lstatSync(groups).isDirectory())
        throw new Error("Bot workspaces must use real directories");
      mkdirSync(workspace);
    } catch {
      throw new BotRequestError(
        "Cannot create the Bot workspace. Check the Host groups directory.",
        503,
      );
    }
    try {
      const bot = this.store.createBot(input, id, folder, model, this.configuration.agent.web);
      this.store.threads.ensureThreads(this.timestamp());
      return { requestId: input.requestId, bot, replayed: false };
    } catch (error) {
      rmSync(workspace, { recursive: true, force: true });
      throw error;
    }
  }

  localSkills(botId: string) {
    if (!this.managedBots().some((bot) => bot.id === botId))
      throw new BotRequestError("Bot not found.", 404);
    return new LocalSkills(this.root).list(botId);
  }

  importSkill(botId: string, value: unknown) {
    this.localSkills(botId);
    return new LocalSkills(this.root).import(botId, value);
  }

  updateBot(botId: string, value: unknown) {
    if (this.stopped) throw new Error("Host is stopped");
    const input = parseBotSettings(value);
    this.localSkills(botId);
    if (input.skills) new LocalSkills(this.root).selected(botId, input.skills);
    const model = (this.configuration.approvedModels ?? [this.configuration.agent.model]).find(
      (item) => item.provider === input.model.provider && item.id === input.model.id,
    );
    if (!model) throw new BotRequestError("Select an installation-approved model.");
    const available = this.botOptions().tools;
    if (input.tools.some((tool) => !available.includes(tool)))
      throw new BotRequestError("Select only available tools.");
    const result = this.store.updateBot(
      botId,
      {
        requestId: input.requestId,
        instructions: input.instructions,
        model: input.model,
        tools: input.tools,
        ...(input.skills ? { skills: input.skills } : {}),
      },
      model,
    );
    void this.noticeConfiguration(botId);
    return { requestId: input.requestId, ...result };
  }

  private async noticeConfiguration(botId: string): Promise<void> {
    for (const pending of this.prepared.values()) {
      const execution = await pending;
      if (execution.route.session.agent_group_id === botId) this.syncChat(execution);
    }
  }

  sessions(): SavedSession[] {
    return this.store.sessions();
  }

  async threadDetail(botId: string) {
    this.store.threads.thread(botId);
    for (const pending of this.prepared.values()) {
      const execution = await pending;
      if (execution.route.session.agent_group_id === botId) this.syncChat(execution);
    }
    return this.store.threads.detail(botId);
  }

  private historyOperations(execution: SessionExecution): void {
    const { mailbox, route } = execution;
    if (route.session.purpose !== "run" || !this.owned(route.session.id)) return;
    for (const request of mailbox.historyRequests()) {
      if (mailbox.operationResponse(request.id)) continue;
      try {
        if (
          (!execution.handle && !execution.starting) ||
          request.incarnation !== mailbox.executionIncarnation() ||
          request.incarnation === 0
        )
          throw new ChatRequestError("Execution scope is no longer active.", 403);
        if (!request.input || typeof request.input !== "object" || Array.isArray(request.input))
          throw new ChatRequestError("Invalid history arguments.");
        const input = request.input as Record<string, unknown>;
        if (
          request.operation === "search_history"
            ? typeof input.query !== "string" || input.messageId !== undefined
            : request.operation === "read_history"
              ? typeof input.messageId !== "string" || input.query !== undefined
              : true
        )
          throw new ChatRequestError("Invalid history operation.");
        mailbox.respondOperation(request.id, {
          result: this.store.threads.history(route.session.agent_group_id, input, route.session.id),
        });
      } catch (error) {
        mailbox.respondOperation(request.id, {
          error: error instanceof ChatRequestError ? error.message : "History unavailable.",
        });
      }
    }
    const snapshot = mailbox.executionSnapshot();
    if (!snapshot || snapshot.incarnation !== mailbox.executionIncarnation()) return;
    const serialized = JSON.stringify(snapshot);
    if (serialized === execution.observedSnapshot) return;
    execution.observedSnapshot = serialized;
    this.emit({
      type: "execution",
      botId: route.session.agent_group_id,
      threadId: route.session.thread_id as string,
      taskId: this.store.threads.run(route.session.id).task_id,
      runId: route.session.id,
      snapshot,
    });
  }

  async runHistory(botId: string, runId: string, input: Record<string, unknown>) {
    const thread = this.store.threads.thread(botId);
    const session = this.store.threads.session(runId);
    if (session.agent_group_id !== botId || session.thread_id !== thread.id)
      throw new ChatRequestError("Run not found for this Bot.", 404);
    if (
      Object.keys(input).some((key) => !["after", "recordId", "textOffset", "kind"].includes(key))
    )
      throw new ChatRequestError("Unknown Run history field.");
    const offset = input.textOffset === undefined ? 0 : Number(input.textOffset);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      (input.after !== undefined && typeof input.after !== "string") ||
      (input.recordId !== undefined && typeof input.recordId !== "string")
    )
      throw new ChatRequestError("Invalid Run history cursor.");
    const prepared = this.prepared.get(runId);
    if (!prepared) throw new ChatRequestError("Run evidence unavailable.", 503);
    const execution = await prepared;
    if (
      input.kind !== undefined &&
      !["inputs", "attempts", "records"].includes(input.kind as string)
    )
      throw new ChatRequestError("Invalid Run history kind.");
    const all: ExecutionRecord[] =
      input.kind === "inputs"
        ? this.store.threads.inputs(runId).map((row) => ({
            id: row.message_id,
            kind: "input",
            text: row.content,
            createdAt: row.admitted_at,
            inputId: row.message_id,
          }))
        : input.kind === "attempts"
          ? this.store.threads.attempts(runId).map((row) => ({
              id: row.id as string,
              kind: "attempt",
              text: `Configuration ${row.configurationVersion}; started ${row.startedAt}; ${row.endedAt ? `stopped ${row.endedAt}` : "executing"}`,
              createdAt: row.startedAt as string,
              incarnation: row.incarnation as number,
            }))
          : execution.mailbox.executionRecords();
    const after =
      input.after === undefined ? -1 : all.findIndex((record) => record.id === input.after);
    if (input.after !== undefined && after < 0)
      throw new ChatRequestError("Run history cursor not found.", 404);
    const selected =
      input.recordId === undefined
        ? all.slice(after + 1, after + 7)
        : all.filter((record) => record.id === input.recordId);
    if (input.recordId !== undefined && !selected.length)
      throw new ChatRequestError("Run record not found.", 404);
    const records = selected.slice(0, 5).map((record) => {
      const chars = Array.from(record.text);
      return {
        ...record,
        text: chars.slice(offset, offset + 2000).join(""),
        textOffset: offset,
        nextTextOffset: offset + 2000 < chars.length ? offset + 2000 : null,
        truncated: offset > 0 || offset + 2000 < chars.length,
      };
    });
    const result = {
      botId,
      runId,
      records,
      snapshot: execution.mailbox.executionSnapshot() ?? null,
      coverage: selected.length > 5 ? "partial" : "exhausted",
      nextAfter: selected.length > 5 ? (records.at(-1)?.id ?? null) : null,
    };
    // The live preview is bounded independently; full original text has continuation offsets.
    if (result.snapshot) {
      const chars = Array.from(result.snapshot.text);
      result.snapshot.textOffset += Math.max(0, chars.length - 1000);
      result.snapshot.text = chars.slice(-1000).join("");
    }
    while (Buffer.byteLength(JSON.stringify(result)) > 10000) {
      const longest = records.reduce((a, b) => (a.text.length > b.text.length ? a : b));
      if (!longest.text)
        throw new ChatRequestError("Run history metadata exceeds the response bound.", 413);
      longest.text = Array.from(longest.text)
        .slice(0, Math.floor(Array.from(longest.text).length / 2))
        .join("");
      longest.nextTextOffset = offset + Array.from(longest.text).length;
      longest.truncated = true;
    }
    return result;
  }

  async threadHistory(botId: string, input: unknown) {
    return this.store.threads.history(botId, input);
  }

  async resetThread(botId: string, value: unknown) {
    const input = chatInput(value, []);
    await this.threadDetail(botId);
    if (this.stopped) throw new Error("Host is stopped");
    return this.store.threads.reset(botId, input.requestId as string);
  }

  async sendThread(
    botId: string,
    value: unknown,
    mode: "message" | "new-task" = "message",
    taskId?: string,
  ) {
    const input = chatInput(value, ["text"]);
    await this.threadDetail(botId);
    if (this.stopped) throw new Error("Host is stopped");
    const admitted = this.store.threads.send(
      {
        requestId: input.requestId as string,
        botId,
        text: input.text as string,
        newTask: mode === "new-task",
        ...(taskId ? { taskId } : {}),
        ...(input.selectedMessageIds ? { selectedMessageIds: input.selectedMessageIds } : {}),
      },
      this.timestamp(),
    );
    const execution = await this.prepare(
      this.store.route(this.store.threads.session(admitted.runId)),
    );
    this.syncChat(execution);
    this.schedule();
    return admitted;
  }

  async stopRun(botId: string, runId: string, value: unknown) {
    const input = chatInput(value, []);
    await this.threadDetail(botId);
    if (this.stopped) throw new Error("Host is stopped");
    const admitted = this.store.threads.stop(
      botId,
      runId,
      input.requestId as string,
      this.timestamp(),
    );
    await this.beginStop(admitted.runId);
    const run = this.store.threads.run(admitted.runId);
    return { ...admitted, state: run.state, stopError: run.stop_error };
  }

  async stopTask(botId: string, taskId: string, value: unknown) {
    const input = chatInput(value, []);
    await this.threadDetail(botId);
    if (this.stopped) throw new Error("Host is stopped");
    const admitted = this.store.threads.stopTask(
      botId,
      taskId,
      input.requestId as string,
      this.timestamp(),
    );
    await this.beginStop(admitted.runId);
    const run = this.store.threads.run(admitted.runId);
    return { ...admitted, state: run.state, stopError: run.stop_error };
  }

  async retryRun(botId: string, runId: string, value: unknown) {
    const input = chatInput(value, []);
    await this.threadDetail(botId);
    if (this.stopped) throw new Error("Host is stopped");
    await this.ensureStopped(botId, runId);
    const admitted = this.store.threads.retry(
      botId,
      runId,
      input.requestId as string,
      this.timestamp(),
    );
    const execution = await this.prepare(
      this.store.route(this.store.threads.session(admitted.runId)),
    );
    this.syncChat(execution);
    this.schedule();
    return admitted;
  }

  async closeRun(botId: string, runId: string, value: unknown) {
    const input = chatInput(value, []);
    await this.threadDetail(botId);
    if (this.stopped) throw new Error("Host is stopped");
    await this.ensureStopped(botId, runId);
    return this.store.threads.close(botId, runId, input.requestId as string, this.timestamp());
  }

  private async beginStop(runId: string): Promise<void> {
    const execution = await this.prepare(this.store.route(this.store.threads.session(runId)));
    void this.executeStop(execution);
  }

  private async ensureStopped(botId: string, runId: string): Promise<void> {
    const current = this.store.threads.ownedRun(botId, runId);
    if (!["queued", "active", "stopping"].includes(current.state)) return;
    this.store.threads.markStopping(current, this.timestamp());
    const execution = await this.prepare(this.store.route(this.store.threads.session(runId)));
    await this.executeStop(execution);
    if (this.store.threads.run(runId).state === "stopping")
      throw new ChatRequestError("Stop is unconfirmed.", 409);
  }

  private executeStop(execution: SessionExecution): Promise<void> {
    const id = execution.route.session.id;
    const current = this.stopJobs.get(id);
    if (current) return current;
    const job = (async () => {
      await execution.starting;
      await execution.replacing;
      if (this.store.threads.run(id).state !== "stopping") return;
      execution.cutover = undefined;
      const handle = execution.handle;
      if (!handle) {
        this.finishConfirmedStop(execution);
        return;
      }
      execution.superseded.add(handle);
      try {
        await handle.stop();
        if (execution.handle === handle) execution.handle = undefined;
        this.finishConfirmedStop(execution);
      } catch {
        execution.superseded.delete(handle);
        this.store.threads.markStopUnconfirmed(
          id,
          "Execution stop unconfirmed; Bot capacity retained",
          this.timestamp(),
        );
        this.emit({
          type: "failure",
          sessionId: id,
          error: "Execution stop unconfirmed; Bot capacity retained",
        });
      }
    })().catch(() => {
      this.emit({ type: "failure", sessionId: id, error: "Run stop failed" });
    });
    const tracked = job.finally(() => {
      if (this.stopJobs.get(id) === tracked) this.stopJobs.delete(id);
    });
    this.stopJobs.set(id, tracked);
    return tracked;
  }

  /** Confirmed termination settles the business outcome and releases serial capacity. */
  private finishConfirmedStop(execution: SessionExecution): void {
    const id = execution.route.session.id;
    execution.mailbox.syncAcknowledgements();
    this.syncChat(execution);
    this.store.threads.finishStop(id, execution.mailbox.acknowledgements(), this.timestamp());
    this.releaseBot(execution);
  }

  /** Recovery backoff is not execution. The driver observes wall-clock process_after. */
  private executionReady(execution: SessionExecution): boolean {
    const pending = execution.mailbox.inputs().filter((input) => input.status === "pending");
    if (pending.length === 0) return true;
    const now = new Date().toISOString();
    return pending.some((input) => !input.process_after || input.process_after <= now);
  }

  /** Keep a not-yet-due queued Run out of the active set so other runnable work can start. */
  private refreshAdmission(execution: SessionExecution): void {
    if (this.storeClosed || execution.route.session.purpose !== "run") return;
    const id = execution.route.session.id;
    if (this.store.threads.run(id).state !== "queued") return;
    const ready = this.executionReady(execution) && this.store.containerStatusOf(id) !== "failed";
    this.store.threads.setRunnable(id, ready);
    if (!ready) this.store.threads.clearReservation(id);
  }

  /** Fill free execution slots from the durable queue without interrupting an active Attempt. */
  private schedule(): void {
    if (this.stopped || this.storeClosed) return;
    const limit = this.store.threads.activeLimit();
    for (;;) {
      const runId = this.store.threads.reserveNext(limit, this.timestamp());
      if (!runId) return;
      const session = this.store.threads.session(runId);
      void this.prepare(this.store.route(session))
        .then((execution) => {
          this.wake(execution);
        })
        .catch(() => {
          if (!this.stopped) this.emit({ type: "failure", error: "Session mailbox unavailable" });
        });
    }
  }

  private syncChat(execution: SessionExecution): void {
    const { mailbox, route } = execution;
    if (route.session.purpose !== "run") return;
    const id = route.session.id;
    const inputs = mailbox.inputs();
    this.store.threads.reconcile(
      id,
      {
        inputs,
        acknowledgements: mailbox.acknowledgements(),
        outputs: mailbox.outputs(),
        evidence: mailbox.inputEvidence(),
        resultGroups: mailbox.resultGroups(),
        executionLost: !execution.handle && !execution.starting && !execution.replacing,
      },
      this.timestamp(),
    );
    const state = this.store.threads.run(id).state;
    if (state === "stopping") return;
    if (["uncertain", "succeeded", "failed", "closed"].includes(state)) {
      if (state === "uncertain") for (const input of inputs) mailbox.holdInput(input.id);
      if (execution.handle && !execution.replacing) {
        const handle = execution.handle;
        const incarnation = execution.incarnation;
        execution.superseded.add(handle);
        execution.replacing = handle
          .stop()
          .then(() => {
            if (execution.handle === handle) execution.handle = undefined;
            this.releaseBot(execution, incarnation);
          })
          .catch(() => {
            execution.superseded.delete(handle);
            this.emit({
              type: "failure",
              sessionId: id,
              error: "Execution stop unconfirmed; Bot capacity retained",
            });
          })
          .finally(() => {
            execution.replacing = undefined;
          });
      } else if (!execution.handle && !execution.starting && !execution.replacing) {
        this.store.threads.releaseAdmission(id);
        if (!this.stopped) this.schedule();
      }
      return;
    }
    const published = new Set(inputs.map((input) => input.id));
    const limited = this.steeringLimit(execution);
    for (const input of this.store.threads.inputs(id)) {
      if (input.outcome || published.has(input.message_id)) continue;
      if (limited !== undefined && input.rowid > limited) continue;
      const destination = this.store.threads.destination(input.destination_id);
      mailbox.submit({
        id: input.message_id,
        content: input.content,
        channel_type: destination.channel_type,
        platform_id: destination.platform_id,
        thread_id: input.destination_id === "local-client" ? route.session.thread_id : null,
      });
    }
    if (limited !== undefined) this.beginCutover(execution, limited);
  }

  /** Rowid through which the current or recovering Attempt may still consume input. */
  private steeringLimit(execution: SessionExecution): number | undefined {
    const id = execution.route.session.id;
    const saved = this.store.savedConfigurationVersion(execution.route.session.agent_group_id);
    const open = this.store.threads.openAttempt(id);
    const bound = open ?? this.store.threads.latestAttempt(id);
    if (!bound || bound.steerThroughRowid == null || bound.configurationVersion >= saved)
      return undefined;
    if (open) return bound.steerThroughRowid;
    const unfinished = this.store.threads
      .inputs(id)
      .some((input) => input.rowid <= (bound.steerThroughRowid as number) && !input.outcome);
    return unfinished ? bound.steerThroughRowid : undefined;
  }

  /** Saved settings apply only after pre-save steering has an outcome and the old Attempt has stopped. */
  private beginCutover(execution: SessionExecution, throughRowid: number): void {
    if (execution.cutover || execution.replacing || execution.starting || this.stopped) return;
    const waiting = this.store.threads
      .inputs(execution.route.session.id)
      .some((input) => input.rowid <= throughRowid && !input.outcome);
    const acknowledgements = new Map(
      execution.mailbox.acknowledgements().map((ack) => [ack.message_id, ack.status]),
    );
    const busy = execution.mailbox.inputs().some((input) => {
      const status = acknowledgements.get(input.id) ?? input.status;
      return status === "pending" || status === "processing";
    });
    if (waiting || busy) return;
    const pending = this.store.threads
      .inputs(execution.route.session.id)
      .some((input) => input.rowid > throughRowid && !input.outcome);
    if (!pending) return;
    execution.cutover = "pending";
    const handle = execution.handle;
    if (!handle) {
      void this.finishCutover(execution);
      return;
    }
    execution.superseded.add(handle);
    execution.replacing = handle
      .stop()
      .catch(() => {
        execution.cutover = undefined;
        execution.superseded.delete(handle);
        this.emit({
          type: "failure",
          sessionId: execution.route.session.id,
          error: "Configuration cutover could not stop execution",
        });
      })
      .finally(() => {
        execution.replacing = undefined;
      });
  }

  private async finishCutover(execution: SessionExecution): Promise<void> {
    if (execution.cutover !== "pending" || this.stopped) return;
    const state = this.store.threads.run(execution.route.session.id).state;
    if (state !== "queued" && state !== "active") {
      execution.cutover = undefined;
      return;
    }
    execution.cutover = "applying";
    try {
      const session = this.store.threads.session(execution.route.session.id);
      execution.route = this.store.route(session);
      this.syncChat(execution);
      this.wake(execution, { force: true });
    } finally {
      execution.cutover = undefined;
    }
  }

  /**
   * Point a stopped Run's context at the Attempt version captured for this start.
   * This stays synchronous so the runner is launched before wake yields.
   */
  private alignContext(execution: SessionExecution): void {
    if (execution.route.session.purpose !== "run" || execution.handle) return;
    const attempt = this.store.threads.openAttempt(execution.route.session.id);
    if (!attempt) return;
    const snapshot = this.store.configurationSnapshot(
      execution.route.session.agent_group_id,
      attempt.configurationVersion,
    );
    if (snapshot.resources?.skillRevisions)
      new LocalSkills(this.root).materialize(
        execution.route.session.agent_group_id,
        snapshot.resources.skillRevisions,
        execution.material.skillsDirectory,
      );
    replaceSessionContext(execution.material.contextFile, snapshot);
  }

  private releaseBot(execution: SessionExecution, incarnation = execution.incarnation): void {
    if (execution.incarnation !== incarnation) return;
    const { session } = execution.route;
    if (!this.storeClosed && session.purpose === "run") {
      this.store.threads.endAttempt(session.id, this.timestamp());
      this.store.threads.releaseAdmission(session.id);
    }
    if (execution.cutover === "pending" && !this.stopped) void this.finishCutover(execution);
    if (!this.stopped && !this.storeClosed) this.schedule();
  }

  /**
   * A durable wait ends the Attempt only after recorded tool calls have results.
   * An unconfirmed executor stop keeps the Bot slot.
   */
  private reconcileDurableWait(execution: SessionExecution): void {
    if (this.stopped || execution.route.session.purpose !== "run") return;
    const id = execution.route.session.id;
    if (execution.starting || execution.replacing || execution.cutover) return;
    const state = this.store.threads.run(id).state;
    if (state === "waiting" && execution.mailbox.durableResume()) {
      this.store.threads.resumeWait(id, this.timestamp());
      execution.mailbox.clearDurableSignal("durable-resume");
      this.schedule();
      return;
    }
    if (state !== "active") return;
    const reason = execution.mailbox.durableWait();
    if (
      !reason ||
      !toolResultsComplete(
        execution.mailbox.executionRecords(),
        execution.mailbox.activity()?.current_tool ?? null,
      )
    )
      return;
    execution.replacing = (async () => {
      const handle = execution.handle;
      if (handle) {
        execution.superseded.add(handle);
        try {
          await handle.stop();
          if (execution.handle === handle) execution.handle = undefined;
        } catch {
          execution.superseded.delete(handle);
          return;
        }
      }
      if (this.stopped || this.store.threads.run(id).state !== "active") return;
      this.store.threads.beginWait(id, reason, this.timestamp());
      execution.mailbox.clearDurableSignal("durable-wait");
      this.schedule();
    })()
      .catch(() => {
        if (!this.stopped)
          this.emit({ type: "failure", sessionId: id, error: "Durable wait settlement failed" });
      })
      .finally(() => {
        execution.replacing = undefined;
      });
  }

  /** Read-only client projection. Mailbox acknowledgement is not a work outcome. */
  async clientStatus() {
    const sessions = await Promise.all(
      this.store.sessions().map(async (session) => {
        const execution = await this.prepared.get(session.id);
        const inputs = execution?.mailbox.inputs() ?? [];
        const acknowledgements = new Map(
          execution?.mailbox.acknowledgements().map((ack) => [ack.message_id, ack.status]),
        );
        const counts = { pending: 0, processing: 0, acknowledged: 0, failed: 0 };
        for (const input of inputs) {
          const status = acknowledgements.get(input.id) ?? input.status;
          if (status === "completed") counts.acknowledged++;
          else counts[status]++;
        }
        return {
          id: session.id,
          botId: session.agent_group_id,
          destinationId: session.messaging_group_id,
          status: session.status,
          containerStatus: session.container_status,
          lastActive: session.last_active,
          inputs: counts,
        };
      }),
    );
    return { bots: this.store.bots(), sessions };
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

  /** Record the single Telegram owner. The pairing message itself is not Agent input. */
  registerTelegramOwner(platformId: string, instance = "telegram"): void {
    this.store.registerTelegramOwner(platformId, instance);
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
          await Promise.allSettled(this.stopJobs.values());
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
      this.storeClosed = true;
      this.store.close();
      if (clean) await rm(join(this.root, "data", "host.lock"), { recursive: true });
    }
  }
}
