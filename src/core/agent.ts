import { randomUUID } from "node:crypto";
import type { AgentDefinition, WorkspaceSettings } from "../config/workspace.ts";
import { loadSettings } from "../config/workspace.ts";
import { DeepSeek } from "../providers/deepseek.ts";
import { builtinTools } from "../tools/builtin.ts";
import { createSkillTool } from "../tools/skill.ts";
import { Toolbox } from "../tools/toolbox.ts";
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
      await buildToolbox(skills, definition),
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

  private contextTokens(): number {
    return this.usage
      ? this.usage.tokens + estimateTokens(this.messages.slice(this.usage.messageCount))
      : estimateTokens([this.system, ...this.messages, ...this.toolbox.schemas]);
  }

  private async compact(signal?: AbortSignal): Promise<string> {
    if (this.replying) throw new Error("An Agent reply or compaction is already in progress.");
    this.replying = true;
    try {
      if (signal?.aborted) return "Compaction cancelled; active context unchanged.";
      const cut = retentionStart(this.messages);
      if (cut === 0) return "Not enough compactable context; active context unchanged.";
      const older = this.messages.slice(0, cut);
      const request: Message[] = [
        { role: "system", content: summaryInstructions },
        { role: "user", content: summaryInput(older) },
      ];
      const reserve = Math.max(16_384, this.definition.llm.max_tokens);
      if (estimateTokens(request) + reserve > this.model.contextWindow) {
        return "Not enough model budget to summarize; active context unchanged.";
      }
      const reply = await this.model.reply(request, [], signal);
      if (signal?.aborted) return "Compaction cancelled; active context unchanged.";
      const summary = summaryMessage(reply.message.content.trim());
      if (
        reply.finishReason !== "stop" ||
        !reply.message.content.trim() ||
        reply.message.tool_calls?.length ||
        estimateTokens([summary]) >= estimateTokens(older)
      ) {
        return "Unusable summary; active context unchanged.";
      }
      this.messages.splice(0, cut, summary);
      this.usage = undefined;
      return `Compacted ${cut} older messages; ${this.messages.length} active messages remain.`;
    } catch (error) {
      if (signal?.aborted) return "Compaction cancelled; active context unchanged.";
      return `Compaction failed; active context unchanged: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.replying = false;
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

async function buildToolbox(skills: SkillLoader, definition: AgentDefinition): Promise<Toolbox> {
  const tools = [...builtinTools];
  if (definition.allow_skills) {
    const discovered = await skills.discover();
    if (discovered.length) tools.push(createSkillTool(skills, discovered));
  }
  return new Toolbox(tools);
}
