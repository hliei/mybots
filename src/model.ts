import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions";
import type { ModelSettings } from "./config.ts";

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
  reasoning_content?: string;
}

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

  async reply(messages: Message[], signal?: AbortSignal): Promise<Message> {
    const request: ChatCompletionCreateParamsNonStreaming & {
      thinking: { type: "enabled" | "disabled" };
    } = {
      model: this.settings.model,
      messages,
      stream: false,
      temperature: this.settings.temperature,
      max_tokens: this.settings.max_tokens,
      thinking: { type: this.settings.thinking ? "enabled" : "disabled" },
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
    if (!message || typeof message.content !== "string")
      throw new Error("DeepSeek returned no text reply.");
    const reasoning: unknown =
      "reasoning_content" in message ? message.reasoning_content : undefined;
    return {
      role: "assistant",
      content: message.content,
      ...(typeof reasoning === "string" ? { reasoning_content: reasoning } : {}),
    };
  }
}
