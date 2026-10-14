export interface QueryInput {
  prompt: string;
  cwd: string;
  /** Session-local Pi state, separate from the shared Agent workspace. */
  sessionDir: string;
  continuation?: string;
  systemContext?: { instructions?: string };
}

export type ProviderEvent =
  | { type: "init"; continuation: string }
  | { type: "activity" }
  | { type: "text"; text: string }
  | { type: "progress"; message: string }
  | { type: "result"; text: string | null; isError?: boolean; error?: string };

export interface AgentQuery {
  events: AsyncIterable<ProviderEvent>;
  /** Stop execution and await SDK cleanup. */
  abort(): Promise<void>;
}

export interface AgentProvider {
  query(input: QueryInput): AgentQuery;
}
