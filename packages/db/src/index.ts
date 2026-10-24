import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Bot, BotConfiguration, MemoryDocument, MemoryScope, Skill } from "@mybots/contracts";
import { markdownContent, skillContent } from "@mybots/contracts";

const builtinSkills: Skill[] = [
  {
    name: "resource-maintenance",
    description: "Deliberately maintain shared Skills and scoped Markdown memory.",
    readOnly: true,
    content:
      "Use memory_read before memory_write to preserve useful records. Store only deliberately retained facts and preferences, not copied conversation history. Scope bot is private to the current Bot; owner is shared across Bots. Writes replace the document. Use memory_delete to remove current memory; earlier transcript entries remain. Use skill_write to create or replace a shared user Skill and skill_delete to remove it. Built-in Skills are read-only. Resource edits affect later context loads; use skill_read for full Skill instructions.",
  },
];

export class ProductDatabase {
  private readonly database: DatabaseSync;

  constructor(file: string) {
    this.database = new DatabaseSync(file);
    this.database.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS spaces (id TEXT PRIMARY KEY);
      INSERT OR IGNORE INTO spaces VALUES ('default');
      CREATE TABLE IF NOT EXISTS computers (
        space_id TEXT PRIMARY KEY REFERENCES spaces(id), id TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id),
        name TEXT NOT NULL, instructions TEXT NOT NULL, model TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY, bot_id TEXT NOT NULL UNIQUE REFERENCES bots(id),
        conversation_id INTEGER NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS skills (
        space_id TEXT NOT NULL REFERENCES spaces(id), name TEXT NOT NULL,
        description TEXT NOT NULL, content TEXT NOT NULL,
        PRIMARY KEY (space_id, name)
      );
      CREATE TABLE IF NOT EXISTS memory (
        space_id TEXT NOT NULL REFERENCES spaces(id), scope TEXT NOT NULL,
        bot_id TEXT REFERENCES bots(id), content TEXT NOT NULL,
        CHECK ((scope = 'owner' AND bot_id IS NULL) OR (scope = 'bot' AND bot_id IS NOT NULL))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS memory_scope ON memory (space_id, scope, COALESCE(bot_id, ''));`);
  }

  bots(): Bot[] {
    return this.database
      .prepare(`SELECT bots.id, name, instructions, model,
      threads.id AS threadId, conversation_id AS conversationId
      FROM bots JOIN threads ON threads.bot_id = bots.id ORDER BY bots.rowid`)
      .all() as unknown as Bot[];
  }

  computer(): { id: string } {
    this.database
      .prepare("INSERT OR IGNORE INTO computers VALUES ('default', ?)")
      .run(`mybots-${randomUUID()}`);
    return this.database
      .prepare("SELECT id FROM computers WHERE space_id = 'default'")
      .get() as unknown as { id: string };
  }

  bot(id: string): Bot {
    const bot = this.bots().find((item) => item.id === id);
    if (!bot) throw new Error("Bot not found");
    return bot;
  }

  create(configuration: BotConfiguration, conversationId: number): Bot {
    const id = randomUUID();
    const threadId = randomUUID();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare("INSERT INTO bots VALUES (?, 'default', ?, ?, ?)")
        .run(id, configuration.name, configuration.instructions, configuration.model);
      this.database
        .prepare("INSERT INTO threads VALUES (?, ?, ?)")
        .run(threadId, id, conversationId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.bot(id);
  }

  update(id: string, configuration: BotConfiguration): Bot {
    this.bot(id);
    this.database
      .prepare("UPDATE bots SET name = ?, instructions = ?, model = ? WHERE id = ?")
      .run(configuration.name, configuration.instructions, configuration.model, id);
    return this.bot(id);
  }

  skills(): Skill[] {
    const rows = this.database
      .prepare(
        "SELECT name, description, content FROM skills WHERE space_id = 'default' ORDER BY name",
      )
      .all() as unknown as Omit<Skill, "readOnly">[];
    return [
      ...builtinSkills.map((skill) => ({ ...skill })),
      ...rows.map((skill) => ({ ...skill, readOnly: false })),
    ];
  }

  skill(name: string): Skill {
    const skill = this.skills().find((skill) => skill.name === name);
    if (!skill) throw new Error("Skill not found");
    return skill;
  }

  writeSkill(name: string, value: unknown): Skill {
    if (builtinSkills.some((skill) => skill.name === name))
      throw new Error("Built-in Skills are read-only");
    const skill = skillContent(name, value);
    this.database
      .prepare(`INSERT INTO skills VALUES ('default', ?, ?, ?)
      ON CONFLICT (space_id, name) DO UPDATE SET description = excluded.description, content = excluded.content`)
      .run(name, skill.description, skill.content);
    return this.skill(name);
  }

  deleteSkill(name: string): void {
    if (this.skill(name).readOnly) throw new Error("Built-in Skills are read-only");
    this.database.prepare("DELETE FROM skills WHERE space_id = 'default' AND name = ?").run(name);
  }

  memory(scope: MemoryScope, botId?: string): MemoryDocument {
    const id = this.memoryBot(scope, botId);
    const row = this.database
      .prepare(
        "SELECT content FROM memory WHERE space_id = 'default' AND scope = ? AND bot_id IS ?",
      )
      .get(scope, id) as unknown as MemoryDocument | undefined;
    return row ?? { content: "" };
  }

  writeMemory(scope: MemoryScope, content: unknown, botId?: string): MemoryDocument {
    const id = this.memoryBot(scope, botId);
    const markdown = markdownContent(content);
    this.database
      .prepare(`INSERT INTO memory VALUES ('default', ?, ?, ?)
      ON CONFLICT DO UPDATE SET content = excluded.content`)
      .run(scope, id, markdown);
    return { content: markdown };
  }

  deleteMemory(scope: MemoryScope, botId?: string): void {
    const id = this.memoryBot(scope, botId);
    this.database
      .prepare("DELETE FROM memory WHERE space_id = 'default' AND scope = ? AND bot_id IS ?")
      .run(scope, id);
  }

  private memoryBot(scope: MemoryScope, botId?: string): string | null {
    if (scope === "owner" && botId === undefined) return null;
    if (scope === "bot" && botId) return this.bot(botId).id;
    throw new Error("Invalid memory scope");
  }

  close(): void {
    this.database.close();
  }
}
