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

export interface ModelChoice {
  id: string;
  name: string;
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

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  tools: string[];
  status?: string;
}

export interface ChatInput {
  id: number;
  requestId: string;
  text: string;
  status: string;
  reason?: string;
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

export type WorkerCommand =
  | { action: "create"; configuration: BotConfiguration }
  | { action: "configure"; botId: string }
  | { action: "send"; botId: string; text: string; requestId: string }
  | { action: "stop"; botId: string }
  | { action: "view"; botId: string }
  | { action: "subscribe"; botId: string; subscription: string }
  | { action: "unsubscribe"; subscription: string }
  | { action: "close" };

export interface WorkerRequest {
  id: number;
  command: WorkerCommand;
}

export type WorkerMessage =
  | { type: "ready"; models: ModelChoice[] }
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
