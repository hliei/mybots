import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Bot, BotConfiguration } from "@mybots/contracts";

export class ProductDatabase {
  private readonly database: DatabaseSync;

  constructor(file: string) {
    this.database = new DatabaseSync(file);
    this.database.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS spaces (id TEXT PRIMARY KEY);
      INSERT OR IGNORE INTO spaces VALUES ('default');
      CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id),
        name TEXT NOT NULL, instructions TEXT NOT NULL, model TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY, bot_id TEXT NOT NULL UNIQUE REFERENCES bots(id),
        conversation_id INTEGER NOT NULL UNIQUE
      );`);
  }

  bots(): Bot[] {
    return this.database
      .prepare(`SELECT bots.id, name, instructions, model,
      threads.id AS threadId, conversation_id AS conversationId
      FROM bots JOIN threads ON threads.bot_id = bots.id ORDER BY bots.rowid`)
      .all() as unknown as Bot[];
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

  close(): void {
    this.database.close();
  }
}
