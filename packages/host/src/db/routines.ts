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
  paused: boolean;
  deletedAt: string | null;
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
        paused: row.paused === 1,
        deletedAt: (row.deleted_at as string | null) ?? null,
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
      .prepare(
        `INSERT INTO routines (
 id, request_id, bot_id, text, run_at, timezone, next_occurrence,
 selected_message_ids, source_run_id, source_attempt_id, created_at, cron
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
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

  /** Future admissions use the saved definition. Admitted occurrence snapshots stay fixed. */
  update(
    botId: string,
    routineId: string,
    input: ReturnType<typeof routineInput> & { selectedProvided: boolean },
    now: string,
  ): Routine & { replayed: boolean } {
    let replayed = false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.require(botId, routineId);
      const selected = input.selectedProvided
        ? input.selectedMessageIds
        : current.selectedMessageIds;
      const fingerprint = JSON.stringify({
        text: input.text,
        cron: input.cron,
        runAt: input.cron ? null : input.runAt,
        timezone: input.cron ? null : input.timezone,
        selectedMessageIds: selected,
      });
      replayed = this.claim(botId, routineId, input.requestId, "update", fingerprint);
      if (!replayed) {
        if (current.deletedAt) throw new ChatRequestError("Routine is deleted.", 409);
        if (Boolean(current.cron) !== Boolean(input.cron))
          throw new ChatRequestError("Routine schedule kind cannot change.", 409);
        for (const id of selected) {
          if (
            !this.db
              .prepare(
                `SELECT m.id FROM thread_messages m JOIN threads t ON t.id = m.thread_id WHERE m.id = ? AND t.bot_id = ?`,
              )
              .get(id, botId)
          )
            throw new ChatRequestError("Selected message was not found on this Thread.", 404);
        }
        const armed = current.nextOccurrence !== null;
        const next = !armed
          ? null
          : input.cron
            ? nextCron(input.cron, input.timezone, now)
            : input.runAt;
        const keepResolvedInstant = Boolean(input.cron) && current.occurrences.length > 0;
        const runAt = input.cron
          ? keepResolvedInstant || !armed
            ? current.runAt
            : next
          : input.runAt;
        const timezone = input.cron ? current.timezone : input.timezone;
        this.db
          .prepare(
            `UPDATE routines SET text = ?, cron = ?, run_at = ?, timezone = ?, next_occurrence = ?,
 selected_message_ids = ? WHERE id = ?`,
          )
          .run(input.text, input.cron, runAt, timezone, next, JSON.stringify(selected), routineId);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { ...(this.list(botId).find((row) => row.id === routineId) as Routine), replayed };
  }

  /** Pause blocks automatic admission. Resume recomputes only a missed cron slot. */
  setPaused(
    botId: string,
    routineId: string,
    requestId: string,
    paused: boolean,
    now: string,
  ): Routine & { replayed: boolean } {
    let replayed = false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.require(botId, routineId);
      replayed = this.claim(botId, routineId, requestId, paused ? "pause" : "resume", "");
      if (!replayed) {
        if (current.deletedAt) throw new ChatRequestError("Routine is deleted.", 409);
        let next = current.nextOccurrence;
        if (!paused && current.cron && !routineBusy(this.db, routineId)) {
          if (next === null || next <= now) next = nextCron(current.cron, current.timezone, now);
        }
        this.db
          .prepare("UPDATE routines SET paused = ?, next_occurrence = ? WHERE id = ?")
          .run(paused ? 1 : 0, next, routineId);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { ...(this.list(botId).find((row) => row.id === routineId) as Routine), replayed };
  }

  /** Logical deletion keeps the definition and cancels future automatic admission. */
  markDeleted(
    botId: string,
    routineId: string,
    requestId: string,
    now: string,
  ): Routine & { replayed: boolean } {
    let replayed = false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.require(botId, routineId);
      replayed = this.claim(botId, routineId, requestId, "delete", "");
      if (!replayed)
        this.db
          .prepare(
            "UPDATE routines SET deleted_at = COALESCE(deleted_at, ?), next_occurrence = NULL WHERE id = ?",
          )
          .run(now, routineId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { ...(this.list(botId).find((row) => row.id === routineId) as Routine), replayed };
  }

  findCommand(botId: string, requestId: string): Routine | undefined {
    const row = this.db
      .prepare("SELECT routine_id FROM routine_commands WHERE request_id = ? AND bot_id = ?")
      .get(requestId, botId) as { routine_id: string } | undefined;
    return row ? this.list(botId).find((routine) => routine.id === row.routine_id) : undefined;
  }

  unfinished(routineId: string): { id: string; state: string }[] {
    return this.db
      .prepare(
        `SELECT w.id AS id, w.state AS state FROM routine_occurrences o
 JOIN runs w ON w.task_id = o.task_id
 WHERE o.routine_id = ? AND w.state IN ('queued', 'active', 'waiting', 'stopping', 'uncertain')`,
      )
      .all(routineId) as { id: string; state: string }[];
  }

  private require(botId: string, routineId: string): Routine {
    const routine = this.list(botId).find((row) => row.id === routineId);
    if (!routine) throw new ChatRequestError("Routine not found.", 404);
    return routine;
  }

  /** Record one owner or scoped command. A matching retry does not apply it again. */
  private claim(
    botId: string,
    routineId: string,
    requestId: string,
    action: string,
    fingerprint: string,
  ): boolean {
    const prior = this.db
      .prepare("SELECT * FROM routine_commands WHERE request_id = ?")
      .get(requestId) as
      | { routine_id: string; bot_id: string; action: string; fingerprint: string }
      | undefined;
    if (prior) {
      if (
        prior.routine_id !== routineId ||
        prior.bot_id !== botId ||
        prior.action !== action ||
        prior.fingerprint !== fingerprint
      )
        throw new ChatRequestError("This requestId belongs to another operation.", 409);
      return true;
    }
    if (
      this.db.prepare("SELECT id FROM routines WHERE request_id = ?").get(requestId) ||
      this.db
        .prepare("SELECT request_id FROM timezone_updates WHERE request_id = ?")
        .get(requestId) ||
      this.db
        .prepare(
          "SELECT id FROM agent_publications WHERE id = ? UNION SELECT id FROM owner_questions WHERE id = ?",
        )
        .get(requestId, requestId)
    )
      throw new ChatRequestError("This requestId belongs to another operation.", 409);
    this.db
      .prepare("INSERT INTO routine_commands VALUES (?, ?, ?, ?, ?)")
      .run(requestId, routineId, botId, action, fingerprint);
    return false;
  }

  /** Arm only after known terminal outcomes and confirmed execution stop. */
  rearm(now: string): void {
    const rows = this.db
      .prepare(
        "SELECT * FROM routines WHERE cron IS NOT NULL AND next_occurrence IS NULL AND paused = 0 AND deleted_at IS NULL",
      )
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
          row.nextOccurrence !== null &&
          row.nextOccurrence <= now &&
          !row.paused &&
          !row.deletedAt &&
          !routineBusy(this.db, row.id),
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
