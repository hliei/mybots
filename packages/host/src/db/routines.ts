import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ChatRequestError } from "../chat.ts";
import { nextCron, type routineInput } from "../routines.ts";

export interface Routine {
  id: string;
  requestId: string;
  botId: string;
  text: string;
  runAt: string;
  cron: string | null;
  occurrences: { taskId: string; dueAt: string }[];
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

  timezone(botId: string): string {
    return (
      (this.db.prepare("SELECT timezone FROM bot_timezones WHERE bot_id = ?").get(botId)
        ?.timezone as string | undefined) ?? "Asia/Shanghai"
    );
  }

  setTimezone(botId: string, requestId: string, timezone: string, now: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db
        .prepare("SELECT * FROM timezone_updates WHERE request_id = ?")
        .get(requestId);
      if (prior) {
        if (prior.bot_id !== botId || prior.timezone !== timezone)
          throw new ChatRequestError("This requestId belongs to another operation.", 409);
      } else {
        this.db
          .prepare(
            "INSERT INTO bot_timezones VALUES (?, ?) ON CONFLICT(bot_id) DO UPDATE SET timezone = excluded.timezone",
          )
          .run(botId, timezone);
        for (const routine of this.list(botId)) {
          if (!routine.cron) continue;
          this.db
            .prepare("UPDATE routines SET timezone = ?, next_occurrence = ? WHERE id = ?")
            .run(
              timezone,
              routine.nextOccurrence ? nextCron(routine.cron, timezone, now) : null,
              routine.id,
            );
        }
        this.db
          .prepare("INSERT INTO timezone_updates VALUES (?, ?, ?)")
          .run(requestId, botId, timezone);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  list(botId: string): Routine[] {
    return this.db
      .prepare(`SELECT r.*, o.task_id, s.task_id AS source_task_id
      FROM routines r LEFT JOIN routine_occurrences o ON o.task_id =
        (SELECT task_id FROM routine_occurrences WHERE routine_id = r.id ORDER BY rowid DESC LIMIT 1)
      LEFT JOIN runs s ON s.id = r.source_run_id WHERE r.bot_id = ? ORDER BY r.rowid`)
      .all(botId)
      .map((row) => ({
        id: row.id as string,
        requestId: row.request_id as string,
        botId,
        text: row.text as string,
        runAt: row.run_at as string,
        cron: row.cron as string | null,
        occurrences: this.db
          .prepare(
            "SELECT task_id AS taskId, due_at AS dueAt FROM routine_occurrences WHERE routine_id = ? ORDER BY rowid",
          )
          .all(row.id as string) as unknown as { taskId: string; dueAt: string }[],
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
          saved.cron !== input.cron ||
          (!input.cron && (saved.runAt !== input.runAt || saved.timezone !== input.timezone)) ||
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
      .prepare(`INSERT INTO routines VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
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
        input.cron,
      );
    return this.list(botId).find((row) => row.id === id) as Routine;
  }

  /** Arm only after known terminal outcomes and confirmed execution stop. */
  rearm(now: string): void {
    const rows = this.db
      .prepare("SELECT * FROM routines WHERE cron IS NOT NULL AND next_occurrence IS NULL")
      .all();
    for (const row of rows) {
      if (routineBusy(this.db, row.id as string)) continue;
      this.db
        .prepare("UPDATE routines SET next_occurrence = ? WHERE id = ?")
        .run(nextCron(row.cron as string, row.timezone as string, now), row.id as string);
    }
  }

  due(now: string): Routine[] {
    const bots = this.db
      .prepare("SELECT DISTINCT bot_id FROM routines WHERE next_occurrence <= ?")
      .all(now);
    return bots
      .flatMap((row) => this.list(row.bot_id as string))
      .filter(
        (row) =>
          row.nextOccurrence !== null && row.nextOccurrence <= now && !routineBusy(this.db, row.id),
      );
  }
}

/** Task lifetime and actual execution ownership both exclude another occurrence. */
export function routineBusy(db: DatabaseSync, routineId: string, exceptTaskId = ""): boolean {
  return !!db
    .prepare(`SELECT 1 FROM routine_occurrences o JOIN runs w ON w.task_id = o.task_id
    LEFT JOIN execution_reservations e ON e.run_id = w.id
    WHERE o.routine_id = ? AND o.task_id != ? AND
    (w.state IN ('queued', 'active', 'waiting', 'stopping', 'uncertain') OR e.run_id IS NOT NULL) LIMIT 1`)
    .get(routineId, exceptTaskId);
}
