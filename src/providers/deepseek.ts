import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions";
import type { ModelSettings } from "../config/workspace.ts";
import type { AssistantMessage, Message, ToolCall, ToolSchema } from "../core/messages.ts";

export interface ModelReply {
  message: AssistantMessage;
  finishReason: string | undefined;
  usageTokens?: number;
}

export class DeepSeek {
  private readonly client: OpenAI;
  private readonly settings: ModelSettings;

  constructor(settings: ModelSettings) {
    this.settings = settings;
    this.client = new OpenAI({
      apiKey: settings.api_key,
      baseURL: settings.api_base ?? "https://api.deepseek.com",
      maxRetries: 2,
      timeout: 60_000,
    });
  }

  // DeepSeek model limits verified against the provider docs on 2026-10-12.
  get contextWindow(): number {
    if (this.settings.context_window !== undefined) return this.settings.context_window;
    return [
      "deepseek-flash",
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "deepseek-v4-flash-vision-exp",
    ].includes(this.settings.model)
      ? 1_000_000
      : 128_000;
  }

  async reply(messages: Message[], tools: ToolSchema[], signal?: AbortSignal): Promise<ModelReply> {
    const request: ChatCompletionCreateParamsNonStreaming & {
      thinking: { type: "enabled" | "disabled" };
    } = {
      model: this.settings.model,
      messages,
      stream: false,
      temperature: this.settings.temperature,
      max_tokens: this.settings.max_tokens,
      thinking: { type: this.settings.thinking ? "enabled" : "disabled" },
      ...(tools.length ? { tools } : {}),
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
    const usage = response.usage;
    const validUsage =
      usage &&
      [usage.prompt_tokens, usage.completion_tokens, usage.total_tokens].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      ) &&
      usage.prompt_tokens > 0 &&
      usage.total_tokens === usage.prompt_tokens + usage.completion_tokens;
    return {
      ...(validUsage ? { usageTokens: usage.total_tokens } : {}),
      finishReason: response.choices[0]?.finish_reason,
      message: {
        role: "assistant",
        content: message.content ?? "",
        ...(calls.length ? { tool_calls: calls } : {}),
        ...(typeof reasoning === "string" ? { reasoning_content: reasoning } : {}),
      },
    };
  }
}
