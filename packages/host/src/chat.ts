export class ChatRequestError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Disabled and deleted Bots keep their identity and reject new admissions. */
export function rejectInactiveBot(availability: string): void {
  if (availability === "active") return;
  throw new ChatRequestError(
    availability === "disabled"
      ? "Bot is disabled. New chat, tasks, retries, Routines, and delegations are not admitted."
      : "Bot is deleted. Its identity remains for inspection and does not admit new work.",
    409,
  );
}

/** Validate the entire owner operation; execution settings cannot be overridden here. */
export function chatInput(
  value: unknown,
  fields: readonly string[],
): Record<string, string> & { selectedMessageIds?: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ChatRequestError("A chat operation requires a JSON object.");
  const input = value as Record<string, unknown>;
  const allowSelection = fields.includes("text");
  if (
    Object.keys(input).some(
      (key) =>
        !["requestId", ...fields, ...(allowSelection ? ["selectedMessageIds"] : [])].includes(key),
    )
  )
    throw new ChatRequestError("Unsupported chat operation field.");
  if (typeof input.requestId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.requestId))
    throw new ChatRequestError(
      "A stable requestId is required (up to 128 letters, digits, underscores or hyphens).",
    );
  const result: Record<string, string> & { selectedMessageIds?: string[] } = {
    requestId: input.requestId,
  };
  for (const field of fields) {
    const text = input[field];
    const limit = field === "text" ? 32000 : 120;
    if (typeof text !== "string" || !text.trim() || text.length > limit)
      throw new ChatRequestError(`${field} is required (up to ${limit} characters).`);
    result[field] = field === "text" ? text : text.trim();
  }
  if (allowSelection && input.selectedMessageIds !== undefined) {
    const ids = input.selectedMessageIds;
    if (
      !Array.isArray(ids) ||
      ids.length > 7 ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => typeof id !== "string" || !/^[a-zA-Z0-9-]{1,128}$/.test(id))
    )
      throw new ChatRequestError("Select at most 7 distinct earlier message ids.");
    if (ids.length) result.selectedMessageIds = ids as string[];
  }
  return result;
}
