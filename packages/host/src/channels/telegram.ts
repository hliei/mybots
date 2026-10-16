import { setTimeout as delay } from "node:timers/promises";
import type { OutboundMessage } from "@mybots/mailbox";
import type { Host } from "../host.ts";
import { chunkContent } from "./chunk-content.ts";
import {
  TELEGRAM_CHUNK_LIMIT,
  type TelegramApi,
  type TelegramPollResult,
  type TelegramUpdate,
} from "./telegram-api.ts";
import { completePairing, takePairingAttempt } from "./telegram-pairing.ts";

export interface TelegramDestination {
  id: string;
  platformId: string;
}

export interface TelegramChannelOptions {
  host: Host;
  api: TelegramApi;
  /** Messaging-group instance served by this channel. */
  instance: string;
  /** Configured Telegram private-chat destinations, keyed by chat ID. */
  destinations: TelegramDestination[];
  /** Namespaced owner identities; only `telegram:<user>` senders are admitted. */
  owners: string[];
  /** Install root holding the in-progress pairing file. Absent disables pairing. */
  pairingRoot?: string;
  /** Persist the paired owner. The code-bearing message is not Agent input. */
  registerOwner?: (platformId: string) => void;
  pollRetryMs?: number;
  onError?: (error: unknown) => void;
}

/**
 * Owner-only Telegram private-chat channel for the persistent host.
 *
 * Construction attaches host delivery for the channel instance; `start` owns
 * Bot API polling and `stop` aborts in-flight requests and awaits dispatches.
 * Updates are normalized at the Bot API boundary; unknown senders, non-private
 * chats and unconfigured chats are ignored without reaching host work.
 */
export class TelegramChannel {
  private readonly controller = new AbortController();
  private readonly destinations: Map<string, TelegramDestination>;
  private readonly telegramOwners: Set<string>;
  private readonly options: TelegramChannelOptions;
  private detach?: () => void;
  private runTask?: Promise<void>;

  private constructor(options: TelegramChannelOptions) {
    this.options = options;
    this.destinations = new Map(
      options.destinations.map((destination) => [destination.platformId, destination]),
    );
    this.telegramOwners = new Set(
      options.owners
        .filter((owner) => owner.startsWith("telegram:"))
        .map((owner) => owner.slice("telegram:".length)),
    );
    const pairing = !this.destinations.size && !this.telegramOwners.size;
    if (!pairing && (!this.destinations.size || !this.telegramOwners.size))
      throw new Error("Telegram requires a configured private chat and Telegram owner identity");
  }

  /** Admit the single owner after a successful pairing code. */
  admitOwner(platformId: string): void {
    this.destinations.clear();
    this.telegramOwners.clear();
    this.telegramOwners.add(platformId);
    this.destinations.set(platformId, { id: "owner-chat", platformId });
  }

  /** Attach host delivery; opens no Bot API connection until `start`. */
  static listen(options: TelegramChannelOptions): TelegramChannel {
    const channel = new TelegramChannel(options);
    channel.detach = options.host.attachChannel({
      channelType: "telegram",
      instance: options.instance,
      deliver: (message, signal) => channel.deliver(message, signal),
    });
    return channel;
  }

  private channelAbort = () => this.controller.abort();

  start(signal?: AbortSignal): Promise<void> {
    if (this.runTask) throw new Error("Telegram channel is already running.");
    if (signal) {
      if (signal.aborted) this.controller.abort();
      else signal.addEventListener("abort", this.channelAbort, { once: true });
    }
    this.runTask = this.poll().finally(() =>
      signal?.removeEventListener("abort", this.channelAbort),
    );
    return this.runTask;
  }

  /** Stop polling and settle dispatches; safe before `start`. */
  async stop(): Promise<void> {
    this.controller.abort();
    this.detach?.();
    this.detach = undefined;
    await this.runTask?.catch(() => {});
  }

  /** Route one normalized update; unauthorized or unsupported input resolves to `undefined`. */
  async dispatch(
    update: TelegramUpdate,
  ): Promise<{ sessionId: string; messageId: string } | undefined> {
    if (this.controller.signal.aborted) throw new Error("Telegram channel is stopping.");
    if (update.chatId !== update.userId) return undefined;
    if (this.options.pairingRoot && update.text.trim()) {
      const attempt = await takePairingAttempt(this.options.pairingRoot, update.text);
      if (attempt.kind === "matched") {
        this.options.registerOwner?.(update.userId);
        this.admitOwner(update.userId);
        await completePairing(this.options.pairingRoot);
        await this.options.api.sendMessage(
          update.chatId,
          "Pairing success!",
          this.controller.signal,
        );
        return undefined;
      }
      if (attempt.kind === "replaced" || attempt.kind === "exhausted") return undefined;
    }
    if (!this.telegramOwners.has(update.userId)) return undefined;
    // Telegram private chats expose the peer user ID as the chat ID; groups are out of scope.
    if (update.chatId !== update.userId) return undefined;
    const destination = this.destinations.get(update.chatId);
    if (!destination) return undefined;
    return await this.options.host.accept({
      destinationId: destination.id,
      userId: `telegram:${update.userId}`,
      text: update.text,
    });
  }

  private async deliver(message: OutboundMessage, signal: AbortSignal): Promise<void> {
    if (message.channel_type !== "telegram") throw new Error("Telegram delivery requires Telegram");
    if (!this.destinations.has(message.platform_id))
      throw new Error("Telegram delivery requires a configured private chat");
    const text = message.kind === "error" ? `Error: ${message.content}` : message.content;
    for (const chunk of chunkContent(text, TELEGRAM_CHUNK_LIMIT)) {
      signal.throwIfAborted();
      await this.options.api.sendMessage(message.platform_id, chunk, signal);
    }
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
        // Persisting each accepted input before polling again preserves reception order
        // without waiting for the Agent turn to finish.
        try {
          await this.dispatch(update);
        } catch (error) {
          if (!this.controller.signal.aborted) this.report(error);
        }
      }
    }
  }
}
