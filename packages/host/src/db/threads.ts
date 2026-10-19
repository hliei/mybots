import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { InboundMessage, OutboundMessage, ProcessingAck } from "@mybots/mailbox";
import { ChatRequestError } from "../chat.ts";
import { history } from "./history.ts";
import type { SavedSession } from "./index.ts";

interface ThreadRow {
  id: string;
  bot_id: string;
  background_boundary: number;
  created_at: string;
}
interface RunRow {
  id: string;
  task_id: string;
  state: "queued" | "active" | "stopping" | "succeeded" | "failed" | "uncertain" | "closed";
  background_boundary: number;
  source_message_id: string;
  context: string | null;
  outcome: string | null;
  created_at: string;
  updated_at: string;
  prior_run_id: string | null;
  stop_error: string | null;
  held: number;
}
interface RunInput {
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
    input: { requestId: string; botId: string; text: string; newTask: boolean; taskId?: string },
    now: string,
    destinationId = "local-client",
  ) {
    return this.admit(input.requestId, { ...input, destinationId }, () => {
      const thread = this.thread(input.botId);
      let run: RunRow | undefined;
      if (input.taskId) {
        run = this.db
          .prepare(`SELECT r.* FROM runs r JOIN tasks t ON t.id = r.task_id
     WHERE t.id = ? AND t.thread_id = ? ORDER BY r.rowid DESC LIMIT 1`)
          .get(input.taskId, thread.id) as unknown as RunRow | undefined;
        if (!run) throw new ChatRequestError("Task not found for this Bot.", 404);
        if (!["queued", "active"].includes(run.state))
          throw new ChatRequestError("Task does not accept additions.", 409);
      } else if (!input.newTask) {
        run = this.db
          .prepare(`SELECT r.* FROM runs r JOIN tasks t ON t.id = r.task_id
     WHERE t.thread_id = ? AND r.state IN ('queued', 'active') ORDER BY r.rowid DESC LIMIT 1`)
          .get(thread.id) as unknown as RunRow | undefined;
      }
      const messageId = randomUUID();
      if (!run) {
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
 WHERE t.id = ? AND t.thread_id = ? AND r.state IN ('queued', 'active', 'stopping', 'uncertain')
 ORDER BY r.rowid DESC LIMIT 1`)
        .get(taskId, this.thread(botId).id) as unknown as RunRow | undefined;
      if (!run) throw new ChatRequestError("Task has no running work to stop.", 409);
      return this.markStopping(run, now);
    });
  }
  markStopping(run: RunRow, now: string) {
    if (["succeeded", "failed", "closed"].includes(run.state))
      throw new ChatRequestError("Run is already terminal.", 409);
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
          (ack) => ack.message_id === input.message_id && ack.status === "completed",
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
 AND state IN ('queued', 'active', 'stopping', 'uncertain')`,
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
      .prepare("SELECT * FROM run_inputs WHERE run_id = ? ORDER BY rowid")
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
    const references = (
      this.db
        .prepare(`SELECT id, seq, role, content, run_id, created_at FROM thread_messages
   WHERE thread_id = ? AND seq >= ? AND seq < ? AND run_id != ? ORDER BY seq DESC LIMIT 200`)
        .all(thread, run.background_boundary, sourceSeq, id) as unknown as Original[]
    )
      .slice(0, 7)
      .reverse();
    const context = {
      references,
      sourceMessageId: run.source_message_id,
      backgroundBoundary: run.background_boundary,
    };
    this.db.prepare("UPDATE runs SET context = ? WHERE id = ?").run(JSON.stringify(context), id);
    return context;
  }
  startAttempt(id: string, incarnation: number, now: string) {
    this.db
      .prepare("UPDATE attempts SET ended_at = ? WHERE run_id = ? AND ended_at IS NULL")
      .run(now, id);
    const version = 1;
    this.db
      .prepare("INSERT INTO attempts VALUES (?, ?, ?, ?, ?, NULL)")
      .run(randomUUID(), id, incarnation, version, now);
    this.db
      .prepare("UPDATE runs SET state = 'active', updated_at = ? WHERE id = ? AND state = 'queued'")
      .run(now, id);
  }
  endAttempt(id: string, now: string) {
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
      if (run.state === "stopping" || run.state === "closed" || run.state === "uncertain") {
        if (run.state === "uncertain")
          this.db.prepare("UPDATE runs SET held = 1 WHERE id = ? AND held = 0").run(id);
        this.db.exec("COMMIT");
        return;
      }
      const inputs = this.inputs(id);
      const missing = inputs.filter((row) => !row.outcome);
      let state: RunRow["state"] = run.state;
      let outcome = run.outcome;
      if (!missing.length) {
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
      { threadId: thread.id, backgroundBoundary: run.background_boundary, searchBeforeSeq: seq },
      input,
    );
  }

  attempts(runId: string) {
    return this.db
      .prepare(
        "SELECT id, incarnation, configuration_version AS configurationVersion, started_at AS startedAt, ended_at AS endedAt FROM attempts WHERE run_id = ? ORDER BY rowid",
      )
      .all(runId);
  }

  detail(botId: string) {
    const thread = this.thread(botId);
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
          sourceMessageId: run.source_message_id,
          outcome: outcomePreview(run.outcome),
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
        })),
      }));
    return {
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
}
