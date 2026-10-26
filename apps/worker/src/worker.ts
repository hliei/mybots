import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Harness } from "@mybots/agent";
import {
  type ConversationId,
  type ConversationView,
  type ConversationWatch,
  computerTools,
  context,
  modelCatalog,
  modelChoices,
  openAgent,
  readHistory,
  resourceContext,
  resourceTools,
  type SubmissionId,
  searchHistory,
} from "@mybots/agent";
import type { Bot, ChatMessage, ChatView, WorkerCommand } from "@mybots/contracts";
import { ProductDatabase, ProviderSettings } from "@mybots/db";
import { type CommandOwner, DockerSandbox } from "@mybots/sandbox";

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
  publish: (subscription: string, value: ChatView) => void,
): Promise<Worker> {
  // A separate SQLite transaction gives this worker kernel-released exclusive ownership.
  const ownership = new DatabaseSync(join(root, "worker-owner.sqlite"));
  let database: ProductDatabase | undefined;
  let harness: Harness | undefined;
  try {
    ownership.exec("BEGIN EXCLUSIVE");
    database = new ProductDatabase(join(root, "product.sqlite"));
    const products = database;
    const settings = new ProviderSettings(root);
    const computer = products.computer();
    const sandbox = new DockerSandbox(computer, join(root, "computer", "workspace"));
    const turns = new Map<string, { owner: CommandOwner; settled: Promise<void> }>();
    const cleanupErrors = new Map<string, string>();
    let closing = false;
    const trackTurn = (owner: CommandOwner) => {
      if (turns.has(owner.turnId)) return;
      const settled = (async () => {
        const submission = await harness?.submission(Number(owner.turnId) as SubmissionId, context);
        if (!submission) throw new Error("Computer owner submission unavailable");
        const status = await submission.wait(context);
        await sandbox.finishTurn(computer, owner, status.status === "done");
        turns.delete(owner.turnId);
        cleanupErrors.delete(owner.botId);
      })();
      turns.set(owner.turnId, { owner, settled });
      void settled.catch((error: unknown) => {
        if (!closing) cleanupErrors.set(owner.botId, `Computer cleanup failed: ${String(error)}`);
      });
    };
    const botForConversation = (conversationId: number) => {
      const bot = products.bots().find((bot) => bot.conversationId === conversationId);
      if (!bot) throw new Error("Bot not found for tool access");
      return bot.id;
    };
    harness = await openAgent(
      join(root, "durable.sqlite"),
      [],
      [
        computerTools(sandbox, computer, botForConversation, trackTurn),
        resourceTools(products, botForConversation),
      ],
      (id) => resourceContext(products, botForConversation(id)),
      (id) => settings.key(id),
    );
    return await ownedWorker(database, harness, settings, turns, cleanupErrors, () => {
      closing = true;
    });
  } catch (error) {
    await harness?.close(context);
    database?.close();
    ownership.close();
    throw error;
  }

  async function ownedWorker(
    database: ProductDatabase,
    harness: Harness,
    settings: ProviderSettings,
    turns: Map<string, { owner: CommandOwner; settled: Promise<void> }>,
    cleanupErrors: Map<string, string>,
    beginClose: () => void,
  ): Promise<Worker> {
    const watches = new Map<string, ConversationWatch>();
    const conversation = async (bot: Bot) => {
      const chat = await harness.conversation(bot.conversationId as ConversationId, context);
      if (!chat) throw new Error("Conversation not found");
      return chat;
    };
    async function configure(bot: Bot): Promise<void> {
      const model = modelCatalog.find((model) => `${model.provider}/${model.id}` === bot.model);
      if (!model) return;
      await (await conversation(bot)).configure(
        {
          model: { provider: model.provider, modelId: model.id },
          thinkingLevel: "high",
          instructions: bot.instructions,
        },
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
            if (status && (status.status === "queued" || status.status === "unanswered"))
              inputs.push({
                id: data.submissionId,
                requestId: data.requestId,
                text: data.text,
                status: status.status,
                reason: status.reason,
                detail: typeof status.detail === "string" ? status.detail : undefined,
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
            ...(cleanupErrors.has(bot.id) ? [cleanupErrors.get(bot.id) as string] : []),
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
      await configure(bot);
    }
    harness.resume();
    return {
      async command(command: WorkerCommand): Promise<unknown> {
        if (command.action === "close") return;
        if (command.action === "models") return modelChoices((id) => settings.key(id));
        if (command.action === "providers") return settings.status();
        if (command.action === "provider-update")
          return settings.update(command.provider, command.apiKey, command.remove);
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
            if (
              !modelChoices((id) => settings.key(id)).some(
                (model) => model.id === bot.model && model.available,
              )
            )
              throw new Error(
                "Model unavailable. Choose a supported model and save its key in Provider settings.",
              );
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
            await Promise.all(
              [...turns.values()]
                .filter(({ owner }) => owner.botId === bot.id)
                .map(({ settled }) => settled),
            );
            return;
          case "view":
            return view(bot);
          case "history-search":
            return searchHistory(chat, command.query, command.before, context);
          case "history-read":
            return readHistory(chat, command.entryId, command.offset, context);
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
        beginClose();
        await Promise.all([...watches.values()].map((watch) => watch.stop()));
        // Reconcile already-settled submissions before closing their SDK handles.
        await Promise.allSettled(
          [...turns.values()].map(async ({ owner }) => {
            const status = await (
              await harness.submission(Number(owner.turnId) as SubmissionId, context)
            )?.status(context);
            if (status?.status === "done" || status?.status === "unanswered")
              await turns.get(owner.turnId)?.settled;
          }),
        );
        try {
          await harness.close(context);
          await Promise.allSettled([...turns.values()].map(({ settled }) => settled));
        } finally {
          database.close();
          ownership.close();
        }
      },
    };
  }
}
