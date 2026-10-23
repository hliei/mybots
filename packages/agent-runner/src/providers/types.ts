import type {
  AgentResources,
  ExecutionRecord,
  HistoryOperation,
  RunContext,
  WebConfiguration,
} from "@mybots/mailbox";
export interface QueryInput {
  prompt: string;
  history?: HistoryOperation;
  inputId?: string;
  runContext?: RunContext;
  cwd: string;
  /** Session-local Pi state, separate from the shared Agent workspace. */
  sessionDir: string;
  continuation?: string;
  control?: "reset";
  systemContext?: { instructions?: string; resources?: AgentResources; web?: WebConfiguration };
}

export type ProviderEvent =
  | { type: "evidence"; record: ExecutionRecord }
  | { type: "wait"; reason: string }
  | { type: "recorded"; inputId: string }
  | { type: "init"; continuation: string }
  | { type: "activity" }
  | { type: "tool"; name: string | null; timeoutMs?: number }
  | { type: "assistant-start" }
  | { type: "text"; text: string }
  | { type: "progress"; message: string }
  | { type: "result"; text: string | null; isError?: boolean; error?: string; inputIds?: string[] };

export interface AgentQuery {
  events: AsyncIterable<ProviderEvent>;
  /** Queue one follow-up; false leaves it outside this query for a later query. */
  push(message: string, inputId?: string): boolean;
  /** Close admission without cancelling work already queued. */
  end(): void;
  /** Stop execution and await SDK cleanup. */
  abort(): Promise<void>;
}

export interface AgentProvider {
  query(input: QueryInput): AgentQuery;
}
