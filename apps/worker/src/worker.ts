import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Harness } from "@mybots/agent";
import {
  type ConversationId,
  type ConversationView,
  type ConversationWatch,
  context,
  type HostModel,
  openAgent,
  type SubmissionId,
} from "@mybots/agent";
import type { Bot, ChatMessage, ChatView, WorkerCommand } from "@mybots/contracts";
import { ProductDatabase } from "@mybots/db";

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => (block?.type === "text" ? [String(block.text)] : []))
    .join("\n");
}

interface Worker {
  command(command: WorkerCommand): Promise<unknown>;
  close(): Promise<void>;
}

export async function openWorker(
  root: string,
  models: HostModel[],
  publish: (subscription: string, value: ChatView) => void,
): Promise<Worker> {
  // A separate SQLite transaction gives this worker kernel-released exclusive ownership.
  const ownership = new DatabaseSync(join(root, "data", "worker-owner.sqlite"));
  let database: ProductDatabase | undefined;
  let harness: Harness | undefined;
  try {
    ownership.exec("BEGIN EXCLUSIVE");
    database = new ProductDatabase(join(root, "data", "product.sqlite"));
    harness = await openAgent(join(root, "data", "durable.sqlite"), models);
    return await ownedWorker(database, harness);
  } catch (error) {
    await harness?.close(context);
    database?.close();
    ownership.close();
    throw error;
  }

  async function ownedWorker(database: ProductDatabase, harness: Harness): Promise<Worker> {
    const watches = new Map<string, ConversationWatch>();
    const conversation = async (bot: Bot) => {
      const chat = await harness.conversation(bot.conversationId as ConversationId, context);
      if (!chat) throw new Error("Conversation not found");
      return chat;
    };
    async function configure(bot: Bot): Promise<void> {
      const model = models.find((model) => model.id === bot.model);
      if (!model) throw new Error("Configured model unavailable");
      await (await conversation(bot)).configure(
        { model: { provider: model.id, modelId: model.modelId }, instructions: bot.instructions },
        context,
      );
    }
    async function view(bot: Bot, state?: ConversationView): Promise<ChatView> {
      const chat = await conversation(bot);
      let acquired: ConversationWatch | undefined;
      if (!state) {
        acquired = await chat.watch(context);
        state = acquired.value;
      }
      try {
        const entries = [...(await chat.entries({}, 200, undefined, context)).items].reverse();
        const messages: ChatMessage[] = [];
        const inputs: ChatView["inputs"] = [];
        for (const entry of entries) {
          if (entry.kind === "chat.input") {
            const data = entry.data as { submissionId: number; requestId: string; text: string };
            const status = await (
              await harness.submission(data.submissionId as SubmissionId, context)
            )?.status(context);
            if (
              status &&
              (status.status === "queued" ||
                (status.status === "unanswered" && status.entry === undefined))
            )
              inputs.push({
                id: data.submissionId,
                requestId: data.requestId,
                text: data.text,
                status: status.status,
                reason: status.reason,
              });
            continue;
          }
          if (!["pi.user", "pi.assistant", "pi.tool-result"].includes(entry.kind)) continue;
          for (const message of entry.model ?? []) {
            if (message.role === "system") continue;
            messages.push({
              id: String(entry.id),
              role: message.role === "toolResult" ? "tool" : message.role,
              text: text(message.content),
              tools:
                message.role === "assistant"
                  ? message.content.flatMap((block) =>
                      block.type === "toolCall" ? [block.name] : [],
                    )
                  : [],
              status: message.role === "assistant" ? message.stopReason : undefined,
            });
          }
        }
        const live = state.docs["pi.live"] as
          | {
              run?: unknown;
              generation?: { message?: { content?: unknown }; retry?: { error: string } };
              tools?: { name: string }[];
              compactions?: unknown[];
              compactionFailure?: { error: string };
            }
          | undefined;
        return {
          botId: bot.id,
          threadId: bot.threadId,
          messages,
          inputs,
          busy: live?.run !== undefined,
          partial: text(live?.generation?.message?.content),
          activity: [
            ...(live?.tools?.map((tool) => tool.name) ?? []),
            ...(live?.compactions?.length ? ["Compacting context"] : []),
            ...(live?.compactionFailure ? [live.compactionFailure.error] : []),
            ...(live?.generation?.retry ? ["Retrying model request"] : []),
          ],
        };
      } finally {
        await acquired?.stop();
      }
    }
    for (const bot of database.bots()) {
      if (models.some((model) => model.id === bot.model)) await configure(bot);
    }
    harness.resume();
    return {
      async command(command: WorkerCommand): Promise<unknown> {
        if (command.action === "close") return;
        if (command.action === "unsubscribe") {
          await watches.get(command.subscription)?.stop();
          watches.delete(command.subscription);
          return;
        }
        if (command.action === "create") {
          const chat = await harness.createConversation(
            { ownership: { kind: "ownerless" } },
            context,
          );
          const bot = database.create(command.configuration, chat.id);
          await configure(bot);
          return bot;
        }
        const bot = database.bot(command.botId);
        const chat = await conversation(bot);
        switch (command.action) {
          case "configure":
            return configure(bot);
          case "send": {
            await configure(bot);
            const submission = await chat.submit(
              {
                type: "input",
                content: command.text,
                requestId: command.requestId,
                whenBusy: "steer",
              },
              context,
            );
            // Display-only SDK receipt retains withdrawn input; it is never a second execution queue.
            await chat.submit(
              {
                type: "write",
                requestId: `receipt:${command.requestId}`,
                entry: {
                  kind: "chat.input",
                  data: {
                    submissionId: submission.id,
                    requestId: command.requestId,
                    text: command.text,
                  },
                },
              },
              context,
            );
            return { id: submission.id, requestId: command.requestId };
          }
          case "stop":
            await chat.abort(context);
            return;
          case "view":
            return view(bot);
          case "subscribe": {
            const watch = await chat.watch(context);
            watches.set(command.subscription, watch);
            publish(command.subscription, await view(bot, watch.value));
            watch.start(async (state) =>
              publish(command.subscription, await view(database.bot(bot.id), state)),
            );
            return;
          }
        }
      },
      async close() {
        await Promise.all([...watches.values()].map((watch) => watch.stop()));
        await harness.close(context);
        database.close();
        ownership.close();
      },
    };
  }
}
