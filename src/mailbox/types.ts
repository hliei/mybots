/** Explicit Agent-owned SDK resource selection; paths resolve inside its shared workspace. */
export interface AgentResources {
  skills?: readonly string[];
  tools?: readonly (
    | "read"
    | "write"
    | "edit"
    | "bash"
    | "grep"
    | "find"
    | "ls"
    | "web_search"
    | "fetch_content"
  )[];
}

/** Explicit, non-secret provider and endpoint selection for one web operation. */
export interface WebSearchConfiguration {
  provider: "brave" | "serpapi";
  /** Complete HTTP(S) search endpoint owned by the selected provider. */
  endpoint: string;
}

/** Non-secret web-tool configuration carried into immutable runner context. */
export interface WebConfiguration {
  search?: WebSearchConfiguration;
  fetch?: boolean;
}

export interface SessionKey {
  agentGroupId: string;
  sessionId: string;
}

export interface Routing {
  channel_type: string;
  platform_id: string;
  thread_id: string | null;
}

export interface InboundMessage extends Routing {
  id: string;
  seq: number;
  kind: "message" | "reset";
  timestamp: string;
  content: string;
  status: "pending" | "completed" | "failed";
  process_after: string | null;
  tries: number;
  trigger: number;
}

export interface OutboundMessage extends Routing {
  id: string;
  seq: number;
  kind: "message" | "error";
  in_reply_to: string;
  timestamp: string;
  content: string;
}

export interface ProcessingAck {
  message_id: string;
  status: "processing" | "completed" | "failed";
  status_changed: string;
}

export interface ContainerState {
  current_tool: string | null;
  tool_declared_timeout_ms: number | null;
  tool_started_at: string | null;
  updated_at: string;
}
