import { WorkspaceConfiguration } from "../config/reload.ts";
import { Agent } from "./agent.ts";
import type { DeliveryOptions } from "./delivery.ts";
import { ReplyDelivery } from "./delivery.ts";
import type { InboundEvent, OutboundEvent, RuntimeEvent } from "./events.ts";
import { parseEvent } from "./events.ts";
import { ConversationHistory, type PendingReply } from "./history.ts";

type Subscriber = (event: RuntimeEvent, signal: AbortSignal) => Promise<void>;

export interface RuntimeSession {
  session_id: string;
  agent_id: string;
  agent_name: string;
}

export type RuntimeResult =
  | OutboundEvent
  | { type: "CancelledTurn"; session_id: string; content: "" };

export class EventRuntime {
  private routing: Promise<void> = Promise.resolve();
  private readonly agents = new Map<string, Agent>();
  private readonly opening = new Map<string, Promise<Agent>>();
  private readonly sessions = new Map<string, Promise<unknown>>();
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly subscribers = new Map<Subscriber, Map<string, Promise<void>>>();
  private readonly controller = new AbortController();
  private stopping = false;
  private stopTask: Promise<void> | undefined;
  private readonly configuration: WorkspaceConfiguration;
  private readonly history: ConversationHistory;
  private readonly delivery: ReplyDelivery | undefined;
  readonly subscriberFailures: { event: RuntimeEvent; error: unknown }[] = [];

  private constructor(
    configuration: WorkspaceConfiguration,
    history: ConversationHistory,
    delivery?: DeliveryOptions,
  ) {
    this.configuration = configuration;
    this.history = history;
    if (delivery) this.delivery = new ReplyDelivery(history, delivery, this.controller.signal);
  }

  subscribe(handler: Subscriber): () => void {
    if (this.stopping) throw new Error("Runtime is stopping.");
    this.subscribers.set(handler, new Map());
    return () => this.subscribers.delete(handler);
  }

  private publish(event: RuntimeEvent): void {
    for (const [handler, tails] of this.subscribers) {
      const task = this.track(
        (tails.get(event.session_id) ?? Promise.resolve())
          .then(async () => {
            if (!this.controller.signal.aborted)
              await handler(structuredClone(event), this.controller.signal);
          })
          .catch((error: unknown) => {
            if (!this.controller.signal.aborted || error !== this.controller.signal.reason)
              this.subscriberFailures.push({ event, error });
          }),
      );
      tails.set(event.session_id, task);
    }
  }

  getPendingReplies(sessionId: string): Promise<PendingReply[]> {
    return this.history.getPendingReplies(sessionId);
  }

  acknowledgeReply(sessionId: string, replyId: string): Promise<void> {
    return this.track(this.history.acknowledgeReply(sessionId, replyId));
  }

  get deliveryFailures() {
    return this.delivery?.failures ?? [];
  }

  private agent(sessionId: string): Agent {
    const agent = this.agents.get(sessionId);
    if (!agent) throw new Error(`Unknown session: ${sessionId}`);
    return agent;
  }

  private track<T>(task: Promise<T>): Promise<T> {
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
    return task;
  }

  static async open(
    options: { workspace?: string; agent?: string; delivery?: DeliveryOptions } = {},
  ): Promise<EventRuntime> {
    const configuration = await WorkspaceConfiguration.open(
      options.workspace ?? "../default_workspace",
      options.agent,
    );
    const config = configuration.activeConfig;
    const history = await ConversationHistory.open(config.history_path, {
      eventPath: config.event_path,
    });
    const runtime = new EventRuntime(configuration, history, options.delivery);
    if (runtime.delivery) {
      const sessions = new Set([
        ...(await history.listSessions()).map((session) => session.id),
        ...Object.values(config.sources).map((binding) => binding.session_id),
      ]);
      for (const sessionId of sessions) runtime.track(runtime.delivery.schedule(sessionId));
    }
    configuration.startWatching();
    return runtime;
  }

  async openSession(options: { agent?: string; sessionId?: string } = {}): Promise<RuntimeSession> {
    if (this.stopping) throw new Error("Runtime is stopping.");
    return this.loadSession({ ...options, source: "platform-cli:cli-user" });
  }

  private async loadSession(options: {
    agent?: string;
    sessionId?: string;
    source?: string;
  }): Promise<RuntimeSession> {
    const existing = options.sessionId ? this.agents.get(options.sessionId) : undefined;
    let opening = options.sessionId ? this.opening.get(options.sessionId) : undefined;
    if (!opening) {
      opening = existing
        ? Promise.resolve(existing)
        : Agent.open({ configuration: this.configuration, ...options });
      if (options.sessionId) this.opening.set(options.sessionId, opening);
    }
    return this.track(
      (async () => {
        let agent: Agent;
        try {
          agent = await opening;
        } finally {
          if (options.sessionId) this.opening.delete(options.sessionId);
        }
        if (options.agent && options.agent !== agent.definition.id)
          throw new Error("Session Agent does not match the requested Agent.");
        this.agents.set(agent.sessionId, agent);
        return {
          session_id: agent.sessionId,
          agent_id: agent.definition.id,
          agent_name: agent.definition.name,
        };
      })(),
    );
  }

