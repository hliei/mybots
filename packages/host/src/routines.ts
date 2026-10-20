import { ChatRequestError, chatInput } from "./chat.ts";

/** One-shot schedules accept resolved instants, never an unresolved local-time phrase. */
export function routineInput(value: unknown) {
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
  if (/^[+-]/.test(input.timezone as string))
    throw new ChatRequestError("timezone must be a supported IANA timezone.");
  try {
    new Intl.DateTimeFormat("en", { timeZone: input.timezone });
  } catch {
    throw new ChatRequestError("timezone must be a supported IANA timezone.");
  }
  return {
    requestId: input.requestId as string,
    text: input.text as string,
    runAt: new Date(instant).toISOString(),
    timezone: input.timezone as string,
    selectedMessageIds: input.selectedMessageIds ?? [],
  };
}
