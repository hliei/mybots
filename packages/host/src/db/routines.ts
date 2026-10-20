import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ChatRequestError } from "../chat.ts";
import type { routineInput } from "../routines.ts";

export interface Routine {
  id: string;
  requestId: string;
  botId: string;
  text: string;
  runAt: string;
  timezone: string;
  nextOccurrence: string | null;
  selectedMessageIds: string[];
  source: { kind: "owner" } | { kind: "run"; taskId: string; runId: string; attemptId: string };
  createdAt: string;
  taskId: string | null;
}

/** Durable schedule definitions; occurrence execution belongs to ThreadStore. */
export class RoutineStore {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  list(botId: string): Routine[] {
    return this.db
      .prepare(`SELECT r.*, o.task_id, s.task_id AS source_task_id
      FROM routines r LEFT JOIN routine_occurrences o ON o.routine_id = r.id
      LEFT JOIN runs s ON s.id = r.source_run_id WHERE r.bot_id = ? ORDER BY r.rowid`)
      .all(botId)
      .map((row) => ({
        id: row.id as string,
        requestId: row.request_id as string,
        botId,
        text: row.text as string,
        runAt: row.run_at as string,
        timezone: row.timezone as string,
        nextOccurrence: row.next_occurrence as string | null,
        selectedMessageIds: JSON.parse(row.selected_message_ids as string),
        source: row.source_run_id
          ? {
              kind: "run" as const,
              taskId: row.source_task_id as string,
              runId: row.source_run_id as string,
              attemptId: row.source_attempt_id as string,
            }
          : { kind: "owner" as const },
        createdAt: row.created_at as string,
        taskId: row.task_id as string | null,
      }));
  }

  create(
    botId: string,
    input: ReturnType<typeof routineInput>,
    now: string,
    source?: { runId: string; attemptId: string },
  ): Routine {
    const prior = this.db
      .prepare("SELECT bot_id, source_run_id FROM routines WHERE request_id = ?")
      .get(input.requestId);
    if (prior) {
      if (prior.bot_id !== botId || prior.source_run_id !== (source?.runId ?? null))
        throw new ChatRequestError("This requestId belongs to another operation.", 409);
      const saved = this.list(botId).find((row) => row.requestId === input.requestId) as Routine;
      if (
        !source &&
        (saved.text !== input.text ||
          saved.runAt !== input.runAt ||
          saved.timezone !== input.timezone ||
          JSON.stringify(saved.selectedMessageIds) !== JSON.stringify(input.selectedMessageIds))
      )
        throw new ChatRequestError("This requestId belongs to another operation.", 409);
      return saved;
    }
    if (
      this.db
        .prepare(
          "SELECT id FROM agent_publications WHERE id = ? UNION SELECT id FROM owner_questions WHERE id = ?",
        )
        .get(input.requestId, input.requestId)
    )
      throw new ChatRequestError("This requestId belongs to another operation.", 409);
    for (const id of input.selectedMessageIds) {
      if (
        !this.db
          .prepare(
            `SELECT m.id FROM thread_messages m JOIN threads t ON t.id = m.thread_id WHERE m.id = ? AND t.bot_id = ?`,
          )
          .get(id, botId)
      )
        throw new ChatRequestError("Selected message was not found on this Thread.", 404);
    }
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO routines VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id,
        input.requestId,
        botId,
        input.text,
        input.runAt,
        input.timezone,
        input.runAt,
        JSON.stringify(input.selectedMessageIds),
        source?.runId ?? null,
        source?.attemptId ?? null,
        now,
      );
    return this.list(botId).find((row) => row.id === id) as Routine;
  }

  due(now: string): Routine[] {
    const bots = this.db
      .prepare("SELECT DISTINCT bot_id FROM routines WHERE next_occurrence <= ?")
      .all(now);
    return bots
      .flatMap((row) => this.list(row.bot_id as string))
      .filter((row) => row.nextOccurrence !== null && row.nextOccurrence <= now);
  }
}
