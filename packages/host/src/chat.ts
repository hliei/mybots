export class ChatRequestError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Validate the entire owner operation; execution settings cannot be overridden here. */
export function chatInput(value: unknown, fields: readonly string[]): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ChatRequestError("A chat operation requires a JSON object.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["requestId", ...fields].includes(key)))
    throw new ChatRequestError("Unsupported chat operation field.");
  if (typeof input.requestId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.requestId))
    throw new ChatRequestError(
      "A stable requestId is required (up to 128 letters, digits, underscores or hyphens).",
    );
  const result: Record<string, string> = { requestId: input.requestId };
  for (const field of fields) {
    const text = input[field];
    const limit = field === "text" ? 32000 : 120;
    if (typeof text !== "string" || !text.trim() || text.length > limit)
      throw new ChatRequestError(`${field} is required (up to ${limit} characters).`);
    result[field] = field === "text" ? text : text.trim();
  }
  return result;
}
