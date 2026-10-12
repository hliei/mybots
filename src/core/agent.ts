import { randomUUID } from "node:crypto";
import type { AgentDefinition, WorkspaceSettings } from "../config/workspace.ts";
import { loadSettings } from "../config/workspace.ts";
import { DeepSeek } from "../providers/deepseek.ts";
import { executeTool, toolSchemas } from "../tools/builtin.ts";
import { ConversationHistory } from "./history.ts";
import type { Message } from "./messages.ts";

export class Agent {
  readonly config: WorkspaceSettings;
  readonly definition: AgentDefinition;
  readonly sessionId: string;
  private readonly history: ConversationHistory;
  private readonly model: DeepSeek;
  private readonly messages: Message[];
  private replying = false;

  private constructor(
    config: WorkspaceSettings,
    definition: AgentDefinition,
    history: ConversationHistory,
    sessionId: string,
  ) {
    this.config = config;
    this.definition = definition;
    this.history = history;
    this.sessionId = sessionId;
    this.model = new DeepSeek(definition.llm);
    this.messages = [{ role: "system", content: definition.agent_md }];
  }

  static async open(options: { workspace?: string; agent?: string } = {}): Promise<Agent> {
    const { config, definition } = await loadSettings(
      options.workspace ?? "../default_workspace",
      options.agent,
    );
    const history = await ConversationHistory.open(config.history_path);
    const sessionId = randomUUID();
    await history.createSession(definition.id, sessionId);
    return new Agent(config, definition, history, sessionId);
  }

  async chat(input: string, signal?: AbortSignal): Promise<string> {
    if (this.replying) throw new Error("An Agent reply is already in progress.");
    this.replying = true;
    try {
      const user: Message = { role: "user", content: input };
      await this.history.saveMessage(this.sessionId, user);
      const pending: Message[] = [user];
      while (true) {
        const reply = await this.model.reply([...this.messages, ...pending], toolSchemas, signal);
        await this.history.saveMessage(this.sessionId, reply);
        pending.push(reply);
        if (!reply.tool_calls?.length) {
          this.messages.push(...pending);
          return reply.content;
        }
        for (const call of reply.tool_calls) {
          const result: Message = {
            role: "tool",
            tool_call_id: call.id,
            content: await executeTool(call, signal),
          };
          await this.history.saveMessage(this.sessionId, result);
          pending.push(result);
        }
        this.messages.push(...pending);
        pending.length = 0;
      }
    } finally {
      this.replying = false;
    }
  }
}
