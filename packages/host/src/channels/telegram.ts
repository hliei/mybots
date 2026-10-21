import { setTimeout as delay } from "node:timers/promises";
import type { Host } from "../host.ts";
import type { TelegramApi, TelegramPollResult, TelegramUpdate } from "./telegram-api.ts";
import { markPairingCompleted, takePairingAttempt } from "./telegram-pairing.ts";

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
 * Owner-only Telegram private-chat channel for question notices.
 *
 * One account and one private chat receive per-Bot topic notices. Polling still
 * advances the update offset, but topic messages, free text and callbacks do
 * not admit chat or owner decisions. Pairing remains the only accepted private
 * message, and it is not Agent input. `start` owns Bot API polling and `stop`
 * aborts in-flight requests.
 */
export class TelegramChannel {
  private readonly controller = new AbortController();
  private readonly destinations: Map<string, TelegramDestination>;
  private readonly telegramOwners: Set<string>;
  private readonly options: TelegramChannelOptions;
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
    this.options.host.attachTelegramNotices(this.options.api, platformId);
  }

  /** Attach question-notice delivery; opens no Bot API connection until `start`. */
  static listen(options: TelegramChannelOptions): TelegramChannel {
    const channel = new TelegramChannel(options);
    const chat =
      options.destinations.find((destination) => destination.id === "owner-chat") ??
      (options.destinations.length === 1 ? options.destinations[0] : undefined);
    if (chat) options.host.attachTelegramNotices(options.api, chat.platformId);
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
    await this.runTask?.catch(() => {});
  }

  /**
   * Consume one normalized update. Topic messages, callbacks and ordinary text
   * never become Thread input or owner decisions. A pairing code in the private
   * chat root is the only message that changes Host state.
   */
  async dispatch(update: TelegramUpdate): Promise<undefined> {
    if (this.controller.signal.aborted) throw new Error("Telegram channel is stopping.");
    if (update.threadId || update.chatId !== update.userId) return undefined;
    if (this.options.pairingRoot && update.text.trim()) {
      const attempt = await takePairingAttempt(this.options.pairingRoot, update.text);
      if (attempt.kind === "matched") {
        this.options.registerOwner?.(update.userId);
        this.admitOwner(update.userId);
        await markPairingCompleted(this.options.pairingRoot, update.userId);
        await this.options.api.sendMessage(
          update.chatId,
          "Pairing success!",
          this.controller.signal,
        );
      }
    }
    return undefined;
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
