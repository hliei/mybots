import { chunkContent } from "./chunk-content.ts";

/**
 * Telegram Bot API boundary.
 *
 * Only this module knows the Telegram Bot API request/response shapes. The rest
 * of the application passes normalized, string-identified updates and reply
 * destinations. Telegram numeric identifiers are validated as safe integers at
 * the JSON boundary and carried as strings everywhere else, so routing,
 * allowlist checks and delivery never depend on JavaScript numeric precision.
 *
 * API reference: https://core.telegram.org/bots/api
 */

/** Telegram's text-message length limit, in Unicode code points. */
export const TELEGRAM_CHUNK_LIMIT = 4096;

export interface TelegramUpdate {
  updateId: number;
  userId: string;
  chatId: string;
  text: string;
  /** Present when the message belongs to a private-chat topic. */
  threadId?: string;
}

export type TelegramFailureKind = "retryable" | "topic-missing" | "topic-mode" | "authority";

/** Platform rejection. `retryAfterMs` is set only when Telegram states a wait. */
export class TelegramRequestError extends Error {
  readonly kind: TelegramFailureKind;
  readonly retryAfterMs?: number;

  constructor(message: string, kind: TelegramFailureKind, retryAfterMs?: number) {
    super(message);
    this.name = "TelegramRequestError";
    this.kind = kind;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

export interface TelegramPollResult {
  updates: TelegramUpdate[];
  nextOffset: number;
}

export interface TelegramBotIdentity {
  id: string;
  username?: string;
  /** True when BotFather has enabled topics in this bot's private chats. */
  topicsEnabled: boolean;
}

export interface TelegramApi {
  getMe(signal: AbortSignal): Promise<TelegramBotIdentity>;
  getUpdates(offset: number, signal: AbortSignal): Promise<TelegramPollResult>;
  getChat(chatId: string, signal: AbortSignal): Promise<{ isForum: boolean }>;
  createForumTopic(chatId: string, name: string, signal: AbortSignal): Promise<{ topicId: string }>;
  sendMessage(chatId: string, text: string, signal: AbortSignal, topicId?: string): Promise<void>;
}

export interface TelegramApiOptions {
  token: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  pollTimeoutSeconds?: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function digits(value: unknown, signed: boolean): string | undefined {
  const pattern = signed ? /^-?\d+$/u : /^\d+$/u;
  if (typeof value === "string") return pattern.test(value) ? value : undefined;
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    const text = String(value);
    return pattern.test(text) ? text : undefined;
  }
  return undefined;
}

function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Normalize one raw `getUpdates` entry. Non-text messages, bot/channel senders
 * without a user, and malformed identifiers yield `undefined` and are ignored.
 * Telegram user IDs are positive; chat IDs may be negative.
 */
export function normalizeTelegramUpdate(value: unknown): TelegramUpdate | undefined {
  const update = record(value);
  const message = record(update?.message);
  const from = record(message?.from);
  const chat = record(message?.chat);
  if (
    !update ||
    !message ||
    !from ||
    !chat ||
    typeof update.update_id !== "number" ||
    !Number.isSafeInteger(update.update_id) ||
    update.update_id < 0 ||
    typeof message.text !== "string" ||
    !message.text.trim()
  )
    return undefined;
  const userId = digits(from.id, false);
  const chatId = digits(chat.id, true);
  if (userId === undefined || chatId === undefined) return undefined;
  const threadId = digits(message.message_thread_id, false);
  return {
    updateId: update.update_id,
    userId,
    chatId,
    text: message.text,
    ...(threadId !== undefined ? { threadId } : {}),
  };
}

function failureKind(status: number, description: string): TelegramFailureKind {
  if (/message thread not found/iu.test(description)) return "topic-missing";
  if (/not a forum|topics are not enabled|forum topics are disabled|topic mode/iu.test(description))
    return "topic-mode";
  if (
    status === 403 ||
    /blocked|kicked|not enough rights|have no rights|chat not found|can't send messages|need administrator/iu.test(
      description,
    )
  )
    return "authority";
  return "retryable";
}

export function createTelegramApi(options: TelegramApiOptions): TelegramApi {
  if (!options.token.trim()) throw new Error("A Telegram bot token is required.");
  const baseUrl = (options.baseUrl ?? "https://api.telegram.org").replace(/\/+$/u, "");
  const request = options.fetch ?? globalThis.fetch;
  const pollTimeoutSeconds = options.pollTimeoutSeconds ?? 30;

  async function call(
    method: string,
    payload: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await request(`${baseUrl}/bot${options.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? new Error("Telegram request was cancelled.");
      throw new Error(`Telegram ${method} request failed: ${failure(error)}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error(`Telegram ${method} returned an invalid response.`);
    }
    const result = record(body);
    if (!response.ok || result?.ok !== true) {
      const description =
        typeof result?.description === "string" ? result.description : `HTTP ${response.status}`;
      const parameters = record(result?.parameters);
      const stated =
        typeof parameters?.retry_after === "number" && parameters.retry_after > 0
          ? parameters.retry_after
          : undefined;
      const described = /retry after (\d+)/iu.exec(description);
      const seconds = stated ?? (described ? Number(described[1]) : undefined);
      throw new TelegramRequestError(
        `Telegram ${method} failed: ${description}`,
        failureKind(response.status, description),
        seconds !== undefined ? seconds * 1000 : undefined,
      );
    }
    return result.result;
  }

  return {
    async getMe(signal) {
      const result = record(await call("getMe", {}, signal));
      const id = digits(result?.id, false);
      if (!id) throw new Error("Telegram getMe returned an invalid bot identity.");
      return {
        id,
        ...(typeof result?.username === "string" ? { username: result.username } : {}),
        topicsEnabled: result?.has_topics_enabled === true,
      };
    },
    async getUpdates(offset, signal) {
      const result = await call(
        "getUpdates",
        {
          offset,
          timeout: pollTimeoutSeconds,
          allowed_updates: ["message", "callback_query"],
        },
        signal,
      );
      if (!Array.isArray(result))
        throw new Error("Telegram getUpdates returned an invalid response.");
      let nextOffset = offset;
      for (const update of result) {
        const id = record(update)?.update_id;
        if (typeof id === "number" && Number.isSafeInteger(id) && id >= 0)
          nextOffset = Math.max(nextOffset, id + 1);
      }
      return {
        nextOffset,
        updates: result.flatMap((update) => {
          const normalized = normalizeTelegramUpdate(update);
          return normalized ? [normalized] : [];
        }),
      };
    },
    async getChat(chatId, signal) {
      const result = record(await call("getChat", { chat_id: chatId }, signal));
      return { isForum: result?.is_forum === true };
    },
    async createForumTopic(chatId, name, signal) {
      const result = record(await call("createForumTopic", { chat_id: chatId, name }, signal));
      const topicId = digits(result?.message_thread_id, false);
      if (!topicId) throw new Error("Telegram createForumTopic returned an invalid topic.");
      return { topicId };
    },
    async sendMessage(chatId, text, signal, topicId) {
      const payload: Record<string, unknown> = { chat_id: chatId };
      if (topicId !== undefined) {
        if (!/^\d+$/u.test(topicId) || !Number.isSafeInteger(Number(topicId)))
          throw new Error("Telegram topic id is invalid.");
        payload.message_thread_id = Number(topicId);
      }
      for (const chunk of chunkContent(text, TELEGRAM_CHUNK_LIMIT)) {
        signal.throwIfAborted();
        await call("sendMessage", { ...payload, text: chunk }, signal);
      }
    },
  };
}
