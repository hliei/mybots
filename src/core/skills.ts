import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

export interface Skill {
  /** Skill directory name, which identifies the Skill when loading it. */
  id: string;
  name: string;
  description: string;
  /** Instruction body without frontmatter. */
  content: string;
}

export class UnknownSkillError extends Error {
  constructor(id: string) {
    super(`Skill not found: ${id}`);
    this.name = "UnknownSkillError";
  }
}

/**
 * Discovers Skill definitions in the configured Skills directory. Each Skill is
 * a directory containing `SKILL.md` with `name` and `description` frontmatter
 * followed by its instructions.
 */
export class SkillLoader {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async discover(): Promise<Skill[]> {
    try {
      const entries = await readdir(this.path, { withFileTypes: true });
      const skills: Skill[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skill = await this.read(entry.name);
        if (skill) skills.push(skill);
      }
      return skills;
    } catch {
      return [];
    }
  }

  async load(id: string): Promise<Skill> {
    const skills = await this.discover();
    for (const skill of skills) {
      if (skill.id === id) return skill;
    }
    throw new UnknownSkillError(id);
  }

  private async read(id: string): Promise<Skill | undefined> {
    let source: string;
    try {
      source = (await readFile(join(this.path, id, "SKILL.md"), "utf8")).replace(/\r\n/g, "\n");
    } catch {
      return undefined;
    }
    const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(source);
    let metadata: unknown = {};
    if (frontmatter) {
      try {
        metadata = parse(frontmatter[1]);
      } catch {
        return undefined;
      }
    }
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
    const fields = metadata as Record<string, unknown>;
    if (typeof fields.name !== "string" || typeof fields.description !== "string") return undefined;
    return {
      id,
      name: fields.name,
      description: fields.description,
      content: (frontmatter?.[2] ?? source).trim(),
    };
  }
}
