import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai/utils/transcript";
import {
  createRegistry,
  type Extension,
  GenerationTask,
  Harness,
  hook,
  LiveDoc,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

export interface HostModel {
  id: string;
  name: string;
  modelId: string;
  baseUrl: string;
  apiKey: string;
  contextWindow: number;
  maxTokens: number;
}

export async function openAgent(
  file: string,
  configured: HostModel[],
  extensions: Extension[] = [],
): Promise<Harness> {
  const models = createModels();
  for (const config of configured) {
    models.setProvider(
      createProvider({
        id: config.id,
        auth: {
          apiKey: { name: config.name, resolve: async () => ({ auth: { apiKey: config.apiKey } }) },
        },
        models: [
          {
            id: config.modelId,
            name: config.name,
            api: "openai-completions",
            provider: config.id,
            baseUrl: config.baseUrl,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: config.contextWindow,
            maxTokens: config.maxTokens,
          },
        ],
        api: openAICompletionsApi(),
      }),
    );
  }
  const registry = createRegistry();
  for (const extension of extensions) registry.install(extension);
  let harness: Harness;
  registry.install({
    name: "recent-context",
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async (_request, api, ctx) => {
          const conversation = await harness.conversation(api.conversationId, ctx);
          if (!conversation) throw new Error("Conversation unavailable");
          const live = await api.snapshot(LiveDoc, api.conversationId, ctx);
          const first = live?.run?.inputs[0];
          const input =
            first === undefined
              ? undefined
              : await (await harness.submission(first, ctx))?.status(ctx);
          const start = input?.entry;
          if (start === undefined) throw new Error("Current input unavailable");
          const view = await conversation.context(ctx);
          const messages = view.messages.filter((message) => message.role !== "system");
          const currentCount =
            view.head?.head !== undefined && view.head.head >= start
              ? messages.length
              : view.entries.reduce(
                  (count, entry, index) =>
                    count +
                    (entry.id >= start
                      ? (view.contributions[index] ?? []).filter(
                          (message) => message.role !== "system",
                        ).length
                      : 0),
                  0,
                );
          const split = messages.length - currentCount;
          const previous = messages.slice(0, split);
          const groups: (typeof previous)[] = [];
          for (const message of previous) {
            if (message.role === "user" || groups.length === 0) groups.push([]);
            groups.at(-1)?.push(message);
          }
          const recent: typeof previous = [];
          let size = 0;
          for (const group of groups.slice(-2).reverse()) {
            size += JSON.stringify(group).length;
            if (size > 12000) break;
            recent.unshift(...group);
          }
          const system = getCurrentSystemMessage(view.messages);
          return { messages: [...(system ? [system] : []), ...recent, ...messages.slice(split)] };
        },
      }),
    ],
  });
  harness = await Harness.open(
    await openNodeSqliteStorage(file),
    {
      models,
      registry,
      settings: {
        compaction: { reserveTokens: 1024, keepRecentTokens: 2048, backgroundTokens: 0 },
      },
    },
    BACKGROUND_CONTEXT,
  );
  return harness;
}

export type {
  Conversation,
  ConversationId,
  ConversationView,
  ConversationWatch,
  Cursor,
  EntryRecord,
  Harness,
  SubmissionId,
} from "@earendil-works/pi-durable";
export { BACKGROUND_CONTEXT as context };