  async submit(value: unknown): Promise<RuntimeResult> {
    if (this.stopping) throw new Error("Runtime is stopping.");
    if (value && typeof value === "object" && !("type" in value)) {
      const data = value as Record<string, unknown>;
      const input = parseEvent({
        type: "InboundEvent",
        session_id: "routing",
        source: data.source,
        content: data.content,
        timestamp: Date.now() / 1000,
        retry_count: 0,
      }) as InboundEvent;
      if (!/^platform-(telegram|ws):/u.test(input.source))
        throw new Error("Invalid routing source: expected Telegram or WebSocket.");
      if (
        data.agent_id !== undefined &&
        (typeof data.agent_id !== "string" || !data.agent_id.trim())
      )
        throw new Error("Invalid Agent selection.");
      if (data.agent_id !== undefined && !input.source.startsWith("platform-ws:"))
        throw new Error("Agent selection is only supported for WebSocket sources.");
      const selection = data.agent_id as string | undefined;
      const routed = this.routing.then(async () => {
        await this.configuration.reload();
        const binding = this.configuration.activeConfig.sources[input.source];
        const session = await this.loadSession({
          ...(binding ? { sessionId: binding.session_id } : { source: input.source }),
          agent: selection,
        });
        const agent = this.agent(session.session_id);
        if (agent.source !== undefined && agent.source !== input.source)
          throw new Error("Session source does not match the requested source.");
        const sources = this.configuration.activeConfig.sources;
        if (
          Object.entries(sources).some(
            ([source, entry]) => source !== input.source && entry.session_id === session.session_id,
          )
        )
          throw new Error("Session is already bound to another source.");
        if (!binding)
          await this.configuration.updateRuntime({
            sources: { [input.source]: { session_id: session.session_id } },
          });
        return { result: this.enqueue({ ...input, session_id: session.session_id }) };
      });
      this.routing = routed.then(
        () => {},
        () => {},
      );
      return this.track(routed.then(({ result }) => result));
    }
    const event = parseEvent(value);
    if (event.type !== "InboundEvent")
      throw new Error("Invalid submission: expected InboundEvent.");
    if (!event.source.startsWith("platform-"))
      throw new Error("Invalid submission: expected a platform source.");
    const agent = this.agent(event.session_id);
    if (agent.source !== undefined && agent.source !== event.source)
      throw new Error("Session source does not match the requested source.");
    const sources = this.configuration.activeConfig.sources;
    if (
      agent.source === undefined &&
      event.source !== "platform-cli:cli-user" &&
      sources[event.source]?.session_id !== event.session_id
    )
      throw new Error("External input to a legacy session requires a source-to-session binding.");
    if (
      Object.entries(sources).some(
        ([source, binding]) => binding.session_id === event.session_id && source !== event.source,
      ) ||
      (sources[event.source] && sources[event.source].session_id !== event.session_id)
    )
      throw new Error("Submission conflicts with the source-to-session binding.");
    return this.enqueue(event);
  }

  private enqueue(event: InboundEvent): Promise<RuntimeResult> {
    this.publish(event);
    const result = this.track(
      (this.sessions.get(event.session_id) ?? Promise.resolve()).then(() => this.execute(event)),
    );
    this.sessions.set(
      event.session_id,
      result.catch(() => {}),
    );
    return result;
  }

  private async execute(event: InboundEvent): Promise<RuntimeResult> {
    const agent = this.agent(event.session_id);
    const signal = this.controller.signal;
    const cancelled = {
      type: "CancelledTurn" as const,
      session_id: event.session_id,
      content: "" as const,
    };
    if (signal.aborted) return cancelled;
    let content = "";
    let error: string | null = null;
    let replyId: string | undefined;
    try {
      const command = await agent.runCommand(event.content, signal);
      if (signal.aborted) return cancelled;
      if (command !== undefined) content = command;
      else {
        content = await agent.chat(event.content, signal, event.source);
        replyId = (await agent.getPendingReplies()).at(-1)?.replyId;
      }
    } catch (cause) {
      if (signal.aborted) return cancelled;
      error = cause instanceof Error ? cause.message : String(cause);
    }
    const outbound: OutboundEvent = {
      type: "OutboundEvent",
      session_id: event.session_id,
      source: `agent:${agent.definition.id}`,
      content,
      timestamp: Date.now() / 1000,
      error,
      ...(replyId ? { reply_id: replyId } : {}),
    };
    this.publish(parseEvent(outbound));
    if (this.delivery) this.track(this.delivery.schedule(event.session_id));
    return outbound;
  }

  stop(options: { graceMs?: number } = {}): Promise<void> {
    const graceMs = options.graceMs ?? 1000;
    if (!Number.isFinite(graceMs) || graceMs < 0) throw new Error("Invalid shutdown grace period.");
    this.stopping = true;
    if (graceMs === 0) this.controller.abort();
    this.stopTask ??= this.finishStop(graceMs);
    return this.stopTask;
  }

  private async finishStop(graceMs: number): Promise<void> {
    const timer = setTimeout(() => this.controller.abort(), graceMs);
    try {
      while (this.tasks.size) await Promise.allSettled([...this.tasks]);
    } finally {
      clearTimeout(timer);
    }
    await Promise.all([...this.agents.values()].map((agent) => agent.close()));
    await this.configuration.stop();
    this.subscribers.clear();
  }
}
