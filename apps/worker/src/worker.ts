import { existsSync } from "node:fs";
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
  signal?: AbortSignal,
): Promise<Worker> {
  // A separate SQLite transaction gives this worker kernel-released exclusive ownership.
  const ownership = new DatabaseSync(join(root, "worker-owner.sqlite"));
  let database: ProductDatabase | undefined;
  let harness: Harness | undefined;
  let commandOwners: DatabaseSync | undefined;
  try {
    try {
      ownership.exec("BEGIN EXCLUSIVE");
    } catch {
      throw new Error(
        "Worker unavailable. Another worker owns this data root; stop the other application before restarting.",
      );
    }
    const ownerFile = join(root, "command-owners.sqlite");
    commandOwners = new DatabaseSync(ownerFile);
    commandOwners.exec(
      "CREATE TABLE IF NOT EXISTS turns (turn_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL)",
    );
    const owners = commandOwners;
    const discoverOwners =
      owners.prepare("PRAGMA user_version").get()?.user_version === 0 &&
      existsSync(join(root, "computer", "workspace"));
    const remember = owners.prepare("INSERT OR IGNORE INTO turns (turn_id, bot_id) VALUES (?, ?)");
    const forget = owners.prepare("DELETE FROM turns WHERE turn_id = ?");
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
      // Commit ownership before launching any Computer process, independently of the owner lock.
      remember.run(owner.turnId, owner.botId);
      const settled = (async () => {
        let completed = false;
        try {
          const submission = await harness?.submission(
            Number(owner.turnId) as SubmissionId,
            context,
          );
          if (!submission) throw new Error("Computer owner submission unavailable");
          completed = (await submission.wait(context)).status === "done";
        } catch (error) {
          // Closing the SDK rejects pending waits without settling their inputs.
          if (closing) return;
          throw error;
        }
        await sandbox.finishTurn(computer, owner, completed);
        forget.run(owner.turnId);
        turns.delete(owner.turnId);
      })();
      turns.set(owner.turnId, { owner, settled });
      void settled.catch((error: unknown) => {
        cleanupErrors.set(owner.botId, `Computer cleanup failed: ${String(error)}`);
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
    // Harness.open reconciles tasks without dispatch. Do not wait/submit/abort until cleanup finishes.
    try {
      if (discoverOwners) {
        for (const command of await sandbox.listCommands(computer)) {
          if (command.owner) remember.run(command.owner.turnId, command.owner.botId);
        }
      }
      owners.exec("PRAGMA user_version = 1");
      const interrupted = owners
        .prepare("SELECT turn_id AS turnId, bot_id AS botId FROM turns")
        .all() as unknown as CommandOwner[];
      if (interrupted.length) {
        const commands = await sandbox.listCommands(computer);
        for (const owner of interrupted) {
          const submission = await harness.submission(
            Number(owner.turnId) as SubmissionId,
            context,
          );
          const status = await submission?.status(context);
          if (!status) throw new Error("Computer owner submission unavailable");
          if (
            commands.some(
              (command) =>
                command.owner?.turnId === owner.turnId && command.owner.botId === owner.botId,
            )
          )
            await sandbox.finishTurn(computer, owner, status.status === "done");
          forget.run(owner.turnId);
        }
      }
    } catch {
      throw new Error(
        "Computer recovery cleanup failed. Restore Docker access and inspect the Team Computer before restarting; execution has not resumed.",
      );
    }
    return await ownedWorker(database, harness, settings, turns, cleanupErrors, () => {
      closing = true;
    });
  } catch (error) {
    await harness?.close(context);
    database?.close();
    commandOwners?.close();
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
    const watches = new Map<string, Promise<ConversationWatch>>();
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
    signal?.throwIfAborted();
    harness.resume();
    return {
      async command(command: WorkerCommand): Promise<unknown> {
        if (command.action === "close") return;
        if (command.action === "models") return modelChoices((id) => settings.key(id));
        if (command.action === "providers") return settings.status();
        if (command.action === "provider-update")
          return settings.update(command.provider, command.apiKey, command.remove);
        if (command.action === "unsubscribe") {
          const watch = watches.get(command.subscription);
          watches.delete(command.subscription);
          await (await watch)?.stop();
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
            const opening = chat.watch(context);
            watches.set(command.subscription, opening);
            const watch = await opening;
            if (watches.get(command.subscription) !== opening) {
              await watch.stop();
              return;
            }
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
        await Promise.all([...watches.values()].map(async (watch) => (await watch).stop()));
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
          commandOwners?.close();
          ownership.close();
        }
        if (cleanupErrors.size) throw new Error("Computer cleanup failed during shutdown");
      },
    };
  }
}
