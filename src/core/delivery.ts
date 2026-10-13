import { setTimeout } from "node:timers/promises";
import type { ConversationHistory, PendingReply } from "./history.ts";

export interface DeliveryChunk {
  sessionId: string;
  replyId: string;
  destination: string;
  content: string;
}

/** Adapters resolve recipients and await cancellation/cleanup before settling sends. */
export interface DeliveryTransport {
  platform: "telegram" | "ws";
  limit: number;
  send(chunk: DeliveryChunk, signal: AbortSignal): Promise<void>;
}

export interface DeliveryOptions {
  transports: DeliveryTransport[];
  random?: () => number;
  /** Controlled clocks must cancel and settle their waits when the signal aborts. */
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

function chunks(content: string, limit: number): string[] {
  if (Array.from(content).length <= limit) return [content];
  const result: string[] = [];
  let current = "";
  for (const paragraph of content.split("\n\n")) {
    const combined = current ? `${current}\n\n${paragraph}` : paragraph;
    if (Array.from(combined).length <= limit) current = combined;
    else {
      if (current) result.push(current);
      const points = Array.from(paragraph);
      if (points.length > limit) {
        for (let index = 0; index < points.length; index += limit)
          result.push(points.slice(index, index + limit).join(""));
        current = "";
      } else current = paragraph;
    }
  }
  if (current) result.push(current);
  return result;
}

export class ReplyDelivery {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly paused = new Set<string>();
  readonly failures: { sessionId: string; replyId?: string; error: unknown }[] = [];
  private readonly history: ConversationHistory;
  private readonly options: DeliveryOptions;
  private readonly signal: AbortSignal;

  constructor(history: ConversationHistory, options: DeliveryOptions, signal: AbortSignal) {
    this.history = history;
    this.options = options;
    this.signal = signal;
    for (const transport of options.transports) {
      if (!Number.isSafeInteger(transport.limit) || transport.limit < 1)
        throw new Error("Invalid delivery chunk limit.");
    }
  }

  schedule(sessionId: string): Promise<void> {
    const task = (this.tails.get(sessionId) ?? Promise.resolve())
      .then(async () => {
        if (this.paused.has(sessionId) || this.signal.aborted) return;
        for (const reply of await this.history.getPendingReplies(sessionId)) {
          if (this.signal.aborted) return;
          const transport = this.options.transports.find((candidate) =>
            reply.destination.startsWith(`platform-${candidate.platform}:`),
          );
          if (!transport) {
            await this.fail(reply, 0, new Error("Reply destination is unavailable."));
            return;
          }
          await this.deliver(reply, transport);
          if (this.paused.has(sessionId)) return;
        }
      })
      .catch((error: unknown) => {
        if (!this.signal.aborted) {
          this.paused.add(sessionId);
          this.failures.push({ sessionId, error });
        }
      });
    this.tails.set(sessionId, task);
    void task.then(() => {
      if (this.tails.get(sessionId) === task) this.tails.delete(sessionId);
    });
    return task;
  }

  private async fail(reply: PendingReply, attempts: number, error: unknown): Promise<void> {
    this.paused.add(reply.sessionId);
    this.failures.push({ sessionId: reply.sessionId, replyId: reply.replyId, error });
    await this.history.failReply(
      reply.sessionId,
      reply.replyId,
      attempts,
      error instanceof Error ? error.message : String(error),
    );
  }

  private async deliver(reply: PendingReply, transport: DeliveryTransport): Promise<void> {
    const parts = chunks(reply.payload, transport.limit);
    if (reply.confirmedChunks > parts.length)
      throw new Error("Saved progress exceeds the delivery chunk count.");
    for (let attempt = 1; attempt <= 5; attempt++) {
      this.signal.throwIfAborted();
      try {
        for (let index = reply.confirmedChunks; index < parts.length; index++) {
          this.signal.throwIfAborted();
          await transport.send({ ...reply, content: parts[index] }, this.signal);
          // Save accepted progress even if shutdown raced with transport completion.
          await this.history.confirmChunks(reply.sessionId, reply.replyId, index + 1);
          reply.confirmedChunks = index + 1;
        }
      } catch (error) {
        if (this.signal.aborted) throw error;
        if (attempt === 5) {
          await this.fail(reply, attempt, error);
          return;
        }
        const base = [5000, 25000, 120000, 600000][attempt - 1];
        const range = base / 5;
        const random = this.options.random ?? Math.random;
        const milliseconds = base + Math.floor(random() * (range * 2 + 1)) - range;
        if (this.options.wait) await this.options.wait(milliseconds, this.signal);
        else await setTimeout(milliseconds, undefined, { signal: this.signal });
        // A failed projection may follow a successful append: reread authoritative progress.
        const saved = (await this.history.getPendingReplies(reply.sessionId)).find(
          (pending) => pending.replyId === reply.replyId,
        );
        if (!saved) return;
        reply.confirmedChunks = saved.confirmedChunks;
        continue;
      }
      await this.history.acknowledgeReply(reply.sessionId, reply.replyId);
      return;
    }
  }
}
