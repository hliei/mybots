import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { InboundMessage, OutboundMessage, ProcessingAck } from "@mybots/mailbox";
import { ChatRequestError } from "../chat.ts";
import { history } from "./history.ts";
import type { SavedSession } from "./index.ts";

const RUN_ACTIVE_BUDGET_MS = 60 * 60 * 1000;

interface ThreadRow {
  id: string;
  bot_id: string;
  background_boundary: number;
  created_at: string;
}
interface RunRow {
  id: string;
  task_id: string;
  state:
    | "queued"
    | "active"
    | "stopping"
    | "succeeded"
    | "failed"
    | "uncertain"
    | "closed"
    | "waiting";
  wait_reason: string | null;
  active_ms: number;
  active_since: string | null;
  budget_exhausted_at: string | null;
  background_boundary: number;
  source_message_id: string;
  context: string | null;
  outcome: string | null;
  created_at: string;
  updated_at: string;
  prior_run_id: string | null;
  stop_error: string | null;
  held: number;
  selected_message_ids: string;
}
interface RunInput {
  rowid: number;
  message_id: string;
  run_id: string;
  content: string;
  admitted_at: string;
  outcome: string | null;
  destination_id: string;
  recorded_at: string | null;
}
interface Original {
  id: string;
  seq: number;
  role: string;
  content: string;
  run_id: string;
  created_at: string;
}

function preview(text: string) {
  const chars = Array.from(text);
  return { text: chars.slice(0, 2000).join(""), truncated: chars.length > 2000 };
}
function publicationPreview(row: {
  id: string;
  attemptId: string;
  text: string;
  createdAt: string;
}) {
  const shown = preview(row.text);
  return {
    id: row.id,
    attemptId: row.attemptId,
    text: shown.text,
    truncated: shown.truncated,
    createdAt: row.createdAt,
  };
}
function outcomePreview(serialized: string | null) {
  if (!serialized) return null;
  const outcome = JSON.parse(serialized);
  return {
    ...outcome,
    reply: preview(outcome.reply).text,
    truncated: preview(outcome.reply).truncated,
  };
}

