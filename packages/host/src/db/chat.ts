import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { InboundMessage, OutboundMessage, ProcessingAck } from "@mybots/mailbox";
import { ChatRequestError } from "../chat.ts";
import type { SavedSession } from "./index.ts";

interface WorkInput {
  message_id: string;
  work_id: string;
  content: string;
  admitted_at: string;
  outcome: string | null;
}
interface WorkRow {
  id: string;
  session_id: string;
  state: "queued" | "active" | "succeeded" | "failed" | "uncertain";
  outcome: string | null;
  created_at: string;
  updated_at: string;
}

function publicSession(session: SavedSession) {
  return {
    id: session.id,
    botId: session.agent_group_id,
    name: session.name,
    purpose: session.purpose,
    status: session.status,
    createdAt: session.created_at,
  };
}

/** Selected chat ownership and durable operation admissions in the Host store. */
export class ChatStore {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  session(id: string): SavedSession {
    const session = this.db
      .prepare("SELECT * FROM sessions WHERE id = ? AND purpose = 'chat'")
      .get(id) as unknown as SavedSession | undefined;
    if (!session) throw new ChatRequestError("Chat session not found.", 404);
    return session;
  }

  sessions(botId: string) {
    if (!this.db.prepare("SELECT id FROM agent_groups WHERE id = ?").get(botId))
      throw new ChatRequestError("Bot not found.", 404);
    return (
      this.db
        .prepare(
          "SELECT * FROM sessions WHERE agent_group_id = ? AND purpose = 'chat' ORDER BY created_at, rowid",
        )
        .all(botId) as unknown as SavedSession[]
    ).map(publicSession);
  }

  private admit<T extends object>(requestId: string, payload: object, apply: () => T) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const serialized = JSON.stringify(payload);
      const saved = this.db
        .prepare("SELECT payload, response FROM chat_admissions WHERE request_id = ?")
        .get(requestId);
      if (saved && saved.payload !== serialized)
        throw new ChatRequestError(
          "This requestId already belongs to a different chat operation.",
          409,
        );
      const response: T = saved ? JSON.parse(saved.response as string) : apply();
      if (!saved)
        this.db
          .prepare("INSERT INTO chat_admissions VALUES (?, ?, ?)")
          .run(requestId, serialized, JSON.stringify(response));
      this.db.exec("COMMIT");
      return { requestId, ...response, replayed: !!saved };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  create(requestId: string, botId: string, name: string, now: string) {
    return this.admit(requestId, { operation: "create", botId, name }, () => {
      this.sessions(botId);
      const id = randomUUID();
      this.db
        .prepare(`INSERT INTO messaging_groups (id, channel_type, platform_id, instance, created_at)
        VALUES ('local-client', 'client', 'owner', 'local-client', ?) ON CONFLICT(id) DO NOTHING`)
        .run(now);
      this.db
        .prepare(`INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, name, purpose, created_at)
        VALUES (?, ?, 'local-client', ?, ?, 'chat', ?)`)
        .run(id, botId, id, name, now);
      return { session: publicSession(this.session(id)) };
    });
  }

  rename(requestId: string, sessionId: string, name: string) {
    return this.admit(requestId, { operation: "name", sessionId, name }, () => {
      this.session(sessionId);
      this.db.prepare("UPDATE sessions SET name = ? WHERE id = ?").run(name, sessionId);
      return { session: publicSession(this.session(sessionId)) };
    });
  }

  detail(id: string) {
    const session = publicSession(this.session(id));
    const works = (
      this.db
        .prepare("SELECT * FROM work_items WHERE session_id = ? ORDER BY rowid")
        .all(id) as unknown as WorkRow[]
    ).map((work) => ({
      id: work.id,
      botId: session.botId,
      sessionId: id,
      state: work.state,
      outcome: work.outcome ? JSON.parse(work.outcome) : null,
      createdAt: work.created_at,
      updatedAt: work.updated_at,
      messages: this.inputs(id)
        .filter((input) => input.work_id === work.id)
        .map((input) => ({
          id: input.message_id,
          text: input.content,
          admittedAt: input.admitted_at,
          outcome: input.outcome ? JSON.parse(input.outcome) : null,
        })),
    }));
    return { session, works };
  }

