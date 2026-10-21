import type { TelegramFailureKind, TelegramRequestError } from "./channels/telegram-api.ts";

/** Total platform sends for one notice, including the first. */
export const NOTICE_ATTEMPTS = 3;

/** Ordinary waits after the first and second failed send. A longer retry-after wins. */
export function noticeWaitMs(attempts: number, retryAfterMs = 0): number | null {
  if (attempts >= NOTICE_ATTEMPTS) return null;
  return Math.max(attempts === 1 ? 5000 : 30000, retryAfterMs);
}

export function conciseNotice(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  const chars = Array.from(flat);
  if (chars.length <= 240) return flat;
  return `${chars.slice(0, 239).join("")}…`;
}

export function telegramTopicName(name: string, botId: string): string {
  const trimmed = name.trim() || botId;
  return Array.from(trimmed).slice(0, 128).join("");
}

export function noticeText(notice: import("./db/threads.ts").Notice & { botName: string }): string {
  return [
    notice.kind === "question"
      ? "Question needs an answer"
      : notice.kind === "approval"
        ? "Action approval required"
        : notice.kind === "uncertain"
          ? "Outcome uncertain: owner attention required"
          : "Work outcome",
    `Bot: ${notice.botName} (${notice.botId})`,
    ...(notice.routineId ? [`Routine: ${notice.routineId}`] : []),
    `Task: ${notice.taskId}`,
    `Run: ${notice.runId}`,
    ...(notice.priorRunId ? [`Explicit retry of Run: ${notice.priorRunId}`] : []),
    ...(notice.requestId ? [`Request: ${notice.requestId}`] : []),
    `Local client: ${notice.locator}`,
    ...notice.sourceChain.map(
      (source) =>
        `Source Bot: ${source.botId} · Task: ${source.taskId} · Run: ${source.runId} · Delegation: ${source.delegationId} · Local client: ${source.locator}`,
    ),
    notice.summary,
  ].join("\n");
}

export function noticeFailure(error: TelegramRequestError): string {
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
