import type { RuntimeEvent } from "../core/events.ts";

/** A validated WebSocket input frame before the platform source namespace is added. */
export interface WebSocketInput {
  source: string;
  content: string;
  agent_id?: string;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Validate a client text frame: a JSON object with a nonempty `source` and
 * `content` and an optional nonempty `agent_id`. Unknown fields are ignored,
 * matching the permissive event input contract.
 */
export function parseWebSocketInput(raw: string): WebSocketInput {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Input must be valid JSON.");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Input must be a JSON object.");
  const data = value as Record<string, unknown>;
  if (typeof data.source !== "string" || !data.source.trim())
    throw new Error("Input source must be a nonempty string.");
  if (typeof data.content !== "string" || data.content.length === 0)
    throw new Error("Input content must be a nonempty string.");
  let agentId: string | undefined;
  if (data.agent_id !== undefined && data.agent_id !== null) {
    if (typeof data.agent_id !== "string" || !data.agent_id.trim())
      throw new Error("Input agent_id must be a nonempty string.");
    agentId = data.agent_id;
  }
  return {
    source: data.source,
    content: data.content,
    ...(agentId !== undefined ? { agent_id: agentId } : {}),
  };
}

/** The session identity of a WebSocket client identifier. */
export function websocketSource(source: string): string {
  return `platform-ws:${source}`;
}

/** Serialize an inbound/outbound event as an inbound/outbound envelope. */
export function serializeEvent(event: RuntimeEvent): string {
  return JSON.stringify(event);
}

/** Serialize a client-visible error for the originating connection. */
export function serializeError(message: string): string {
  return JSON.stringify({ type: "error", message });
}
