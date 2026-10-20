/** Explicit Agent-owned SDK resource selection; paths resolve inside its shared workspace. */
export interface AgentResources {
  skills?: readonly string[];
  /** Owner-selected immutable content revisions, loaded from protected session material. */
  skillRevisions?: Readonly<Record<string, string>>;
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

/** Immutable context selected for an independent Run, separate from its live inputs. */
export interface RunContext {
  sourceMessageId: string;
  backgroundBoundary: number;
  references: { id: string; role: string; content: string }[];
  answers?: { id: string; question: string; answer: string }[];
}

/** Stable product evidence, excluding hidden reasoning and provider-only payloads. */
export interface ExecutionRecord {
  id: string;
  kind: "input" | "assistant" | "tool-call" | "tool-result" | "attempt";
  text: string;
  createdAt: string;
  toolName?: string;
  toolCallId?: string;
  inputId?: string;
  incarnation?: number;
}
export interface ExecutionSnapshot {
  id: string;
  textOffset: number;
  text: string;
  tool: string | null;
  incarnation: number;
}
export interface HistoryRequest {
  id: string;
  incarnation: number;
  operation: string;
  input: unknown;
}
export type HistoryOperation = (
  operation:
    | "search_history"
    | "read_history"
    | "create_routine"
    | "ask_question"
    | "publish_progress"
    | "publish_result"
    | "read_operation",
  input: unknown,
  signal?: AbortSignal,
) => Promise<unknown>;
