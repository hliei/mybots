import { CronExpressionParser } from "cron-parser";
import { ChatRequestError, chatInput } from "./chat.ts";

export function nextCron(cron: string, timezone: string, now: string): string {
  if (cron.split(/\s+/).length !== 5 || /[?@]|\bH\b/i.test(cron))
    throw new ChatRequestError("cron must contain five fields without aliases, hashes or seconds.");
  try {
    return CronExpressionParser.parse(cron, { tz: timezone, currentDate: now })
      .next()
      .toDate()
      .toISOString();
  } catch {
    throw new ChatRequestError("cron must be valid and have a future occurrence.");
  }
}

/** Accept resolved one-shot instants or five-field cron in the owning Bot's timezone. */
export function routineInput(value: unknown, now: string, timezone = "Asia/Shanghai") {
  if (value && typeof value === "object" && "cron" in value) {
    const input = chatInput(value, ["text", "cron"]);
    return {
      requestId: input.requestId as string,
      text: input.text as string,
      cron: input.cron as string | null,
      runAt: nextCron(input.cron as string, timezone, now),
      timezone,
      selectedMessageIds: input.selectedMessageIds ?? [],
    };
  }
  const input = chatInput(value, ["text", "runAt", "timezone"]);
  const instant = input.runAt as string;
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(instant) ||
    !Number.isFinite(Date.parse(instant))
  )
    throw new ChatRequestError("runAt must be an absolute ISO 8601 instant with an offset.");
  const day = instant.slice(0, 10);
  if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day)
    throw new ChatRequestError("runAt contains an invalid calendar date.");
  validTimezone(input.timezone as string);
  return {
    requestId: input.requestId as string,
    text: input.text as string,
    runAt: new Date(instant).toISOString(),
    cron: null as string | null,
    timezone: input.timezone as string,
    selectedMessageIds: input.selectedMessageIds ?? [],
  };
}

export function validTimezone(timezone: string): void {
  if (/^[+-]/.test(timezone))
    throw new ChatRequestError("timezone must be a supported IANA timezone.");
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    throw new ChatRequestError("timezone must be a supported IANA timezone.");
  }
}
