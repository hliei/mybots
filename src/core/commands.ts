import type { SkillLoader } from "./skills.ts";
import { UnknownSkillError } from "./skills.ts";

/** Session inspection values and the explicit compaction action. */
export interface CommandContext {
  sessionId: string;
  agentName: string;
  agentId: string;
  createdAt: string;
  messageCount: number;
  skills: SkillLoader;
  contextReport(): string;
  compact(): Promise<string>;
}

export interface Command {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly description: string;
  execute(args: string, context: CommandContext, registry: CommandRegistry): Promise<string>;
}

/**
 * Resolves slash commands: the command name is
 * case-insensitive, arguments keep their case, and input that is not a
 * registered command falls through to ordinary chat.
 */
export class CommandRegistry {
  private readonly commands = new Map<string, Command>();

  register(command: Command): void {
    for (const name of commandNames(command)) this.commands.set(name, command);
  }

  /** Commands in registration order, aliases resolved to their single command. */
  listCommands(): Command[] {
    const seen = new Set<string>();
    const commands: Command[] = [];
    for (const command of this.commands.values()) {
      if (seen.has(command.name)) continue;
      seen.add(command.name);
      commands.push(command);
    }
    return commands;
  }

  resolve(input: string): { command: Command; args: string } | undefined {
    if (!input.startsWith("/")) return undefined;
    const body = input.slice(1).trimStart();
    if (!body) return undefined;
    const separator = body.search(/\s/);
    const name = (separator === -1 ? body : body.slice(0, separator)).toLowerCase();
    const command = this.commands.get(name);
    if (!command) return undefined;
    return { command, args: separator === -1 ? "" : body.slice(separator).trim() };
  }

  async dispatch(input: string, context: CommandContext): Promise<string | undefined> {
    const resolved = this.resolve(input);
    if (!resolved) return undefined;
    return resolved.command.execute(resolved.args, context, this);
  }
}

/** A command's name and aliases, which resolve to the same command. */
function commandNames(command: Command): string[] {
  return [command.name, ...(command.aliases ?? [])];
}

const helpCommand: Command = {
  name: "help",
  aliases: ["?"],
  description: "Show available commands",
  async execute(_args, _context, registry) {
    const lines = ["**Available Commands:**"];
    for (const command of registry.listCommands()) {
      const names = commandNames(command).map((name) => `/${name}`);
      lines.push(`${names.join(", ")} - ${command.description}`);
    }
    return lines.join("\n");
  },
};

const sessionCommand: Command = {
  name: "session",
  description: "Show current session details",
  async execute(_args, context) {
    return [
      `**Session ID:** \`${context.sessionId}\``,
      `**Agent:** ${context.agentName} (\`${context.agentId}\`)`,
      `**Created:** ${context.createdAt}`,
      `**Messages:** ${context.messageCount}`,
    ].join("\n");
  },
};

/**
 * Lists discovered Skills or shows one Skill's instructions. Reading a Skill
 * never registers the skill tool, loads instructions into active context, or
 * changes `allow_skills`; it only returns text to the caller.
 */
const skillsCommand: Command = {
  name: "skills",
  description: "List all skills or show skill details",
  async execute(args, context) {
    if (!args) {
      const skills = await context.skills.discover();
      if (!skills.length) return "No skills configured.";
      return [
        "**Skills:**",
        ...skills.map((skill) => `- \`${skill.id}\`: ${skill.description}`),
      ].join("\n");
    }
    try {
      const skill = await context.skills.load(args);
      return [
        `**Skill:** \`${skill.id}\``,
        `**Name:** ${skill.name}`,
        `**Description:** ${skill.description}`,
        "",
        "---",
        "",
        "**SKILL.md:**",
        "```",
        skill.content,
        "```",
      ].join("\n");
    } catch (error) {
      if (!(error instanceof UnknownSkillError)) throw error;
      return `✗ Skill \`${args}\` not found.`;
    }
  },
};

const compactCommand: Command = {
  name: "compact",
  description: "Summarize older active context",
  async execute(_args, context) {
    return context.compact();
  },
};

const contextCommand: Command = {
  name: "context",
  description: "Show active context and token budget",
  async execute(_args, context) {
    return context.contextReport();
  },
};

/** The slash commands available to an interactive CLI session. */
export function sessionCommands(): CommandRegistry {
  const registry = new CommandRegistry();
  registry.register(helpCommand);
  registry.register(skillsCommand);
  registry.register(sessionCommand);
  registry.register(contextCommand);
  registry.register(compactCommand);
  return registry;
}
