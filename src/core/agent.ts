import { randomUUID } from "node:crypto";
import type { AgentDefinition, WorkspaceSettings } from "../config/workspace.ts";
import { loadSettings } from "../config/workspace.ts";
import { DeepSeek } from "../providers/deepseek.ts";
import { builtinTools } from "../tools/builtin.ts";
import { createSkillTool } from "../tools/skill.ts";
import { Toolbox } from "../tools/toolbox.ts";
import type { Message } from "./messages.ts";
import { SkillLoader } from "./skills.ts";

export class Agent {
  readonly config: WorkspaceSettings;
  readonly definition: AgentDefinition;
  readonly sessionId = randomUUID();
  private readonly model: DeepSeek;
  private readonly toolbox: Toolbox;
  private readonly messages: Message[];
  private replying = false;

  private constructor(config: WorkspaceSettings, definition: AgentDefinition, toolbox: Toolbox) {
    this.config = config;
    this.definition = definition;
    this.model = new DeepSeek(definition.llm);
    this.toolbox = toolbox;
    this.messages = [{ role: "system", content: definition.agent_md }];
  }

  static async open(options: { workspace?: string; agent?: string } = {}): Promise<Agent> {
    const { config, definition } = await loadSettings(
      options.workspace ?? "../default_workspace",
      options.agent,
    );
    return new Agent(config, definition, await buildToolbox(config, definition));
  }

  async chat(input: string, signal?: AbortSignal): Promise<string> {
    if (this.replying) throw new Error("An Agent reply is already in progress.");
    this.replying = true;
    try {
      const user: Message = { role: "user", content: input };
      const pending: Message[] = [user];
      while (true) {
        const reply = await this.model.reply(
          [...this.messages, ...pending],
          this.toolbox.schemas,
          signal,
        );
        pending.push(reply);
        if (!reply.tool_calls?.length) {
          this.messages.push(...pending);
          return reply.content;
        }
        for (const call of reply.tool_calls) {
          pending.push({
            role: "tool",
            tool_call_id: call.id,
            content: await this.toolbox.execute(call, signal),
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

async function buildToolbox(
  config: WorkspaceSettings,
  definition: AgentDefinition,
): Promise<Toolbox> {
  const tools = [...builtinTools];
  if (definition.allow_skills) {
    const loader = new SkillLoader(config.skills_path);
    const skills = await loader.discover();
    if (skills.length) tools.push(createSkillTool(loader, skills));
  }
  return new Toolbox(tools);
}
