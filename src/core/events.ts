export function parsePlatformSource(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(platform-cli:cli-user|platform-telegram:\d+:-?\d+|platform-ws:.+)$/u.test(value) ||
    (value.startsWith("platform-ws:") && !value.slice("platform-ws:".length).trim())
  )
    throw new Error("Invalid platform source.");
  return value;
}

export interface InboundEvent {
  type: "InboundEvent";
  session_id: string;
  source: string;
  content: string;
  timestamp: number;
  retry_count: number;
}

export interface OutboundEvent {
  type: "OutboundEvent";
  session_id: string;
  source: string;
  content: string;
  timestamp: number;
  error: string | null;
  reply_id?: string;
}

export type RuntimeEvent = InboundEvent | OutboundEvent;

export function parseEvent(value: unknown): RuntimeEvent {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid event: expected an object.");
  const data = value as Record<string, unknown>;
  if (data.type !== "InboundEvent" && data.type !== "OutboundEvent")
    throw new Error("Invalid event type.");
  if (typeof data.session_id !== "string" || !data.session_id.trim())
    throw new Error("Invalid event session_id.");
  if (
    typeof data.source !== "string" ||
    !/^(platform-cli:cli-user|platform-telegram:\d+:-?\d+|platform-ws:.+|agent:.+)$/u.test(
      data.source,
    )
  )
    throw new Error("Invalid event source.");
  if (data.source.startsWith("platform-")) parsePlatformSource(data.source);
  if (typeof data.content !== "string") throw new Error("Invalid event content.");
  if (typeof data.timestamp !== "number" || !Number.isFinite(data.timestamp) || data.timestamp < 0)
    throw new Error("Invalid event timestamp: expected Unix seconds.");
  const common = {
    session_id: data.session_id,
    source: data.source,
    content: data.content,
    timestamp: data.timestamp,
  };
  if (data.type === "InboundEvent") {
    if (
      typeof data.retry_count !== "number" ||
      !Number.isSafeInteger(data.retry_count) ||
      data.retry_count < 0
    )
      throw new Error("Invalid event retry_count.");
    return { type: "InboundEvent", ...common, retry_count: data.retry_count };
  }
  if (data.error !== null && typeof data.error !== "string")
    throw new Error("Invalid event error.");
  if (data.reply_id !== undefined && (typeof data.reply_id !== "string" || !data.reply_id.trim()))
    throw new Error("Invalid event reply_id.");
  return {
    type: "OutboundEvent",
    ...common,
    error: data.error,
    ...(typeof data.reply_id === "string" ? { reply_id: data.reply_id } : {}),
  };
}
