import type { Skill, SkillLoader } from "../core/skills.ts";
import { UnknownSkillError } from "../core/skills.ts";
import type { Tool } from "./toolbox.ts";

const skillToolName = "skill";

/** Builds the reference `skill` tool for the Skills discovered at registration. */
export function createSkillTool(loader: SkillLoader, skills: Skill[]): Tool {
  const definitions = skills
    .map((skill) => `  <skill name="${skill.name}">${skill.description}</skill>`)
    .join("\n");
  return {
    name: skillToolName,
    description: `Load and invoke a specialized skill. <skills>\n${definitions}\n</skills>`,
    arguments: [
      {
        name: "skill_name",
        description: "The name of the skill to load",
        enum: skills.map((skill) => skill.id),
      },
    ],
    async execute({ skill_name }) {
      try {
        return (await loader.load(skill_name)).content;
      } catch (error) {
        if (!(error instanceof UnknownSkillError)) throw error;
        return `Error: Skill '${skill_name}' not found. It may have been removed or is unavailable.`;
      }
    },
  };
}
