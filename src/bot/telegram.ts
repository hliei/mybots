import { setTimeout as delay } from "node:timers/promises";
import type { DeliveryChunk, DeliveryTransport } from "../core/delivery.ts";
import { chunkContent } from "../core/delivery.ts";
import type { EventRuntime, RuntimeResult } from "../core/runtime.ts";
import type { TelegramApi, TelegramPollResult, TelegramUpdate } from "./telegram-api.ts";

/** Telegram's text-message length limit, in Unicode code points. */
export const TELEGRAM_CHUNK_LIMIT = 4096;

export function telegramSource(identity: { userId: string; chatId: string }): string {
  return `platform-telegram:${identity.userId}:${identity.chatId}`;
}

/** Deliver committed replies to the chat encoded in their pending destination. */
export function telegramTransport(api: TelegramApi): DeliveryTransport {
  return {
    platform: "telegram",
    limit: TELEGRAM_CHUNK_LIMIT,
    async send(chunk: DeliveryChunk, signal: AbortSignal): Promise<void> {
      const chatId = /^platform-telegram:\d+:(-?\d+)$/u.exec(chunk.destination)?.[1];
      if (!chatId) throw new Error(`Invalid Telegram reply destination: ${chunk.destination}`);
      await api.sendMessage(chatId, chunk.content, signal);
    },
  };
}

export interface TelegramChannelOptions {
  api: TelegramApi;
  runtime: EventRuntime;
  /** Numeric user IDs as strings; an empty list allows every user. */
  allowedUserIds: string[];
  pollRetryMs?: number;
  onError?: (error: unknown) => void;
}

/**
 * Owns Telegram polling and turns allowed text updates into runtime inputs.
 * Constructing the channel opens no connection; `start` begins polling and
 * `stop` aborts in-flight requests and awaits the polling loop.
 */
export class TelegramChannel {
  private readonly controller = new AbortController();
  private readonly observations = new Set<Promise<void>>();
  private runTask: Promise<void> | undefined;
  private readonly options: TelegramChannelOptions;

  constructor(options: TelegramChannelOptions) {
    this.options = options;
  }

  isAllowed(userId: string): boolean {
    return this.options.allowedUserIds.length === 0 || this.options.allowedUserIds.includes(userId);
  }

  /** Route one normalized update; blocked users resolve to `undefined`. */
  async dispatch(update: TelegramUpdate): Promise<RuntimeResult | undefined> {
    if (this.controller.signal.aborted) throw new Error("Telegram channel is stopping.");
    if (!this.isAllowed(update.userId)) return undefined;
    const result = await this.options.runtime.submit({
      source: telegramSource(update),
      content: update.text,
    });
    const observation = this.deliverObservation(update.chatId, result);
    this.observations.add(observation);
    try {
      await observation;
    } finally {
      this.observations.delete(observation);
    }
    return result;
  }

  /**
   * Command results and turn errors are ephemeral observations, as in the CLI.
   * Generated replies carry a `reply_id` and are owned by durable delivery.
   */
  private async deliverObservation(chatId: string, result: RuntimeResult): Promise<void> {
    this.controller.signal.throwIfAborted();
    if (result.type !== "OutboundEvent" || result.reply_id !== undefined) return;
    const content = result.error !== null ? `Error: ${result.error}` : result.content;
    if (!content) return;
    for (const chunk of chunkContent(content, TELEGRAM_CHUNK_LIMIT)) {
      this.controller.signal.throwIfAborted();
      await this.options.api.sendMessage(chatId, chunk, this.controller.signal);
    }
  }

  start(signal?: AbortSignal): Promise<void> {
    if (this.runTask) throw new Error("Telegram channel is already running.");
    const abort = () => this.controller.abort();
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
    this.runTask = this.poll().finally(() => signal?.removeEventListener("abort", abort));
    return this.runTask;
  }

  async stop(): Promise<void> {
    this.controller.abort();
    await this.runTask?.catch(() => {});
    await Promise.allSettled([...this.observations]);
  }

  private report(error: unknown): void {
    if (this.options.onError) this.options.onError(error);
    else console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  }

  private async poll(): Promise<void> {
    let offset = 0;
    while (!this.controller.signal.aborted) {
      let batch: TelegramPollResult;
      try {
        batch = await this.options.api.getUpdates(offset, this.controller.signal);
      } catch (error) {
        if (this.controller.signal.aborted) break;
        this.report(error);
        try {
          await delay(this.options.pollRetryMs ?? 1000, undefined, {
            signal: this.controller.signal,
          });
        } catch {
          break;
        }
        continue;
      }
      offset = Math.max(offset, batch.nextOffset);
      for (const update of batch.updates) {
        if (this.controller.signal.aborted) break;
        // Submissions stay ordered because the runtime serializes routing and
        // per-session work; polling must not wait for a turn to finish.
        void this.dispatch(update).catch((error: unknown) => this.report(error));
      }
    }
  }
}
