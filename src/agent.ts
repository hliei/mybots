import { randomUUID } from "node:crypto";
import type { AgentDefinition, WorkspaceSettings } from "./config.ts";
import { loadSettings } from "./config.ts";
import type { Message } from "./model.ts";
import { DeepSeek } from "./model.ts";
import { executeTool } from "./tools.ts";

export class Agent {
  readonly config: WorkspaceSettings;
  readonly definition: AgentDefinition;
  readonly sessionId = randomUUID();
  private readonly model: DeepSeek;
  private readonly messages: Message[];
  private replying = false;

  private constructor(config: WorkspaceSettings, definition: AgentDefinition) {
    this.config = config;
    this.definition = definition;
    this.model = new DeepSeek(definition.llm);
    this.messages = [{ role: "system", content: definition.agent_md }];
  }

  static async open(options: { workspace?: string; agent?: string } = {}): Promise<Agent> {
    const { config, definition } = await loadSettings(
      options.workspace ?? "../default_workspace",
      options.agent,
    );
    return new Agent(config, definition);
  }

  async chat(input: string, signal?: AbortSignal): Promise<string> {
    if (this.replying) throw new Error("An Agent reply is already in progress.");
    this.replying = true;
    try {
      const user: Message = { role: "user", content: input };
      const pending: Message[] = [user];
      while (true) {
        const reply = await this.model.reply([...this.messages, ...pending], signal);
        pending.push(reply);
        if (!reply.tool_calls?.length) {
          this.messages.push(...pending);
          return reply.content;
        }
        for (const call of reply.tool_calls) {
          pending.push({
            role: "tool",
            tool_call_id: call.id,
            content: await executeTool(call, signal),
          });
        }
        this.messages.push(...pending);
        pending.length = 0;
      }
    } finally {
      this.replying = false;
    }
  }
}
