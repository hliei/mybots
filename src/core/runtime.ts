import { Agent } from "./agent.ts";

export interface InboundEvent {
  type: "InboundEvent";
  session_id: string;
  source: string;
  content: string;
  timestamp: number;
  retry_count: 0;
}

export interface OutboundEvent {
  type: "OutboundEvent";
  session_id: string;
  source: string;
  content: string;
  timestamp: number;
  error: string | null;
}

export type RuntimeEvent = InboundEvent | OutboundEvent;

/** Source-owned, in-memory execution. Importing or constructing starts no work. */
export class EventRuntime {
  private readonly agents = new Map<string, Agent>();
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly options: { workspace?: string; agent?: string };
  private readonly cancellation = new AbortController();
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(options: { workspace?: string; agent?: string } = {}) {
    this.options = options;
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(event: RuntimeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        process.emitWarning(error instanceof Error ? error : String(error));
      }
    }
  }

  private enqueue<T>(source: string, work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Runtime is closed."));
    const result = (this.queues.get(source) ?? Promise.resolve()).then(() => {
      if (this.closed) throw new Error("Runtime closed before execution.");
      return work();
    });
    this.queues.set(
      source,
      result.then(
        () => {},
        () => {},
      ),
    );
    return result;
  }

  /** Open a fresh session for an unattached source without recording chat. */
  openSource(source: string): Promise<{ sessionId: string; agentId: string; agentName: string }> {
    return this.enqueue(source, async () => {
      const agent = await this.getAgent(source);
      return {
        sessionId: agent.sessionId,
        agentId: agent.definition.id,
        agentName: agent.definition.name,
      };
    });
  }

  submit(source: string, content: string, signal?: AbortSignal): Promise<OutboundEvent> {
    const timestamp = Date.now() / 1000;
    return this.enqueue(source, () => this.execute(source, content, timestamp, signal));
  }

  /** Stop intake and queued execution, then cancel overdue running work and await cleanup. */
  close(graceMs = 1000): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const timer = setTimeout(() => this.cancellation.abort(), graceMs);
    this.closing = Promise.all(this.queues.values())
      .then(() => {})
      .finally(() => {
        clearTimeout(timer);
        this.listeners.clear();
        this.agents.clear();
        this.queues.clear();
      });
    return this.closing;
  }

  private async getAgent(source: string): Promise<Agent> {
    let agent = this.agents.get(source);
    if (!agent) {
      agent = await Agent.open(this.options);
      this.agents.set(source, agent);
    }
    return agent;
  }

  private async execute(
    source: string,
    content: string,
    timestamp: number,
    signal?: AbortSignal,
  ): Promise<OutboundEvent> {
    const agent = await this.getAgent(source);
    const turnSignal = signal
      ? AbortSignal.any([signal, this.cancellation.signal])
      : this.cancellation.signal;
    this.publish({
      type: "InboundEvent",
      session_id: agent.sessionId,
      source,
      content,
      timestamp,
      retry_count: 0,
    });
    let result: string;
    let error: string | null = null;
    try {
      turnSignal.throwIfAborted();
      result =
        (await agent.runCommand(content, turnSignal, () => this.agents.delete(source))) ??
        (await agent.chat(content, turnSignal));
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
      result = `Error: ${error}`;
    }
    const event: OutboundEvent = {
      type: "OutboundEvent",
      session_id: agent.sessionId,
      source: `agent:${agent.definition.id}`,
      content: result,
      timestamp: Date.now() / 1000,
      error,
    };
    this.publish(event);
    return event;
  }
}
