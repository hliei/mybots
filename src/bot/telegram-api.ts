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

export interface TelegramUpdate {
  updateId: number;
  userId: string;
  chatId: string;
  text: string;
}

export interface TelegramPollResult {
  updates: TelegramUpdate[];
  nextOffset: number;
}

export interface TelegramBotIdentity {
  id: string;
  username?: string;
}

export interface TelegramApi {
  getMe(signal: AbortSignal): Promise<TelegramBotIdentity>;
  getUpdates(offset: number, signal: AbortSignal): Promise<TelegramPollResult>;
  sendMessage(chatId: string, text: string, signal: AbortSignal): Promise<void>;
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
  return { updateId: update.update_id, userId, chatId, text: message.text };
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
      throw new Error(`Telegram ${method} failed: ${description}`);
    }
    return result.result;
  }

  return {
    async getMe(signal) {
      const result = record(await call("getMe", {}, signal));
      const id = digits(result?.id, false);
      if (!id) throw new Error("Telegram getMe returned an invalid bot identity.");
      return { id, ...(typeof result?.username === "string" ? { username: result.username } : {}) };
    },
    async getUpdates(offset, signal) {
      const result = await call(
        "getUpdates",
        { offset, timeout: pollTimeoutSeconds, allowed_updates: ["message"] },
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
    async sendMessage(chatId, text, signal) {
      await call("sendMessage", { chat_id: chatId, text }, signal);
    },
  };
}
