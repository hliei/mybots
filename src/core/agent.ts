import { randomUUID } from "node:crypto";
import type { AgentDefinition, WorkspaceSettings } from "../config/workspace.ts";
import { loadSettings } from "../config/workspace.ts";
import { DeepSeek } from "../providers/deepseek.ts";
import { builtinTools } from "../tools/builtin.ts";
import { createSkillTool } from "../tools/skill.ts";
import { Toolbox } from "../tools/toolbox.ts";
import { createWebSearchTool } from "../tools/websearch.ts";
import type { CommandContext, CommandRegistry } from "./commands.ts";
import { sessionCommands } from "./commands.ts";
import {
  estimateTokens,
  retentionStart,
  summaryInput,
  summaryInstructions,
  summaryMessage,
} from "./compaction.ts";
import type { SessionRecord } from "./history.ts";
import { ConversationHistory } from "./history.ts";
import type { Message } from "./messages.ts";
import { SkillLoader } from "./skills.ts";

export class Agent {
  readonly config: WorkspaceSettings;
  readonly definition: AgentDefinition;
  readonly sessionId: string;
  private readonly createdAt: string;
  private readonly history: ConversationHistory;
  private readonly model: DeepSeek;
  private readonly toolbox: Toolbox;
  private readonly skills: SkillLoader;
  private readonly commands: CommandRegistry;
  private readonly system: Message;
  private readonly messages: Message[];
  private replying = false;
  private usage: { tokens: number; messageCount: number } | undefined;
  private summary: Message | undefined;

  private constructor(
    config: WorkspaceSettings,
    definition: AgentDefinition,
    history: ConversationHistory,
    session: SessionRecord,
    toolbox: Toolbox,
    skills: SkillLoader,
    commands: CommandRegistry,
  ) {
    this.config = config;
    this.definition = definition;
    this.history = history;
    this.sessionId = session.id;
    this.createdAt = session.created_at;
    this.toolbox = toolbox;
    this.skills = skills;
    this.commands = commands;
    this.model = new DeepSeek(definition.llm);
    this.system = { role: "system", content: definition.agent_md };
    this.messages = [];
  }

  static async open(options: { workspace?: string; agent?: string } = {}): Promise<Agent> {
    const { config, definition } = await loadSettings(
      options.workspace ?? "../default_workspace",
      options.agent,
    );
    const history = await ConversationHistory.open(config.history_path);
    const skills = new SkillLoader(config.skills_path);
    const sessionId = randomUUID();
    const session = await history.createSession(definition.id, sessionId);
    return new Agent(
      config,
      definition,
      history,
      session,
      await buildToolbox(skills, definition, config),
      skills,
      sessionCommands(),
    );
  }

  /**
   * Runs a slash command against the current session. Returns `undefined` when
   * the input is not a registered command, so the caller can treat it as chat.
   */
  async runCommand(input: string, signal?: AbortSignal): Promise<string | undefined> {
    const context: CommandContext = {
      sessionId: this.sessionId,
      agentName: this.definition.name,
      agentId: this.definition.id,
      createdAt: this.createdAt,
      // Active-context messages, excluding the system instructions.
      messageCount: this.messages.length,
      skills: this.skills,
      compact: () => this.compact(signal),
      contextReport: () => {
        const reserve = Math.max(16_384, this.definition.llm.max_tokens);
        return [
          `**Active messages:** ${this.messages.length}`,
          `**Estimated tokens:** ${this.contextTokens()}`,
          `**Context window:** ${this.model.contextWindow}`,
          `**Output reserve:** ${reserve}`,
          `**Compaction threshold:** ${Math.max(0, this.model.contextWindow - reserve)}`,
        ].join("\n");
      },
    };
    return this.commands.dispatch(input, context);
  }

  private contextTokens(
    messages = this.messages,
    usage: typeof this.usage | null = this.usage,
  ): number {
    return usage
      ? usage.tokens + estimateTokens(messages.slice(usage.messageCount))
      : estimateTokens([this.system, ...messages, ...this.toolbox.schemas]);
  }

  private get inputBudget(): number {
    return Math.max(0, this.model.contextWindow - Math.max(16_384, this.definition.llm.max_tokens));
  }

  private async compact(signal?: AbortSignal): Promise<string> {
    if (this.replying) throw new Error("An Agent reply or compaction is already in progress.");
    this.replying = true;
    try {
      const result = await this.compactContext(this.messages, signal);
      if (result.messages) {
        this.messages.splice(0, this.messages.length, ...result.messages);
        this.summary = result.messages[0];
        this.usage = undefined;
      }
      return result.report;
    } finally {
      this.replying = false;
    }
  }

