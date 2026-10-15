import type { AgentResources } from "@mybots/mailbox";
export interface QueryInput {
  prompt: string;
  cwd: string;
  /** Session-local Pi state, separate from the shared Agent workspace. */
  sessionDir: string;
  continuation?: string;
  control?: "reset";
  systemContext?: { instructions?: string; resources?: AgentResources };
}

export type ProviderEvent =
  | { type: "init"; continuation: string }
  | { type: "activity" }
  | { type: "tool"; name: string | null; timeoutMs?: number }
  | { type: "text"; text: string }
  | { type: "progress"; message: string }
  | { type: "result"; text: string | null; isError?: boolean; error?: string };

export interface AgentQuery {
  events: AsyncIterable<ProviderEvent>;
  /** Queue one follow-up; false leaves it outside this query for a later query. */
  push(message: string): boolean;
  /** Close admission without cancelling work already queued. */
  end(): void;
  /** Stop execution and await SDK cleanup. */
  abort(): Promise<void>;
}

export interface AgentProvider {
  query(input: QueryInput): AgentQuery;
}
