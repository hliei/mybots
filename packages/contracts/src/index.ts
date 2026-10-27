export interface BotConfiguration {
  name: string;
  instructions: string;
  model: string;
}

export interface Bot extends BotConfiguration {
  id: string;
  threadId: string;
  conversationId: number;
}

export type ProviderId = "deepseek" | "opencode-go";

export interface ProviderStatus {
  id: ProviderId;
  name: string;
  configured: boolean;
}

export interface ModelChoice {
  id: string;
  name: string;
  available?: boolean;
}

export interface Skill {
  name: string;
  description: string;
  content: string;
  readOnly: boolean;
}

export type MemoryScope = "owner" | "bot";

export interface MemoryDocument {
  content: string;
}

export function markdownContent(value: unknown): string {
  if (typeof value !== "string" || value.length > 16000)
    throw new Error("Markdown must be at most 16000 characters");
  return value;
}

export function skillContent(name: string, value: unknown): Omit<Skill, "readOnly"> {
  if (!/^[a-z][a-z0-9-]{0,79}$/.test(name) || typeof value !== "object" || value === null)
    throw new Error("Invalid Skill");
  const data = value as Record<string, unknown>;
  if (
    typeof data.description !== "string" ||
    !data.description.trim() ||
    data.description.length > 1000
  )
    throw new Error("Skill description is required and must be at most 1000 characters");
  return { name, description: data.description.trim(), content: markdownContent(data.content) };
}

export interface ChatStep {
  callId: string;
  name: string;
  status: "Pending" | "Running" | "Completed" | "Failed" | "Interrupted";
  summary?: string;
  resultId?: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  tools: string[];
  steps?: ChatStep[];
  active?: boolean;
  status?: string;
}

export interface ChatInput {
  id: number;
  requestId: string;
  text: string;
  status: string;
  reason?: string;
  detail?: string;
}

export interface ChatView {
  botId: string;
  threadId: string;
  messages: ChatMessage[];
  inputs: ChatInput[];
  busy: boolean;
  partial?: string;
  activity: string[];
}

export interface HistoryItem {
  id: number;
  role: ChatMessage["role"];
  preview: string;
}

export interface HistoryPage {
  items: HistoryItem[];
  before?: number;
}

export interface HistoryRead {
  id: number;
  role: ChatMessage["role"];
  text: string;
  offset: number;
  nextOffset?: number;
}

export type WorkerCommand =
  | { action: "models" }
  | { action: "providers" }
  | { action: "provider-update"; provider: ProviderId; apiKey?: unknown; remove: boolean }
  | { action: "create"; configuration: BotConfiguration }
  | { action: "configure"; botId: string }
  | { action: "send"; botId: string; text: string; requestId: string }
  | { action: "submission"; botId: string; requestId: string }
  | { action: "stop"; botId: string }
  | { action: "view"; botId: string }
  | { action: "history-search"; botId: string; query: string; before?: number }
  | { action: "history-read"; botId: string; entryId: number; offset: number }
  | { action: "subscribe"; botId: string; subscription: string }
  | { action: "unsubscribe"; subscription: string }
  | { action: "close" };

export type WorkerStatus =
  | { state: "ready" | "recovered" }
  | { state: "recovering"; attempt: number }
  | { state: "failed"; error: string };

export interface WorkerRequest {
  id: number;
  command: WorkerCommand;
}

export type WorkerMessage =
  | { type: "ready" }
  | { type: "startup-error"; error: string }
  | { type: "response"; id: number; value?: unknown; error?: string }
  | { type: "view"; subscription: string; value: ChatView };

export function botConfiguration(value: unknown, models: readonly ModelChoice[]): BotConfiguration {
  if (typeof value !== "object" || value === null) throw new Error("Invalid Bot configuration");
  const data = value as Record<string, unknown>;
  if (
    typeof data.name !== "string" ||
    !data.name.trim() ||
    data.name.length > 100 ||
    typeof data.instructions !== "string" ||
    data.instructions.length > 32000 ||
    typeof data.model !== "string" ||
    !models.some((model) => model.id === data.model)
  )
    throw new Error("Invalid Bot configuration");
  return { name: data.name.trim(), instructions: data.instructions, model: data.model };
}
