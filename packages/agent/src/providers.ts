import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  createModels,
  type Model,
  type MutableModels,
  type Provider,
} from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import type { ModelChoice, ProviderId } from "@mybots/contracts";

const supportedGo = new Set([
  "claude-haiku-5-5",
  "minimax-m3",
  "qwen3.7-plus",
  "qwen3.8-flash",
  "qwen3.8-max",
  "gemini-4-argon-contributor",
  "deepseek-v4-pro",
  "deepseek-v4.1-flash",
  "glm-5.2",
  "glm-5.3",
  "glm-5.3-flash",
  "hy3",
  "hy4-preview",
  "kimi-k2.7-code",
  "kimi-k3",
  "longcat-2.0",
  "mimo-v2.5",
  "mimo-v2.5-pro",
  "mimo-v2.6-flash",
  "mimo-v2.6-pro",
  "step-5-preview",
  "gpt-5.6-luna",
  "gpt-6-luna",
  "grok-4.7",
  "minimax-m3.1-flash-free",
  "muse-spark-1.2-contributor",
  "muse-spark-1.3-contributor",
]);
const providers: Provider[] = [deepseekProvider(), opencodeGoProvider()];
const goEndpoints: Record<string, string> = {
  "openai-completions": "https://opencode.ai/inference/go/openai/v1",
  "openai-responses": "https://opencode.ai/inference/go/openai/v1",
  "anthropic-messages": "https://opencode.ai/inference/go/anthropic",
  "google-generative-ai": "https://opencode.ai/inference/go/google/v1beta",
};
export const modelCatalog: Model<Api>[] = providers.flatMap((provider) =>
  provider
    .getModels()
    .filter((model) => provider.id === "deepseek" || supportedGo.has(model.id))
    .map((model) => ({
      ...model,
      input: ["text"] as ["text"],
      ...(provider.id === "opencode-go"
        ? {
            baseUrl: goEndpoints[model.api] as string,
            ...(model.id === "minimax-m3.1-flash-free"
              ? { cost: { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0 } }
              : {}),
            id:
              model.id === "gemini-4-argon-contributor"
                ? "gemini-4-argon"
                : model.id === "minimax-m3.1-flash-free"
                  ? "minimax-m3.1-flash"
                  : model.id,
            name:
              model.id === "gemini-4-argon-contributor"
                ? "Gemini 4 Argon"
                : model.id === "minimax-m3.1-flash-free"
                  ? "MiniMax M3.1 Flash"
                  : model.name,
          }
        : {}),
    })),
);
modelCatalog.push({
  id: "kimi-k3.1-pro",
  name: "Kimi K3.1 Pro",
  provider: "opencode-go",
  api: "openai-completions",
  baseUrl: goEndpoints["openai-completions"] as string,
  reasoning: true,
  input: ["text"],
  contextWindow: 1048576,
  maxTokens: 131072,
  thinkingLevelMap: {
    off: null,
    minimal: null,
    low: "low",
    medium: null,
    high: "high",
    xhigh: null,
    max: "max",
  },
  cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2 },
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsStrictMode: true,
    maxTokensField: "max_tokens",
    supportsMidConvoSystemMessages: true,
    supportsMidConvoToolAdditions: true,
  },
});

export function modelChoices(key: (id: ProviderId) => string | undefined): ModelChoice[] {
  return modelCatalog.map((model) => ({
    id: `${model.provider}/${model.id}`,
    name: `${model.provider === "deepseek" ? "DeepSeek" : "OpenCode Go"} · ${model.name}`,
    available: Boolean(key(model.provider as ProviderId)),
  }));
}

function safeError(error: AssistantMessage): string {
  const message = error.errorMessage ?? "";
  const name = error.provider === "deepseek" ? "DeepSeek" : "OpenCode Go";
  const retryable = isRetryableAssistantError(error);
  if (/not configured/i.test(message)) return `Save a ${name} API key in Provider settings.`;
  if (/401|unauthorized|authentication|invalid.*key/i.test(message))
    return `${name} authentication failed (401). Replace the key in Provider settings.`;
  if (/429|quota|rate.limit|usage.limit|available balance|out of budget|billing/i.test(message))
    return retryable
      ? `${name} rate limit exceeded (429). Check your provider allowance.`
      : `${name} quota exceeded. Check your subscription and provider allowance.`;
  if (/402|403|subscription|permission|balance/i.test(message))
    return `${name} access denied (403). Check the key, subscription and account balance.`;
  if (/404|model.*not.*found/i.test(message))
    return `${name} model unavailable (404). Choose another supported model in Bot settings.`;
  if (/context.*(length|window)|too many tokens/i.test(message))
    return `${name}: context length exceeded.`;
  if (/500|502|503|504/i.test(message))
    return `${name} service unavailable (503). Try again later.`;
  if (/timed? out|timeout/i.test(message))
    return `${name} model stream timed out. Try again later.`;
  if (/ended without|ended before|disconnected before completion/i.test(message))
    return `${name} model stream ended without a completion signal.`;
  if (retryable) return `${name} model connection error. Try again later.`;
  return `${name} model request failed. Check provider access and try again.`;
}

export function providerModels(key: (id: ProviderId) => string | undefined): MutableModels {
  const models = createModels();
  for (const provider of providers) {
    models.setProvider({
      ...provider,
      auth: {
        apiKey: {
          name: provider.name,
          resolve: async () => {
            const apiKey = key(provider.id as ProviderId);
            return apiKey ? { auth: { apiKey } } : undefined;
          },
        },
      },
      getModels: () => modelCatalog.filter((model) => model.provider === provider.id),
    });
  }
  // Sanitize before Durable persists provider errors, including response bodies that echo credentials.
  const stream = models.streamSimple.bind(models);
  models.streamSimple = (model, context, options) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      const idle = new AbortController();
      const signal = options?.signal ? AbortSignal.any([options.signal, idle.signal]) : idle.signal;
      const timer = setTimeout(() => idle.abort(), 180000);
      try {
        const source = stream(model, context, { ...options, signal });
        for await (const event of source) {
          timer.refresh();
          if (event.type === "error") {
            if (idle.signal.aborted && !options?.signal?.aborted) {
              event.error.stopReason = "error";
              event.reason = "error";
              event.error.errorMessage = "Model stream timed out without progress";
            }
            event.error.errorMessage = safeError(event.error);
            event.error.content = [];
          }
          output.push(event);
        }
        output.end(await source.result());
      } finally {
        clearTimeout(timer);
      }
    })();
    return output;
  };
  return models;
}
