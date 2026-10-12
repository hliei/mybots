import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions";
import type { ModelSettings } from "./config.ts";
import { toolSchemas } from "./tools.ts";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface AssistantMessage {
  role: "assistant";
  content: string;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
}

export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | AssistantMessage
  | { role: "tool"; content: string; tool_call_id: string };

export class DeepSeek {
  private readonly client: OpenAI;
  private readonly settings: ModelSettings;

  constructor(settings: ModelSettings) {
    this.settings = settings;
    this.client = new OpenAI({
      apiKey: settings.api_key,
      baseURL: settings.api_base ?? "https://api.deepseek.com",
      maxRetries: 0,
      timeout: 60_000,
    });
  }

  async reply(messages: Message[], signal?: AbortSignal): Promise<AssistantMessage> {
    const request: ChatCompletionCreateParamsNonStreaming & {
      thinking: { type: "enabled" | "disabled" };
    } = {
      model: this.settings.model,
      messages,
      stream: false,
      temperature: this.settings.temperature,
      max_tokens: this.settings.max_tokens,
      thinking: { type: this.settings.thinking ? "enabled" : "disabled" },
      tools: toolSchemas,
    };
    let response: ChatCompletion;
    try {
      response = await this.client.chat.completions.create(request, { signal });
    } catch (error) {
      if (signal?.aborted) throw new Error("DeepSeek request cancelled.");
      if (error instanceof OpenAI.APIError && error.status) {
        throw new Error(`DeepSeek request failed (HTTP ${error.status}).`);
      }
      throw new Error("DeepSeek request failed: connection error or timeout.");
    }
    const message = response.choices[0]?.message;
    if (!message) throw new Error("DeepSeek returned no text reply.");
    const calls: ToolCall[] = [];
    for (const call of message.tool_calls ?? []) {
      if (
        call.type !== "function" ||
        typeof call.id !== "string" ||
        typeof call.function.name !== "string" ||
        typeof call.function.arguments !== "string"
      ) {
        throw new Error("DeepSeek returned an invalid tool call.");
      }
      calls.push({
        id: call.id,
        type: "function",
        function: { name: call.function.name, arguments: call.function.arguments },
      });
    }
    if (typeof message.content !== "string" && !(message.content === null && calls.length)) {
      throw new Error("DeepSeek returned no text reply.");
    }
    const reasoning: unknown =
      "reasoning_content" in message ? message.reasoning_content : undefined;
    return {
      role: "assistant",
      content: message.content ?? "",
      ...(calls.length ? { tool_calls: calls } : {}),
      ...(typeof reasoning === "string" ? { reasoning_content: reasoning } : {}),
    };
  }
}
