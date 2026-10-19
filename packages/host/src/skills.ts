import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { BotRequestError } from "./bots.ts";

export interface SkillSelection {
  id: string;
  revision: string;
}
interface SkillRevision extends SkillSelection {
  files: { path: string; base64: string; executable?: true }[];
}
const validId = (id: string) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id);

export function parseSkills(value: unknown): SkillSelection[] {
  if (!Array.isArray(value) || value.length > 64)
    throw new BotRequestError("Select up to 64 local Skill revisions.");
  const skills = value.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new BotRequestError("Select a Skill ID and revision.");
    const entry = item as Record<string, unknown>;
    if (
      Object.keys(entry).some((key) => key !== "id" && key !== "revision") ||
      typeof entry.id !== "string" ||
      !validId(entry.id) ||
      typeof entry.revision !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.revision)
    )
      throw new BotRequestError("Select a Skill ID and revision.");
    return { id: entry.id, revision: entry.revision };
  });
  if (new Set(skills.map((skill) => skill.id)).size !== skills.length)
    throw new BotRequestError("Select each Skill ID only once.");
  return skills;
}

/** Host-owned snapshots are outside all writable container mounts. */
export class LocalSkills {
  private readonly root: string;
  constructor(root: string) {
    this.root = root;
  }

  private directory(botId: string): string {
    if (!validId(botId)) throw new BotRequestError("Invalid Bot ID.");
    return join(this.root, "data", "skills", botId);
  }

  list(botId: string): SkillRevision[] {
    const directory = this.directory(botId);
    let files: string[];
    try {
      files = readdirSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return files
      .sort()
      .filter((file) => file.endsWith(".json"))
      .map((file) => JSON.parse(readFileSync(join(directory, file), "utf8")) as SkillRevision);
  }

  selected(botId: string, skills: SkillSelection[]): SkillRevision[] {
    const revisions = this.list(botId);
    return skills.map((selection) => {
      const revision = revisions.find(
        (item) => item.id === selection.id && item.revision === selection.revision,
      );
      if (!revision)
        throw new BotRequestError(
          "Import and inspect this Bot's Skill revision before activation.",
        );
      return revision;
    });
  }

  materialize(botId: string, revisions: Readonly<Record<string, string>>, directory: string): void {
    const selected = this.selected(
      botId,
      Object.entries(revisions).map(([id, revision]) => ({ id, revision })),
    );
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
    for (const skill of selected) {
      for (const file of skill.files) {
        const target = join(directory, skill.id, file.path);
        mkdirSync(join(target, ".."), { recursive: true });
        writeFileSync(target, Buffer.from(file.base64, "base64"), {
          mode: file.executable ? 0o555 : 0o444,
        });
      }
    }
  }

  import(botId: string, value: unknown): SkillRevision {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new BotRequestError("Import requires a Skill ID and absolute local directory.");
    const input = value as Record<string, unknown>;
    if (
      Object.keys(input).some((key) => key !== "id" && key !== "path") ||
      typeof input.id !== "string" ||
      !validId(input.id) ||
      typeof input.path !== "string" ||
      !isAbsolute(input.path)
    )
      throw new BotRequestError("Import requires a Skill ID and absolute local directory.");
    try {
      const source = realpathSync(input.path);
      if (lstatSync(input.path).isSymbolicLink()) throw new Error();
      const files: SkillRevision["files"] = [];
      let bytes = 0;
      let entries = 0;
      const visit = (directory: string, relative: string) => {
        if (relative.split("/").length > 16) throw new Error();
        for (const name of readdirSync(directory).sort()) {
          if (++entries > 512) throw new Error();
          const path = join(directory, name);
          const info = lstatSync(path);
          const file = relative ? `${relative}/${name}` : name;
          if (info.isSymbolicLink()) throw new Error();
          if (info.isDirectory()) visit(path, file);
          else {
            if (!info.isFile() || info.size + bytes > 4 * 1024 * 1024 || files.length >= 256)
              throw new Error();
            const content = readFileSync(path);
            bytes += content.length;
            if (bytes > 4 * 1024 * 1024) throw new Error();
            files.push({
              path: file,
              base64: content.toString("base64"),
              ...(info.mode & 0o111 ? { executable: true as const } : {}),
            });
          }
        }
      };
      visit(source, "");
      if (!files.some((file) => file.path === "SKILL.md")) throw new Error();
      const revision = createHash("sha256").update(JSON.stringify(files)).digest("hex");
      const result = { id: input.id, revision, files };
      const directory = this.directory(botId);
      mkdirSync(directory, { recursive: true });
      const target = join(directory, `${input.id}-${revision}.json`);
      const temporary = join(directory, `${randomUUID()}.tmp`);
      try {
        writeFileSync(temporary, JSON.stringify(result), { flag: "wx", mode: 0o444 });
        renameSync(temporary, target);
      } finally {
        rmSync(temporary, { force: true });
      }
      return result;
    } catch {
      throw new BotRequestError(
        "Cannot import Skill. Use a readable real directory containing SKILL.md, no links or special files, at most 256 files and 4 MiB.",
      );
    }
  }
}
