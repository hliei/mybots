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
  state: "queued" | "active" | "succeeded" | "failed" | "uncertain";
  background_boundary: number;
  source_message_id: string;
  context: string | null;
  outcome: string | null;
  created_at: string;
  updated_at: string;
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
          .prepare("INSERT INTO runs VALUES (?, ?, 'queued', ?, ?, NULL, NULL, ?, ?)")
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
  startAttempt(id: string, incarnation: number, now: string) {
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
        if (input.outcome) continue;
        const source = snapshot.inputs.find((row) => row.id === input.message_id);
        const result = snapshot.outputs.find(
          (row) =>
            row.in_reply_to === input.message_id &&
            source &&
            row.channel_type === source.channel_type &&
            row.platform_id === source.platform_id &&
            row.thread_id === source.thread_id,
        );
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
          source?.status === "failed" &&
          !snapshot.acknowledgements.some((ack) => ack.message_id === input.message_id)
        )
          this.failInputs([input.message_id], now);
      }
      const inputs = this.inputs(id);
      const missing = inputs.filter((row) => !row.outcome);
      let state = run.state;
      let outcome = run.outcome;
      if (state !== "uncertain") {
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
        )
          state = "uncertain";
        else if (snapshot.executionLost) state = "queued";
      }
      this.db
        .prepare(
          "UPDATE runs SET state = ?, outcome = ?, updated_at = CASE WHEN state != ? OR outcome IS NOT ? THEN ? ELSE updated_at END WHERE id = ?",
        )
        .run(state, outcome, state, outcome, now, id);
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
      thread: { id: thread.id, botId, backgroundBoundary: thread.background_boundary },
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