  message(requestId: string, sessionId: string, text: string, now: string) {
    return this.admit(requestId, { operation: "message", sessionId, text }, () => {
      const session = this.session(sessionId);
      let work = this.db
        .prepare(
          "SELECT * FROM work_items WHERE session_id = ? AND state IN ('queued', 'active', 'uncertain')",
        )
        .get(sessionId) as unknown as WorkRow | undefined;
      if (work?.state === "uncertain")
        throw new ChatRequestError(
          "This work has an uncertain outcome. Inspect its evidence and resolve it before sending ordinary input; use another session for unrelated work.",
          409,
        );
      if (!work) {
        const id = randomUUID();
        this.db
          .prepare("INSERT INTO work_items VALUES (?, ?, 'queued', NULL, ?, ?)")
          .run(id, sessionId, now, now);
        work = this.db
          .prepare("SELECT * FROM work_items WHERE id = ?")
          .get(id) as unknown as WorkRow;
      }
      const messageId = randomUUID();
      this.db
        .prepare("INSERT INTO work_inputs VALUES (?, ?, ?, ?, NULL)")
        .run(messageId, work.id, text, now);
      this.db.prepare("UPDATE sessions SET last_active = ? WHERE id = ?").run(now, sessionId);
      return { sessionId, botId: session.agent_group_id, workId: work.id, messageId };
    });
  }

  inputs(sessionId: string): WorkInput[] {
    return this.db
      .prepare(`SELECT i.* FROM work_inputs i JOIN work_items w ON w.id = i.work_id
      WHERE w.session_id = ? ORDER BY i.rowid`)
      .all(sessionId) as unknown as WorkInput[];
  }

  uncertain(sessionId: string): boolean {
    return !!this.db
      .prepare("SELECT id FROM work_items WHERE session_id = ? AND state = 'uncertain'")
      .get(sessionId);
  }

  failInputs(ids: string[], now: string): void {
    for (const messageId of ids)
      this.db
        .prepare("UPDATE work_inputs SET outcome = ? WHERE message_id = ? AND outcome IS NULL")
        .run(
          JSON.stringify({
            kind: "failed",
            messageId,
            reply: "Unfinished Agent work exhausted its recovery retries.",
            at: now,
          }),
          messageId,
        );
  }

  /** Final mailbox rows are evidence. Acknowledgements alone only describe execution. */
  reconcile(
    sessionId: string,
    snapshot: {
      inputs: InboundMessage[];
      acknowledgements: ProcessingAck[];
      outputs: OutboundMessage[];
      executionLost: boolean;
    },
    now: string,
  ): void {
    const acknowledgements = new Map(
      snapshot.acknowledgements.map((ack) => [ack.message_id, ack.status]),
    );
    for (const input of this.inputs(sessionId)) {
      if (input.outcome) continue;
      const source = snapshot.inputs.find((row) => row.id === input.message_id);
      const result = snapshot.outputs.find(
        (output) =>
          output.in_reply_to === input.message_id &&
          source &&
          output.channel_type === source.channel_type &&
          output.platform_id === source.platform_id &&
          output.thread_id === source.thread_id,
      );
      if (result)
        this.db.prepare("UPDATE work_inputs SET outcome = ? WHERE message_id = ?").run(
          JSON.stringify({
            kind: result.kind === "error" ? "failed" : "succeeded",
            messageId: input.message_id,
            resultId: result.id,
            reply: result.content,
            at: result.timestamp,
          }),
          input.message_id,
        );
      else if (source?.status === "failed" && !acknowledgements.has(input.message_id))
        this.failInputs([input.message_id], now);
    }
    const inputs = this.inputs(sessionId);
    const works = this.db
      .prepare(
        "SELECT * FROM work_items WHERE session_id = ? AND state IN ('queued', 'active', 'uncertain')",
      )
      .all(sessionId) as unknown as WorkRow[];
    for (const work of works) {
      const messages = inputs.filter((input) => input.work_id === work.id);
      const missing = messages.filter((input) => !input.outcome);
      let state = work.state;
      let outcome: string | null = null;
      if (state !== "uncertain") {
        if (missing.length === 0) {
          const outcomes = messages.map((input) => JSON.parse(input.outcome as string));
          const failure = outcomes.find((result) => result.kind === "failed");
          state = failure ? "failed" : "succeeded";
          outcome = JSON.stringify(failure ?? outcomes.at(-1));
        } else if (
          snapshot.executionLost &&
          missing.some((input) => {
            const ack = acknowledgements.get(input.message_id);
            return ack === "completed" || ack === "failed";
          })
        )
          state = "uncertain";
        else
          state =
            !snapshot.executionLost &&
            missing.some((input) => acknowledgements.has(input.message_id))
              ? "active"
              : "queued";
      }
      if (state !== work.state || outcome !== work.outcome)
        this.db
          .prepare("UPDATE work_items SET state = ?, outcome = ?, updated_at = ? WHERE id = ?")
          .run(state, outcome, now, work.id);
    }
  }
}
