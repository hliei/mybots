import type { TelegramFailureKind, TelegramRequestError } from "./channels/telegram-api.ts";

/** Total platform sends for one question notice, including the first. */
export const QUESTION_NOTICE_ATTEMPTS = 3;

/** Ordinary waits after the first and second failed send. A longer retry-after wins. */
export function questionNoticeWaitMs(attempts: number, retryAfterMs = 0): number | null {
  if (attempts >= QUESTION_NOTICE_ATTEMPTS) return null;
  return Math.max(attempts === 1 ? 5000 : 30000, retryAfterMs);
}

export function conciseQuestion(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  const chars = Array.from(flat);
  if (chars.length <= 240) return flat;
  return `${chars.slice(0, 239).join("")}…`;
}

export function telegramTopicName(name: string, botId: string): string {
  const trimmed = name.trim() || botId;
  return Array.from(trimmed).slice(0, 128).join("");
}

export function questionNoticeText(notice: {
  botName: string;
  botId: string;
  taskId: string;
  runId: string;
  questionId: string;
  summary: string;
  locator: string;
}): string {
  return [
    "Question needs an answer",
    `Bot: ${notice.botName} (${notice.botId})`,
    `Task: ${notice.taskId}`,
    `Run: ${notice.runId}`,
    `Request: ${notice.questionId}`,
    `Local client: ${notice.locator}`,
    notice.summary,
  ].join("\n");
}

export function questionNoticeFailure(error: TelegramRequestError): string {
  if (error.kind === "topic-missing") return "Telegram topic was deleted.";
  if (error.kind === "topic-mode") return "Private topic mode is unavailable.";
  if (error.kind === "authority") return "Telegram chat authority is unavailable.";
  if (error.retryAfterMs)
    return `Telegram asked to wait ${Math.ceil(error.retryAfterMs / 1000)} seconds.`;
  return error.message.slice(0, 300) || "Telegram delivery failed.";
}

export function terminalTopicFailure(kind: TelegramFailureKind): boolean {
  return kind === "topic-missing" || kind === "topic-mode" || kind === "authority";
}
