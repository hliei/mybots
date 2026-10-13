import { randomUUID } from "node:crypto";
import { WorkspaceConfiguration } from "../config/reload.ts";
import type { AgentDefinition, WorkspaceSettings } from "../config/workspace.ts";
import { DeepSeek } from "../providers/deepseek.ts";
import { builtinTools } from "../tools/builtin.ts";
import { createSkillTool } from "../tools/skill.ts";
import type { Tool } from "../tools/toolbox.ts";
import { Toolbox } from "../tools/toolbox.ts";
import { createFetchContentTool } from "../tools/web-access/fetch-content.ts";
import { createWebSearchTool } from "../tools/web-access/web-search.ts";
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
  private currentConfig: WorkspaceSettings;
  private currentDefinition: AgentDefinition;

  get config(): WorkspaceSettings {
    return this.currentConfig;
  }
  get definition(): AgentDefinition {
    return this.currentDefinition;
  }
  readonly sessionId: string;
  readonly recoveryDiagnostics: string[] = [];
  private readonly createdAt: string;
  private readonly configuration: WorkspaceConfiguration;
  private readonly ownsConfiguration: boolean;
  private readonly history: ConversationHistory;
  private model: DeepSeek;
  private toolbox: Toolbox;
  private readonly skills: SkillLoader;
  private readonly commands: CommandRegistry;
  private system: Message;
  private readonly messages: Message[];
  private replying = false;
  private usage: { tokens: number; messageCount: number } | undefined;
  private summary: Message | undefined;
  private readonly entryIds = new WeakMap<Message, string>();

  private constructor(
    config: WorkspaceSettings,
    definition: AgentDefinition,
    history: ConversationHistory,
    session: SessionRecord,
    toolbox: Toolbox,
    skills: SkillLoader,
    commands: CommandRegistry,
    configuration: WorkspaceConfiguration,
    ownsConfiguration: boolean,
  ) {
    this.ownsConfiguration = ownsConfiguration;
    this.configuration = configuration;
    this.currentConfig = config;
    this.currentDefinition = definition;
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

  static async open(
    options: {
      workspace?: string;
      agent?: string;
      sessionId?: string;
      configuration?: WorkspaceConfiguration;
    } = {},
  ): Promise<Agent> {
    const configuration =
      options.configuration ??
      (await WorkspaceConfiguration.open(
        options.workspace ?? "../default_workspace",
        options.agent,
      ));
    let { config, definition } = await configuration.snapshot(options.agent);
    const history = await ConversationHistory.open(config.history_path);
    const existing = options.sessionId ? await history.getSession(options.sessionId) : undefined;
    if (options.sessionId && !existing) throw new Error(`Session not found: ${options.sessionId}`);
    if (existing) {
      if (options.agent && options.agent !== existing.agent_id)
        throw new Error("Session Agent does not match the requested Agent.");
      ({ config, definition } = await configuration.snapshot(existing.agent_id));
    }
    const skills = new SkillLoader(config.skills_path);
    const session = existing ?? (await history.createSession(definition.id, randomUUID()));
    const agent = new Agent(
      config,
      definition,
      history,
      session,
      await buildToolbox(skills, definition, config),
      skills,
      sessionCommands(),
      configuration,
      !options.configuration,
    );
    if (existing) {
      const recovered = await history.recoverContext(existing.id);
      agent.recoveryDiagnostics.push(...recovered.diagnostics);
      for (const { id, message } of recovered.messages) {
        agent.messages.push(message);
        agent.entryIds.set(message, id);
      }
      if (recovered.summary) {
        agent.messages.unshift(recovered.summary);
        agent.summary = recovered.summary;
      }
    }
    if (!options.configuration) configuration.startWatching();
    return agent;
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
      await this.refreshSettings();
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
      if (automatic && this.contextTokens(compacted, null) > this.inputBudget) {
        return {
          report: "Automatic compaction cannot fit the input budget; active context unchanged.",
        };
      }
      const firstKept = messages[cut];
      await this.history.saveCompaction(
        this.sessionId,
        reply.message.content.trim(),
        firstKept ? this.entryIds.get(firstKept) : undefined,
      );
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

  async close(): Promise<void> {
    if (this.ownsConfiguration) await this.configuration.stop();
  }

  private async refreshSettings(): Promise<void> {
    const { config, definition } = await this.configuration.snapshot(this.definition.id);
    if (JSON.stringify([config, definition]) === JSON.stringify([this.config, this.definition]))
      return;
    const toolbox = await buildToolbox(this.skills, definition, config);
    const requestChanged =
      JSON.stringify([definition.llm, definition.agent_md, toolbox.schemas]) !==
      JSON.stringify([this.definition.llm, this.definition.agent_md, this.toolbox.schemas]);
    this.currentConfig = config;
    this.currentDefinition = definition;
    this.model = new DeepSeek(definition.llm);
    this.toolbox = toolbox;
    this.system = { role: "system", content: definition.agent_md };
    if (requestChanged) this.usage = undefined;
  }

  async chat(input: string, signal?: AbortSignal): Promise<string> {
    if (this.replying) throw new Error("An Agent reply is already in progress.");
    this.replying = true;
    try {
      await this.refreshSettings();
      const user: Message = { role: "user", content: input };
      this.entryIds.set(user, await this.history.saveMessage(this.sessionId, user));
      const pending: Message[] = [user];
      let usage = this.usage;
      while (true) {
        const context = [...this.messages, ...pending];
        if (this.contextTokens(context, usage) > this.inputBudget) {
          const result = await this.compactContext(context, signal, true);
          if (!result.messages) throw new Error(`Automatic compaction: ${result.report}`);
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
        this.entryIds.set(reply, await this.history.saveMessage(this.sessionId, reply));
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
          this.entryIds.set(result, await this.history.saveMessage(this.sessionId, result));
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
  const tools: Tool<object>[] = [...builtinTools];
  if (definition.allow_skills) {
    const discovered = await skills.discover();
    if (discovered.length) tools.push(createSkillTool(skills, discovered));
  }
  if (config.web_search) tools.push(createWebSearchTool(config.web_search));
  if (config.fetch_content) tools.push(createFetchContentTool());
  return new Toolbox(tools);
}