  private async compactContext(
    messages: Message[],
    signal?: AbortSignal,
    automatic = false,
  ): Promise<{ messages?: Message[]; report: string }> {
    try {
      if (signal?.aborted) return { report: "Compaction cancelled; active context unchanged." };
      let cut = retentionStart(messages);
      if (
        automatic &&
        (cut === 0 || this.contextTokens(messages.slice(cut), null) > this.inputBudget)
      ) {
        cut = retentionStart(messages, true);
      }
      const hasSummary = messages[0] === this.summary;
      if (cut <= (hasSummary ? 1 : 0)) {
        return { report: "Not enough compactable context; active context unchanged." };
      }
      const older = messages.slice(0, cut);
      const transcript = summaryInput(hasSummary ? older.slice(1) : older);
      const request: Message[] = [
        {
          role: "system",
          content: `${summaryInstructions}\nUpdate any previous summary using only the newly removed transcript.\nIf the transcript ends within a user turn, preserve its continuing objective and completed work for the retained continuation.`,
        },
        {
          role: "user",
          content: `${hasSummary ? `[Previous summary]:\n${this.summary?.content}\n\n` : ""}[Newly removed transcript]:\n${transcript}`,
        },
      ];
      const reserve = Math.max(16_384, this.definition.llm.max_tokens);
      if (estimateTokens(request) + reserve > this.model.contextWindow) {
        return { report: "Not enough model budget to summarize; active context unchanged." };
      }
      const reply = await this.model.reply(request, [], signal);
      if (signal?.aborted) return { report: "Compaction cancelled; active context unchanged." };
      const summary = summaryMessage(reply.message.content.trim());
      if (
        reply.finishReason !== "stop" ||
        !reply.message.content.trim() ||
        reply.message.tool_calls?.length ||
        estimateTokens([summary]) >= estimateTokens(older)
      ) {
        return { report: "Unusable summary; active context unchanged." };
      }
      const compacted = [summary, ...messages.slice(cut)];
      return {
        messages: compacted,
        report: `Compacted ${cut} older messages; ${compacted.length} active messages remain.`,
      };
    } catch (error) {
      if (signal?.aborted) return { report: "Compaction cancelled; active context unchanged." };
      return {
        report: `Compaction failed; active context unchanged: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async chat(input: string, signal?: AbortSignal): Promise<string> {
    if (this.replying) throw new Error("An Agent reply is already in progress.");
    this.replying = true;
    try {
      const user: Message = { role: "user", content: input };
      await this.history.saveMessage(this.sessionId, user);
      const pending: Message[] = [user];
      let usage = this.usage;
      while (true) {
        const context = [...this.messages, ...pending];
        if (this.contextTokens(context, usage) > this.inputBudget) {
          const result = await this.compactContext(context, signal, true);
          if (!result.messages) throw new Error(`Automatic compaction: ${result.report}`);
          if (this.contextTokens(result.messages, null) > this.inputBudget) {
            throw new Error(
              "Automatic compaction cannot fit the input budget; active context unchanged.",
            );
          }
          // The newest input stays pending until a response or complete tool group is saved.
          this.messages.splice(
            0,
            this.messages.length,
            ...result.messages.slice(0, result.messages.length - pending.length),
          );
          this.summary = result.messages[0];
          usage = undefined;
          this.usage = undefined;
        }
        const { message: reply, usageTokens } = await this.model.reply(
          [this.system, ...this.messages, ...pending],
          this.toolbox.schemas,
          signal,
        );
        await this.history.saveMessage(this.sessionId, reply);
        pending.push(reply);
        if (usageTokens !== undefined) {
          usage = { tokens: usageTokens, messageCount: this.messages.length + pending.length };
        }
        if (!reply.tool_calls?.length) {
          this.messages.push(...pending);
          this.usage = usage;
          return reply.content;
        }
        for (const call of reply.tool_calls) {
          const result: Message = {
            role: "tool",
            tool_call_id: call.id,
            content: await this.toolbox.execute(call, signal),
          };
          await this.history.saveMessage(this.sessionId, result);
          pending.push(result);
        }
        this.messages.push(...pending);
        this.usage = usage;
        pending.length = 0;
      }
    } finally {
      this.replying = false;
    }
  }
}

async function buildToolbox(
  skills: SkillLoader,
  definition: AgentDefinition,
  config: WorkspaceSettings,
): Promise<Toolbox> {
  const tools = [...builtinTools];
  if (definition.allow_skills) {
    const discovered = await skills.discover();
    if (discovered.length) tools.push(createSkillTool(skills, discovered));
  }
  if (config.websearch) tools.push(createWebSearchTool(config.websearch));
  return new Toolbox(tools);
}