/** Product conversation and execution identities; SDK state belongs to each Run's executor. */
export class ThreadStore {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  ensureThreads(now: string): void {
    this.db
      .prepare(`INSERT INTO threads SELECT lower(hex(randomblob(16))), id, 0, ? FROM agent_groups
   WHERE id NOT IN (SELECT bot_id FROM threads)`)
      .run(now);
  }
  thread(botId: string): ThreadRow {
    const row = this.db.prepare("SELECT * FROM threads WHERE bot_id = ?").get(botId) as unknown as
      | ThreadRow
      | undefined;
    if (!row) throw new ChatRequestError("Bot not found.", 404);
    return row;
  }
  private admit<T extends object>(requestId: string, payload: object, apply: () => T) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const serialized = JSON.stringify(payload);
      const saved = this.db
        .prepare("SELECT * FROM input_admissions WHERE request_id = ?")
        .get(requestId);
      if (saved && saved.payload !== serialized)
        throw new ChatRequestError("This requestId belongs to another operation.", 409);
      const result: T = saved ? JSON.parse(saved.response as string) : apply();
      if (!saved)
        this.db
          .prepare("INSERT INTO input_admissions VALUES (?, ?, ?)")
          .run(requestId, serialized, JSON.stringify(result));
      this.db.exec("COMMIT");
      return { requestId, ...result, replayed: !!saved };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  send(
    input: {
      requestId: string;
      botId: string;
      text: string;
      newTask: boolean;
      taskId?: string;
      selectedMessageIds?: string[];
    },
    now: string,
    destinationId = "local-client",
  ) {
    return this.admit(input.requestId, { ...input, destinationId }, () => {
      const thread = this.thread(input.botId);
      const selected = input.selectedMessageIds ?? [];
      let run: RunRow | undefined;
      if (input.taskId) {
        run = this.db
          .prepare(`SELECT r.* FROM runs r JOIN tasks t ON t.id = r.task_id
     WHERE t.id = ? AND t.thread_id = ? ORDER BY r.rowid DESC LIMIT 1`)
          .get(input.taskId, thread.id) as unknown as RunRow | undefined;
        if (!run) throw new ChatRequestError("Task not found for this Bot.", 404);
        if (!["queued", "active", "waiting"].includes(run.state))
          throw new ChatRequestError("Task does not accept additions.", 409);
      } else if (!input.newTask) {
        run = this.db
          .prepare(`SELECT r.* FROM runs r JOIN tasks t ON t.id = r.task_id
     WHERE t.thread_id = ? AND r.state IN ('queued', 'active') ORDER BY r.rowid DESC LIMIT 1`)
          .get(thread.id) as unknown as RunRow | undefined;
      }
      const messageId = randomUUID();
      if (run && selected.length)
        throw new ChatRequestError(
          "Older messages can be selected only when starting a conversational Run.",
          409,
        );
      if (!run) {
        for (const id of selected) {
          const found = this.db
            .prepare("SELECT id FROM thread_messages WHERE id = ? AND thread_id = ?")
            .get(id, thread.id);
          if (!found)
            throw new ChatRequestError("Selected message was not found on this Thread.", 404);
        }
        const taskId = randomUUID();
        const runId = randomUUID();
        this.db.prepare("INSERT INTO tasks VALUES (?, ?, 'chat', ?)").run(taskId, thread.id, now);
        this.db
          .prepare(`INSERT INTO messaging_groups (id, channel_type, platform_id, instance, created_at)
     VALUES ('local-client', 'client', 'owner', 'local-client', ?) ON CONFLICT(id) DO NOTHING`)
          .run(now);
        this.db
          .prepare(`INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, purpose, created_at)
     VALUES (?, ?, ?, ?, 'run', ?)`)
          .run(runId, input.botId, destinationId, thread.id, now);
        this.db
          .prepare(`INSERT INTO runs (
 id, task_id, state, background_boundary, source_message_id, context, outcome, created_at, updated_at
) VALUES (?, ?, 'queued', ?, ?, NULL, NULL, ?, ?)`)
          .run(runId, taskId, thread.background_boundary, messageId, now, now);
        this.enqueue(runId, input.botId, now);
        this.db
          .prepare("UPDATE runs SET selected_message_ids = ? WHERE id = ?")
          .run(JSON.stringify(selected), runId);
        run = this.run(runId);
      }
      this.db
        .prepare("INSERT INTO run_inputs VALUES (?, ?, ?, ?, NULL, ?, NULL)")
        .run(messageId, run.id, input.text, now, destinationId);
      this.db
        .prepare(
          `INSERT INTO thread_messages (id, thread_id, run_id, role, content, created_at) VALUES (?, ?, ?, 'user', ?, ?)`,
        )
        .run(messageId, thread.id, run.id, input.text, now);
      return {
        botId: input.botId,
        threadId: thread.id,
        taskId: run.task_id,
        runId: run.id,
        messageId,
      };
    });
  }
  destination(id: string) {
    const row = this.db
      .prepare("SELECT channel_type, platform_id, instance FROM messaging_groups WHERE id = ?")
      .get(id);
    if (!row) throw new ChatRequestError("Destination not found.", 404);
    return {
      channel_type: row.channel_type as string,
      platform_id: row.platform_id as string,
      instance: row.instance as string,
    };
  }
  ownedRun(botId: string, runId: string): RunRow {
    const run = this.run(runId);
    if (this.session(runId).agent_group_id !== botId)
      throw new ChatRequestError("Run not found for this Bot.", 404);
    return run;
  }
  /** Persist an owner stop without waiting for the executor to exit. */
  stop(botId: string, runId: string, requestId: string, now: string) {
    return this.admit(requestId, { operation: "stop", botId, runId }, () =>
      this.markStopping(this.ownedRun(botId, runId), now),
    );
  }
  stopTask(botId: string, taskId: string, requestId: string, now: string) {
    return this.admit(requestId, { operation: "stop", botId, taskId }, () => {
      const run = this.db
        .prepare(`SELECT r.* FROM runs r JOIN tasks t ON t.id = r.task_id
 WHERE t.id = ? AND t.thread_id = ? AND r.state IN ('queued', 'active', 'stopping', 'uncertain', 'waiting')
 ORDER BY r.rowid DESC LIMIT 1`)
        .get(taskId, this.thread(botId).id) as unknown as RunRow | undefined;
      if (!run) throw new ChatRequestError("Task has no running work to stop.", 409);
      return this.markStopping(run, now);
    });
  }
  markStopping(run: RunRow, now: string) {
    if (run.state === "uncertain")
      throw new ChatRequestError("Run is already uncertain. Retry or close it.", 409);
    if (["succeeded", "failed", "closed"].includes(run.state))
      throw new ChatRequestError("Run is already terminal.", 409);
    this.db
      .prepare(
        "UPDATE owner_questions SET state = 'cancelled', resolved_at = ? WHERE run_id = ? AND state IN ('pending', 'expired')",
      )
      .run(now, run.id);
    if (run.state !== "stopping")
      this.db
        .prepare(
          "UPDATE runs SET state = 'stopping', stop_error = NULL, updated_at = ? WHERE id = ?",
        )
        .run(now, run.id);
    return {
      botId: this.session(run.id).agent_group_id,
      taskId: run.task_id,
      runId: run.id,
      operation: "stop" as const,
      state: "stopping" as const,
    };
  }
  markStopUnconfirmed(id: string, error: string, now: string): void {
    this.db
      .prepare("UPDATE runs SET stop_error = ?, updated_at = ? WHERE id = ? AND state = 'stopping'")
      .run(error, now, id);
  }
  finishStop(id: string, acknowledgements: ProcessingAck[], now: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const run = this.run(id);
      if (!["stopping", "queued", "active"].includes(run.state)) {
        this.db.exec("COMMIT");
        return;
      }
      const inputs = this.inputs(id);
      const missing = inputs.filter((row) => !row.outcome);
      const gap = missing.some((input) =>
        acknowledgements.some(
          (ack) => ack.message_id === input.message_id && ack.status !== "processing",
        ),
      );
      let state: RunRow["state"];
      let outcome = run.outcome;
      let held = 0;
      if (!missing.length && inputs.length) {
        const results = inputs.map((row) => JSON.parse(row.outcome as string) as { kind: string });
        const failure = results.find((row) => row.kind === "failed");
        state = failure ? "failed" : "succeeded";
        outcome = JSON.stringify(failure ?? results.at(-1));
      } else if (gap) {
        state = "uncertain";
        held = 1;
        outcome = JSON.stringify({ kind: "uncertain", reply: "Final evidence is missing." });
      } else {
        state = "closed";
        outcome = JSON.stringify({
          kind: "cancelled",
          reply: "Stopped before a final result.",
        });
        for (const input of missing)
          this.db.prepare("UPDATE run_inputs SET outcome = ? WHERE message_id = ?").run(
            JSON.stringify({
              kind: "cancelled",
              messageId: input.message_id,
              reply: "Stopped before a final result.",
              at: now,
            }),
            input.message_id,
          );
      }
      this.db
        .prepare(
          "UPDATE runs SET state = ?, outcome = ?, held = ?, stop_error = NULL, updated_at = ? WHERE id = ?",
        )
        .run(state, outcome, held, now, id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  retry(botId: string, runId: string, requestId: string, now: string) {
    return this.admit(requestId, { operation: "retry", botId, runId }, () => {
      const run = this.ownedRun(botId, runId);
      if (["queued", "active", "stopping"].includes(run.state))
        throw new ChatRequestError("Stop is unconfirmed.", 409);
      if (run.state === "succeeded")
        throw new ChatRequestError("A completed Run is not retried.", 409);
      const open = this.db
        .prepare(
          `SELECT id FROM runs WHERE task_id = ? AND id != ?
 AND state IN ('queued', 'active', 'stopping', 'uncertain', 'waiting')`,
        )
        .get(run.task_id, run.id);
      if (open) throw new ChatRequestError("Task already has an unfinished Run.", 409);
      const outcome =
        run.outcome ?? JSON.stringify({ kind: "uncertain", reply: "Final evidence is missing." });
      this.db
        .prepare(
          "UPDATE runs SET state = 'closed', held = 0, outcome = ?, stop_error = NULL, updated_at = ? WHERE id = ?",
        )
        .run(outcome, now, run.id);
      const inputs = this.inputs(run.id);
      if (!inputs.length) throw new ChatRequestError("Run has no admitted work to retry.", 409);
      const thread = this.thread(botId);
      const newRunId = randomUUID();
      const copied = inputs.map((input) => ({ ...input, messageId: randomUUID() }));
      this.db
        .prepare(`INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, purpose, created_at)
 VALUES (?, ?, ?, ?, 'run', ?)`)
        .run(newRunId, botId, inputs[0]?.destination_id, thread.id, now);
      this.db
        .prepare(`INSERT INTO runs (
 id, task_id, state, background_boundary, source_message_id, context, outcome, created_at, updated_at, prior_run_id
) VALUES (?, ?, 'queued', ?, ?, NULL, NULL, ?, ?, ?)`)
        .run(
          newRunId,
          run.task_id,
          thread.background_boundary,
          copied[0]?.messageId,
          now,
          now,
          run.id,
        );
      this.enqueue(newRunId, botId, now);
      for (const input of copied) {
        this.db
          .prepare("INSERT INTO run_inputs VALUES (?, ?, ?, ?, NULL, ?, NULL)")
          .run(input.messageId, newRunId, input.content, now, input.destination_id);
        this.db
          .prepare(
            `INSERT INTO thread_messages (id, thread_id, run_id, role, content, created_at) VALUES (?, ?, ?, 'user', ?, ?)`,
          )
          .run(input.messageId, thread.id, newRunId, input.content, now);
      }
      return {
        botId,
        threadId: thread.id,
        taskId: run.task_id,
        runId: newRunId,
        priorRunId: run.id,
        messageId: copied[0]?.messageId,
        operation: "retry" as const,
      };
    });
  }
  close(botId: string, runId: string, requestId: string, now: string) {
    return this.admit(requestId, { operation: "close", botId, runId }, () => {
      const run = this.ownedRun(botId, runId);
      if (run.state !== "uncertain")
        throw new ChatRequestError("Run has no uncertain outcome to close.", 409);
      const outcome =
        run.outcome ?? JSON.stringify({ kind: "uncertain", reply: "Final evidence is missing." });
      this.db
        .prepare(
          "UPDATE runs SET state = 'closed', held = 0, outcome = ?, stop_error = NULL, updated_at = ? WHERE id = ?",
        )
        .run(outcome, now, run.id);
      return {
        botId,
        taskId: run.task_id,
        runId: run.id,
        operation: "close" as const,
      };
    });
  }
  run(id: string): RunRow {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as unknown as
      | RunRow
      | undefined;
    if (!row) throw new ChatRequestError("Run not found.", 404);
    return row;
  }
  session(id: string): SavedSession {
    this.run(id);
    return this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(id) as unknown as SavedSession;
  }
  inputs(id: string): RunInput[] {
    return this.db
      .prepare("SELECT rowid, * FROM run_inputs WHERE run_id = ? ORDER BY rowid")
      .all(id) as unknown as RunInput[];
  }
  context(id: string) {
    const run = this.run(id);
    if (run.context)
      return JSON.parse(run.context) as {
        references: Original[];
        sourceMessageId: string;
        backgroundBoundary: number;
      };
    const thread = this.db.prepare("SELECT thread_id FROM tasks WHERE id = ?").get(run.task_id)
      ?.thread_id as string;
    const sourceSeq = this.db
      .prepare("SELECT seq FROM thread_messages WHERE id = ?")
      .get(run.source_message_id)?.seq as number;
    const selectedIds = JSON.parse(run.selected_message_ids) as string[];
    const selected = selectedIds.length
      ? (this.db
          .prepare(`SELECT id, seq, role, content, run_id, created_at FROM thread_messages
   WHERE thread_id = ? AND seq < ? AND id IN (${selectedIds.map(() => "?").join(", ")})
   ORDER BY seq`)
          .all(thread, sourceSeq, ...selectedIds) as unknown as Original[])
      : [];
    const references = [
      ...selected,
      ...(
        this.db
          .prepare(`SELECT id, seq, role, content, run_id, created_at FROM thread_messages
   WHERE thread_id = ? AND seq >= ? AND seq < ? AND run_id != ? ORDER BY seq DESC LIMIT 200`)
          .all(thread, run.background_boundary, sourceSeq, id) as unknown as Original[]
      )
        .filter((row) => !selectedIds.includes(row.id))
        .slice(0, Math.max(0, 7 - selected.length))
        .reverse(),
    ];
    const context = {
      references,
      sourceMessageId: run.source_message_id,
      backgroundBoundary: run.background_boundary,
    };
    this.db.prepare("UPDATE runs SET context = ? WHERE id = ?").run(JSON.stringify(context), id);
    return context;
  }
  /** Fix the open Attempt's steering window at the first save. Later saves do not extend it. */
  armCutoff(botId: string): void {
    const open = this.db
      .prepare(`SELECT a.id, a.run_id FROM attempts a JOIN sessions s ON s.id = a.run_id
     WHERE s.agent_group_id = ? AND a.ended_at IS NULL AND a.steer_through_rowid IS NULL`)
      .all(botId) as unknown as { id: string; run_id: string }[];
    for (const attempt of open) {
      const through = this.db
        .prepare("SELECT COALESCE(MAX(rowid), 0) AS rowid FROM run_inputs WHERE run_id = ?")
        .get(attempt.run_id) as { rowid: number };
      this.db
        .prepare("UPDATE attempts SET steer_through_rowid = ? WHERE id = ?")
        .run(through.rowid, attempt.id);
    }
  }
  openAttempt(id: string) {
    return this.db
      .prepare(`SELECT configuration_version AS configurationVersion, steer_through_rowid AS steerThroughRowid
     FROM attempts WHERE run_id = ? AND ended_at IS NULL ORDER BY rowid DESC LIMIT 1`)
      .get(id) as { configurationVersion: number; steerThroughRowid: number | null } | undefined;
  }
  latestAttempt(id: string) {
    return this.db
      .prepare(`SELECT configuration_version AS configurationVersion, steer_through_rowid AS steerThroughRowid
     FROM attempts WHERE run_id = ? ORDER BY rowid DESC LIMIT 1`)
      .get(id) as { configurationVersion: number; steerThroughRowid: number | null } | undefined;
  }
  budget(id: string, now: string) {
    const run = this.run(id);
    return {
      limitMs: RUN_ACTIVE_BUDGET_MS,
      activeMs:
        run.active_ms +
        (run.active_since ? Math.max(0, Date.parse(now) - Date.parse(run.active_since)) : 0),
      exhaustedAt: run.budget_exhausted_at,
    };
  }

  /** Checkpoint cumulative execution so an absent executor cannot reset spent time. */
  checkpointBudget(id: string, now: string): void {
    const run = this.run(id);
    if (!run.active_since || now <= run.active_since) return;
    this.db
      .prepare("UPDATE runs SET active_ms = ?, active_since = ? WHERE id = ?")
      .run(this.budget(id, now).activeMs, now, id);
  }

  /** A missing executor at startup retains the last durable observation, excluding downtime. */
  abandonBudget(id: string): void {
    this.db
      .prepare(
        "UPDATE attempts SET ended_at = (SELECT active_since FROM runs WHERE id = ?) WHERE run_id = ? AND ended_at IS NULL",
      )
      .run(id, id);
    this.db.prepare("UPDATE runs SET active_since = NULL WHERE id = ?").run(id);
  }

  exhaustBudget(id: string, now: string): boolean {
    const run = this.run(id);
    if (
      !["queued", "active"].includes(run.state) ||
      this.budget(id, now).activeMs < RUN_ACTIVE_BUDGET_MS
    )
      return false;
    this.db
      .prepare(
        "UPDATE runs SET budget_exhausted_at = COALESCE(budget_exhausted_at, ?) WHERE id = ?",
      )
      .run(now, id);
    this.markStopping(run, now);
    return true;
  }

  startAttempt(id: string, incarnation: number, now: string) {
    this.db
      .prepare("UPDATE runs SET active_since = ? WHERE id = ? AND active_since IS NULL")
      .run(now, id);
    const saved = this.db
      .prepare(
        "SELECT c.version FROM container_configs c JOIN sessions s ON s.agent_group_id = c.agent_group_id WHERE s.id = ?",
      )
      .get(id) as { version: number };
    const previous = this.db
      .prepare(`SELECT configuration_version AS configurationVersion, steer_through_rowid AS steerThroughRowid
     FROM attempts WHERE run_id = ? ORDER BY rowid DESC LIMIT 1`)
      .get(id) as { configurationVersion: number; steerThroughRowid: number | null } | undefined;
    let version = saved.version;
    let steerThrough: number | null = null;
    if (
      previous &&
      previous.steerThroughRowid != null &&
      previous.configurationVersion < saved.version &&
      this.db
        .prepare("SELECT 1 FROM run_inputs WHERE run_id = ? AND rowid <= ? AND outcome IS NULL")
        .get(id, previous.steerThroughRowid)
    ) {
      version = previous.configurationVersion;
      steerThrough = previous.steerThroughRowid;
    }
    this.db
      .prepare("UPDATE attempts SET ended_at = ? WHERE run_id = ? AND ended_at IS NULL")
      .run(now, id);
    this.db
      .prepare(`INSERT INTO attempts
     (id, run_id, incarnation, configuration_version, started_at, ended_at, steer_through_rowid)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`)
      .run(randomUUID(), id, incarnation, version, now, steerThrough);
    this.db
      .prepare("UPDATE runs SET state = 'active', updated_at = ? WHERE id = ? AND state = 'queued'")
      .run(now, id);
  }
  endAttempt(id: string, now: string) {
    this.checkpointBudget(id, now);
    this.db.prepare("UPDATE runs SET active_since = NULL WHERE id = ?").run(id);
    this.db
      .prepare("UPDATE attempts SET ended_at = ? WHERE run_id = ? AND ended_at IS NULL")
      .run(now, id);
  }
  failInputs(ids: string[], now: string) {
    for (const id of ids)
      this.db
        .prepare("UPDATE run_inputs SET outcome = ? WHERE message_id = ? AND outcome IS NULL")
        .run(
          JSON.stringify({
            kind: "failed",
            messageId: id,
            reply: "Unfinished Agent work exhausted its recovery retries.",
            at: now,
          }),
          id,
        );
  }
  reconcile(
    id: string,
    snapshot: {
      inputs: InboundMessage[];
      acknowledgements: ProcessingAck[];
      outputs: OutboundMessage[];
      evidence: { messageId: string; recordedAt: string }[];
      resultGroups: { messageId: string; groupId: string }[];
      executionLost: boolean;
    },
    now: string,
  ) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const run = this.run(id);
      const session = this.session(id);
      for (const row of snapshot.evidence)
        this.db
          .prepare(
            "UPDATE run_inputs SET recorded_at = ? WHERE message_id = ? AND run_id = ? AND recorded_at IS NULL",
          )
          .run(row.recordedAt, row.messageId, id);
      for (const input of this.inputs(id)) {
        const source = snapshot.inputs.find((row) => row.id === input.message_id);
        const result = snapshot.outputs.find(
          (row) =>
            row.in_reply_to === input.message_id &&
            source &&
            row.channel_type === source.channel_type &&
            row.platform_id === source.platform_id &&
            row.thread_id === source.thread_id,
        );
        const sealed = run.state === "closed" || run.state === "uncertain";
        if (result && sealed) {
          this.db
            .prepare("INSERT OR IGNORE INTO late_results VALUES (?, ?, ?, ?)")
            .run(result.id, id, result.content, result.timestamp);
          continue;
        }
        if (input.outcome) continue;
        if (result) {
          this.db.prepare("UPDATE run_inputs SET outcome = ? WHERE message_id = ?").run(
            JSON.stringify({
              kind: result.kind === "error" ? "failed" : "succeeded",
              messageId: input.message_id,
              resultId: result.id,
              reply: result.content,
              at: result.timestamp,
            }),
            input.message_id,
          );
          this.db
            .prepare(
              `INSERT OR IGNORE INTO thread_messages (id, thread_id, run_id, role, content, created_at) VALUES (?, ?, ?, 'assistant', ?, ?)`,
            )
            .run(
              snapshot.resultGroups.find((row) => row.messageId === input.message_id)?.groupId ??
                result.id,
              session.thread_id,
              id,
              result.content,
              result.timestamp,
            );
        } else if (
          !sealed &&
          run.state !== "stopping" &&
          source?.status === "failed" &&
          !snapshot.acknowledgements.some((ack) => ack.message_id === input.message_id)
        )
          this.failInputs([input.message_id], now);
      }
      if (
        run.state === "stopping" ||
        run.state === "closed" ||
        run.state === "uncertain" ||
        run.state === "waiting"
      ) {
        if (run.state === "uncertain")
          this.db.prepare("UPDATE runs SET held = 1 WHERE id = ? AND held = 0").run(id);
        this.db.exec("COMMIT");
        return;
      }
      const inputs = this.inputs(id);
      const missing = inputs.filter((row) => !row.outcome);
      let state: RunRow["state"] = run.state;
      let outcome = run.outcome;
      if (
        !missing.length &&
        !this.questions(id).some((q) => q.state === "pending" || q.state === "expired")
      ) {
        const results = inputs.map((row) => JSON.parse(row.outcome as string));
        const failure = results.find((row) => row.kind === "failed");
        state = failure ? "failed" : "succeeded";
        outcome = JSON.stringify(failure ?? results.at(-1));
      } else if (
        snapshot.executionLost &&
        missing.some((input) =>
          snapshot.acknowledgements.some(
            (ack) => ack.message_id === input.message_id && ack.status !== "processing",
          ),
        )
      ) {
        state = "uncertain";
        outcome ??= JSON.stringify({
          kind: "uncertain",
          reply: "Final evidence is missing.",
        });
      } else if (snapshot.executionLost) state = "queued";
      this.db
        .prepare(
          "UPDATE runs SET state = ?, outcome = ?, held = ?, updated_at = CASE WHEN state != ? OR outcome IS NOT ? THEN ? ELSE updated_at END WHERE id = ?",
        )
        .run(state, outcome, state === "uncertain" ? 1 : 0, state, outcome, now, id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Move the default background for later conversational Runs. Admitted Runs stay as captured. */
  reset(botId: string, requestId: string) {
    return this.admit(requestId, { operation: "reset", botId }, () => {
      const thread = this.thread(botId);
      const latest = this.db
        .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM thread_messages WHERE thread_id = ?")
        .get(thread.id) as { seq: number };
      const backgroundBoundary = Math.max(thread.background_boundary, latest.seq + 1);
      this.db
        .prepare("UPDATE threads SET background_boundary = ? WHERE id = ?")
        .run(backgroundBoundary, thread.id);
      return { botId, threadId: thread.id, backgroundBoundary };
    });
  }

  history(botId: string, input: unknown, runId?: string) {
    const thread = this.thread(botId);
    if (!runId) return history(this.db, { threadId: thread.id, backgroundBoundary: 0 }, input);
    const run = this.run(runId);
    if (this.session(runId).agent_group_id !== botId)
      throw new ChatRequestError("Run not found for this Bot.", 404);
    const seq = this.db
      .prepare("SELECT seq FROM thread_messages WHERE id = ? AND thread_id = ?")
      .get(run.source_message_id, thread.id)?.seq as number;
    return history(
      this.db,
      {
        threadId: thread.id,
        backgroundBoundary: run.background_boundary,
        searchBeforeSeq: seq,
        selectedMessageIds: JSON.parse(run.selected_message_ids) as string[],
      },
      input,
    );
  }

  /** Installation cap and durable queue. Chat work is interactive; every other origin is background. */
  configureAdmission(limit: number, now: string): void {
    this.db.prepare("UPDATE admission_scheduler SET active_limit = ? WHERE id = 1").run(limit);
    this.restoreCapacity(now);
  }

  activeLimit(): number {
    return (
      this.db
        .prepare("SELECT active_limit AS activeLimit FROM admission_scheduler WHERE id = 1")
        .get() as {
        activeLimit: number;
      }
    ).activeLimit;
  }

  holdsReservation(runId: string): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 AS present FROM execution_reservations WHERE run_id = ?")
        .get(runId),
    );
  }

  botIsReserved(botId: string): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 AS present FROM execution_reservations WHERE bot_id = ?")
        .get(botId),
    );
  }

  /**
   * Reserve the next fair runnable Run when a global slot and its Bot are free.
   * Interactive and background classes alternate; a Bot served less recently goes first.
   */
  reserveNext(limit: number, now: string): string | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const occupied = Number(
        (this.db.prepare("SELECT COUNT(*) AS n FROM execution_reservations").get() as { n: number })
          .n,
      );
      if (occupied >= limit) {
        this.db.exec("COMMIT");
        return;
      }
      const scheduler = this.db
        .prepare("SELECT next_class AS nextClass FROM admission_scheduler WHERE id = 1")
        .get() as { nextClass: "interactive" | "background" };
      const eligible = this.db
        .prepare(
          `SELECT q.run_id AS runId, q.bot_id AS botId, q.admission_class AS admissionClass, q.seq AS seq,
                  s.served_seq AS servedSeq
           FROM admission_queue q
           JOIN runs r ON r.id = q.run_id
           LEFT JOIN admission_service s ON s.bot_id = q.bot_id
           WHERE q.runnable = 1 AND r.state = 'queued'
             AND NOT EXISTS (SELECT 1 FROM execution_reservations e WHERE e.bot_id = q.bot_id)
           ORDER BY q.seq`,
        )
        .all() as {
        runId: string;
        botId: string;
        admissionClass: "interactive" | "background";
        seq: number;
        servedSeq: number | null;
      }[];
      if (eligible.length === 0) {
        this.db.exec("COMMIT");
        return;
      }
      const preferred = eligible.filter((row) => row.admissionClass === scheduler.nextClass);
      const pool = preferred.length > 0 ? preferred : eligible;
      pool.sort((left, right) => {
        const served = (left.servedSeq ?? -1) - (right.servedSeq ?? -1);
        return served === 0 ? left.seq - right.seq : served;
      });
      const chosen = pool[0] as (typeof pool)[number];
      this.db
        .prepare(
          "INSERT INTO execution_reservations (bot_id, run_id, reserved_at) VALUES (?, ?, ?)",
        )
        .run(chosen.botId, chosen.runId, now);
      this.db
        .prepare(
          `INSERT INTO admission_service (bot_id, served_seq) VALUES (?, ?)
           ON CONFLICT(bot_id) DO UPDATE SET served_seq = excluded.served_seq`,
        )
        .run(
          chosen.botId,
          (
            this.db
              .prepare("SELECT COALESCE(MAX(served_seq), 0) + 1 AS seq FROM admission_service")
              .get() as { seq: number }
          ).seq,
        );
      if (chosen.admissionClass === scheduler.nextClass) {
        this.db
          .prepare("UPDATE admission_scheduler SET next_class = ? WHERE id = 1")
          .run(chosen.admissionClass === "interactive" ? "background" : "interactive");
      }
      this.db.exec("COMMIT");
      return chosen.runId;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** A queued Run that is waiting out recovery is not executing, so it leaves the active set. */
  setRunnable(runId: string, ready: boolean): void {
    this.db
      .prepare("UPDATE admission_queue SET runnable = ? WHERE run_id = ?")
      .run(ready ? 1 : 0, runId);
  }

  clearReservation(runId: string): void {
    this.db.prepare("DELETE FROM execution_reservations WHERE run_id = ?").run(runId);
  }

  /** Drop a reserved slot after the driver fails to start, without treating the Run as finished. */
  abandonAdmission(runId: string): void {
    this.db.prepare("DELETE FROM execution_reservations WHERE run_id = ?").run(runId);
    this.db.prepare("UPDATE admission_queue SET runnable = 0 WHERE run_id = ?").run(runId);
  }

  /** Release a slot once the Run is terminal or waiting. Active, stopping, and recovering Runs keep it. */
  releaseAdmission(runId: string): void {
    const run = this.run(runId);
    if (run.state === "active" || run.state === "stopping" || run.state === "queued") return;
    this.db.prepare("DELETE FROM execution_reservations WHERE run_id = ?").run(runId);
    if (run.state === "waiting")
      this.db.prepare("UPDATE admission_queue SET runnable = 0 WHERE run_id = ?").run(runId);
    else this.db.prepare("DELETE FROM admission_queue WHERE run_id = ?").run(runId);
  }

  beginWait(runId: string, reason: string, now: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const run = this.run(runId);
      if (run.state !== "active" && run.state !== "queued") {
        this.db.exec("COMMIT");
        return;
      }
      this.db
        .prepare("UPDATE runs SET state = 'waiting', wait_reason = ?, updated_at = ? WHERE id = ?")
        .run(reason.slice(0, 200), now, runId);
      this.endAttempt(runId, now);
      this.db.prepare("UPDATE attempts SET steer_through_rowid = NULL WHERE run_id = ?").run(runId);
      this.db.prepare("DELETE FROM execution_reservations WHERE run_id = ?").run(runId);
      this.db.prepare("UPDATE admission_queue SET runnable = 0 WHERE run_id = ?").run(runId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Resumed work joins the tail of the queue and does not become executing by itself. */
  resumeWait(runId: string, now: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const run = this.run(runId);
      if (run.state !== "waiting") {
        this.db.exec("COMMIT");
        return;
      }
      const scheduler = this.db
        .prepare("SELECT last_seq AS lastSeq FROM admission_scheduler WHERE id = 1")
        .get() as { lastSeq: number };
      const seq = scheduler.lastSeq + 1;
      this.db.prepare("UPDATE admission_scheduler SET last_seq = ? WHERE id = 1").run(seq);
      this.db
        .prepare(
          "UPDATE runs SET state = 'queued', wait_reason = NULL, updated_at = ? WHERE id = ? AND state = 'waiting'",
        )
        .run(now, runId);
      const updated = this.db
        .prepare(
          "UPDATE admission_queue SET seq = ?, runnable = 1, enqueued_at = ? WHERE run_id = ?",
        )
        .run(seq, now, runId);
      if (updated.changes === 0) this.enqueue(runId, this.session(runId).agent_group_id, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private enqueue(runId: string, botId: string, now: string): void {
    if (this.db.prepare("SELECT 1 AS present FROM admission_queue WHERE run_id = ?").get(runId))
      return;
    const origin = this.db
      .prepare(
        "SELECT t.origin AS origin FROM tasks t JOIN runs r ON r.task_id = t.id WHERE r.id = ?",
      )
      .get(runId) as { origin: string };
    const scheduler = this.db
      .prepare("SELECT last_seq AS lastSeq FROM admission_scheduler WHERE id = 1")
      .get() as { lastSeq: number };
    const seq = scheduler.lastSeq + 1;
    this.db.prepare("UPDATE admission_scheduler SET last_seq = ? WHERE id = 1").run(seq);
    this.db
      .prepare(
        `INSERT INTO admission_queue (run_id, bot_id, admission_class, seq, runnable, enqueued_at)
         VALUES (?, ?, ?, ?, 1, ?)`,
      )
      .run(runId, botId, origin.origin === "chat" ? "interactive" : "background", seq, now);
  }

  private restoreCapacity(now: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db
        .prepare(
          `SELECT r.id AS id, s.agent_group_id AS botId FROM runs r JOIN sessions s ON s.id = r.id
           WHERE r.state IN ('queued', 'active', 'stopping')`,
        )
        .all() as { id: string; botId: string }[];
      for (const row of rows) this.enqueue(row.id, row.botId, now);
      const holding = this.db
        .prepare(
          `SELECT r.id AS id, s.agent_group_id AS botId FROM runs r JOIN sessions s ON s.id = r.id
           WHERE r.state IN ('active', 'stopping') ORDER BY r.rowid`,
        )
        .all() as { id: string; botId: string }[];
      for (const row of holding) {
        if (
          this.db
            .prepare("SELECT 1 AS present FROM execution_reservations WHERE bot_id = ?")
            .get(row.botId)
        )
          continue;
        this.db
          .prepare(
            "INSERT INTO execution_reservations (bot_id, run_id, reserved_at) VALUES (?, ?, ?)",
          )
          .run(row.botId, row.id, now);
        const seq = this.db
          .prepare("SELECT seq FROM admission_queue WHERE run_id = ?")
          .get(row.id) as { seq: number } | undefined;
        if (seq)
          this.db
            .prepare(
              "INSERT INTO admission_service (bot_id, served_seq) VALUES (?, ?) ON CONFLICT(bot_id) DO NOTHING",
            )
            .run(row.botId, seq.seq);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private admissionSnapshot() {
    const scheduler = this.db
      .prepare("SELECT active_limit AS activeLimit FROM admission_scheduler WHERE id = 1")
      .get() as { activeLimit: number };
    const activeCount = Number(
      (this.db.prepare("SELECT COUNT(*) AS n FROM execution_reservations").get() as { n: number })
        .n,
    );
    const rows = this.db
      .prepare(
        `SELECT q.run_id AS runId, q.admission_class AS admissionClass, q.runnable AS runnable, r.state AS state
         FROM admission_queue q JOIN runs r ON r.id = q.run_id ORDER BY q.seq`,
      )
      .all() as {
      runId: string;
      admissionClass: "interactive" | "background";
      runnable: number;
      state: string;
    }[];
    let position = 0;
    const placement = new Map<
      string,
      { admissionClass: "interactive" | "background"; queuePosition: number | null }
    >();
    for (const row of rows) {
      const queued = row.runnable === 1 && row.state === "queued";
      if (queued) position += 1;
      placement.set(row.runId, {
        admissionClass: row.admissionClass,
        queuePosition: queued ? position : null,
      });
    }
    return { activeLimit: scheduler.activeLimit, activeCount, placement };
  }

  private references(run: RunRow) {
    if (!run.context) return [];
    const context = JSON.parse(run.context) as {
      references?: { id: string; role: string; content: string }[];
    };
    return (context.references ?? []).map((reference) => ({
      id: reference.id,
      role: reference.role,
      text: preview(reference.content).text,
      truncated: preview(reference.content).truncated,
    }));
  }

  executingAttempt(runId: string) {
    return this.db
      .prepare(
        `SELECT id, incarnation FROM attempts
     WHERE run_id = ? AND ended_at IS NULL ORDER BY rowid DESC LIMIT 1`,
      )
      .get(runId) as { id: string; incarnation: number } | undefined;
  }

  recordPublication(input: {
    id: string;
    kind: "progress" | "result";
    botId: string;
    taskId: string;
    runId: string;
    attemptId: string;
    text: string;
    now: string;
    artifacts?: { id: string; name: string; bytes: number }[];
  }) {
    const existing = this.publicationRow(input.id);
    if (existing) {
      if (existing.botId !== input.botId || existing.runId !== input.runId)
        throw new ChatRequestError("Request identity is outside this execution.", 403);
      return existing;
    }
    const artifacts = input.kind === "result" ? (input.artifacts ?? []) : [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO agent_publications
         (id, kind, bot_id, task_id, run_id, attempt_id, text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.kind,
          input.botId,
          input.taskId,
          input.runId,
          input.attemptId,
          input.text,
          input.now,
        );
      const insert = this.db.prepare(
        `INSERT INTO delivered_artifacts
         (id, publication_id, bot_id, task_id, run_id, name, byte_size, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const artifact of artifacts) {
        insert.run(
          artifact.id,
          input.id,
          input.botId,
          input.taskId,
          input.runId,
          artifact.name,
          artifact.bytes,
          input.now,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.publicationRow(input.id) as NonNullable<ReturnType<ThreadStore["publicationRow"]>>;
  }

  publication(botId: string, runId: string, id: string) {
    const row = this.publicationRow(id);
    return row?.botId === botId && row.runId === runId ? row : undefined;
  }

  private publicationRow(id: string) {
    const row = this.db
      .prepare(
        `SELECT id, kind, bot_id AS botId, task_id AS taskId, run_id AS runId,
            attempt_id AS attemptId, text, created_at AS createdAt
     FROM agent_publications WHERE id = ?`,
      )
      .get(id) as
      | {
          id: string;
          kind: "progress" | "result";
          botId: string;
          taskId: string;
          runId: string;
          attemptId: string;
          text: string;
          createdAt: string;
        }
      | undefined;
    if (!row) return undefined;
    if (row.kind !== "result") return row;
    return {
      ...row,
      delegationId: null,
      artifacts: this.artifactRows(row.id),
    };
  }

  private artifactRows(publicationId: string) {
    return this.db
      .prepare(
        `SELECT id, name, byte_size AS bytes
     FROM delivered_artifacts WHERE publication_id = ? ORDER BY rowid`,
      )
      .all(publicationId) as { id: string; name: string; bytes: number }[];
  }

  artifact(botId: string, runId: string, artifactId: string) {
    return this.db
      .prepare(
        `SELECT id, name, byte_size AS bytes
     FROM delivered_artifacts WHERE id = ? AND bot_id = ? AND run_id = ?`,
      )
      .get(artifactId, botId, runId) as { id: string; name: string; bytes: number } | undefined;
  }

  private runPublications(runId: string) {
    return this.db
      .prepare(
        `SELECT id, kind, bot_id AS botId, task_id AS taskId, run_id AS runId,
            attempt_id AS attemptId, text, created_at AS createdAt
     FROM agent_publications WHERE run_id = ? ORDER BY rowid`,
      )
      .all(runId) as unknown as {
      id: string;
      kind: "progress" | "result";
      botId: string;
      taskId: string;
      runId: string;
      attemptId: string;
      text: string;
      createdAt: string;
    }[];
  }

  questions(runId: string) {
    return this.db
      .prepare(`SELECT id, bot_id AS botId, task_id AS taskId, run_id AS runId,
      attempt_id AS attemptId, text, state, deadline, answer, created_at AS createdAt, resolved_at AS resolvedAt
      FROM owner_questions WHERE run_id = ? ORDER BY rowid`)
      .all(runId) as unknown as {
      id: string;
      botId: string;
      taskId: string;
      runId: string;
      attemptId: string;
      text: string;
      state: "pending" | "answered" | "expired" | "cancelled";
      deadline: string | null;
      answer: string | null;
      createdAt: string;
      resolvedAt: string | null;
    }[];
  }

  recordQuestion(input: {
    id: string;
    botId: string;
    taskId: string;
    runId: string;
    attemptId: string;
    text: string;
    deadline: string | null;
    now: string;
  }) {
    const existing = this.db
      .prepare("SELECT run_id FROM owner_questions WHERE id = ?")
      .get(input.id);
    if (existing && existing.run_id !== input.runId)
      throw new ChatRequestError("Request identity is outside this execution.", 403);
    if (!existing) {
      if (this.publicationRow(input.id))
        throw new ChatRequestError("Request identity belongs to another operation.", 409);
      this.db
        .prepare(`INSERT INTO owner_questions
        (id, bot_id, task_id, run_id, attempt_id, text, state, deadline, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
        .run(
          input.id,
          input.botId,
          input.taskId,
          input.runId,
          input.attemptId,
          input.text,
          input.deadline,
          input.now,
        );
    }
    return this.questions(input.runId).find((q) => q.id === input.id);
  }

  expireQuestions(now: string): void {
    this.db
      .prepare(
        "UPDATE owner_questions SET state = 'expired', resolved_at = ? WHERE state = 'pending' AND deadline <= ?",
      )
      .run(now, now);
  }

  answerQuestion(
    botId: string,
    runId: string,
    questionId: string,
    requestId: string,
    text: string,
    now: string,
  ) {
    this.expireQuestions(now);
    return this.admit(
      requestId,
      { operation: "answer-question", botId, runId, questionId, text },
      () => {
        const run = this.ownedRun(botId, runId);
        const question = this.questions(runId).find((q) => q.id === questionId);
        if (!question) throw new ChatRequestError("Question not found.", 404);
        if (!["active", "waiting"].includes(run.state) || question.state !== "pending")
          throw new ChatRequestError("Question no longer accepts an answer.", 409);
        this.db
          .prepare(
            "UPDATE owner_questions SET state = 'answered', answer = ?, resolved_at = ? WHERE id = ?",
          )
          .run(text, now, questionId);
        return { botId, taskId: run.task_id, runId, questionId };
      },
    );
  }

  attempts(runId: string) {
    return this.db
      .prepare(
        "SELECT id, incarnation, configuration_version AS configurationVersion, started_at AS startedAt, ended_at AS endedAt FROM attempts WHERE run_id = ? ORDER BY rowid",
      )
      .all(runId);
  }

  detail(botId: string, now: string) {
    const thread = this.thread(botId);
    const admission = this.admissionSnapshot();
    const tasks = this.db
      .prepare("SELECT * FROM tasks WHERE thread_id = ? ORDER BY rowid")
      .all(thread.id)
      .map((task) => ({
        id: task.id as string,
        origin: task.origin as string,
        createdAt: task.created_at as string,
        runs: (
          this.db
            .prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY rowid")
            .all(task.id as string) as unknown as RunRow[]
        ).map((run) => ({
          id: run.id,
          state: run.state,
          budget: this.budget(run.id, now),
          held: run.held === 1,
          priorRunId: run.prior_run_id,
          stopError: run.stop_error,
          lateEvidence: (
            this.db
              .prepare(
                "SELECT id, content, created_at AS createdAt FROM late_results WHERE run_id = ? ORDER BY rowid LIMIT 5",
              )
              .all(run.id) as unknown as { id: string; content: string; createdAt: string }[]
          ).map((row) => ({
            id: row.id,
            ...preview(row.content),
            createdAt: row.createdAt,
          })),
          backgroundBoundary: run.background_boundary,
          references: this.references(run),
          sourceMessageId: run.source_message_id,
          outcome: outcomePreview(run.outcome),
          progress: this.runPublications(run.id)
            .filter((row) => row.kind === "progress")
            .map((row) => publicationPreview(row)),
          selectedResults: this.runPublications(run.id)
            .filter((row) => row.kind === "result")
            .map((row) => ({
              ...publicationPreview(row),
              botId: row.botId,
              taskId: row.taskId,
              runId: row.runId,
              delegationId: null,
              artifacts: this.artifactRows(row.id),
            })),
          inputs: this.inputs(run.id)
            .slice(0, 5)
            .map((input) => ({
              id: input.message_id,
              text: preview(input.content).text,
              truncated: preview(input.content).truncated,
              admittedAt: input.admitted_at,
              recordedAt: input.recorded_at,
              outcome: outcomePreview(input.outcome),
            })),
          attempts: this.attempts(run.id).slice(0, 5),
          admissionClass: admission.placement.get(run.id)?.admissionClass ?? null,
          queuePosition: admission.placement.get(run.id)?.queuePosition ?? null,
          questions: this.questions(run.id),
          waitReason: run.wait_reason,
        })),
      }));
    return {
      admission: { activeLimit: admission.activeLimit, activeCount: admission.activeCount },
      thread: {
        id: thread.id,
        botId,
        backgroundBoundary: thread.background_boundary,
        routineHolds: tasks.flatMap((task) =>
          task.runs.filter((run) => run.held).map((run) => ({ taskId: task.id, runId: run.id })),
        ),
      },
      tasks,
      messages: this.db
        .prepare(
          "SELECT id, seq, run_id AS runId, role, content, created_at AS createdAt FROM thread_messages WHERE thread_id = ? ORDER BY seq DESC LIMIT 5",
        )
        .all(thread.id)
        .reverse()
        .map((message) => ({
          ...message,
          content: preview(message.content as string).text,
          truncated: preview(message.content as string).truncated,
        })),
    };
  }

  requireTask(botId: string, taskId: string): void {
    const thread = this.thread(botId);
    const row = this.db
      .prepare("SELECT id FROM tasks WHERE id = ? AND thread_id = ?")
      .get(taskId, thread.id);
    if (!row) throw new ChatRequestError("Task not found.", 404);
  }

  insertAttachment(input: {
    id: string;
    taskId: string;
    botId: string;
    filename: string;
    bytes: number;
    createdAt: string;
  }): void {
    this.requireTask(input.botId, input.taskId);
    this.db
      .prepare(
        `INSERT INTO task_attachments (id, task_id, bot_id, filename, byte_size, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.taskId, input.botId, input.filename, input.bytes, input.createdAt);
  }

  attachments(
    botId: string,
    taskId: string,
  ): { id: string; filename: string; bytes: number; createdAt: string }[] {
    this.requireTask(botId, taskId);
    return this.db
      .prepare(
        `SELECT id, filename, byte_size AS bytes, created_at AS createdAt
         FROM task_attachments WHERE task_id = ? AND bot_id = ? ORDER BY rowid`,
      )
      .all(taskId, botId) as { id: string; filename: string; bytes: number; createdAt: string }[];
  }

  attachment(
    botId: string,
    taskId: string,
    attachmentId: string,
  ): { id: string; filename: string; bytes: number; createdAt: string } {
    const row = this.attachments(botId, taskId).find((item) => item.id === attachmentId);
    if (!row) throw new ChatRequestError("Attachment not found.", 404);
    return row;
  }
}
