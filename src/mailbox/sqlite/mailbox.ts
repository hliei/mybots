import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  ContainerState,
  InboundMessage,
  OutboundMessage,
  ProcessingAck,
  Routing,
} from "../types.ts";
import { withDatabase } from "./connection.ts";
import { clearMailboxLocks } from "./lock.ts";
import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from "./schema.ts";

/** Bootstrap only, before a runner owns outbound.db. */
export function initializeMailbox(directory: string): void {
  mkdirSync(directory, { recursive: true });
  clearMailboxLocks(directory);
  for (const [side, schema] of [
    ["inbound", INBOUND_SCHEMA],
    ["outbound", OUTBOUND_SCHEMA],
  ] as const) {
    if (!existsSync(join(directory, `${side}.db`))) {
      withDatabase(directory, side, false, (db) => db.exec(`${schema} PRAGMA user_version = 1;`));
    } else {
      withDatabase(directory, side, true, (db) => {
        const version = db.prepare("PRAGMA user_version").get() as { user_version: number };
        if (version.user_version !== 1) throw new Error("Unsupported mailbox schema version");
      });
    }
  }
}

export class HostMailbox {
  readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
  }

  submit(message: { id: string; content: string } & Routing): void {
    withDatabase(this.directory, "inbound", false, (db) => {
      db.prepare(`INSERT INTO messages_in (id, seq, kind, timestamp, platform_id, channel_type, thread_id, content)
        VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_in), 'message', ?, ?, ?, ?, ?)`).run(
        message.id,
        new Date().toISOString(),
        message.platform_id,
        message.channel_type,
        message.thread_id,
        message.content,
      );
      db.prepare(`INSERT OR REPLACE INTO session_routing VALUES (1, ?, ?, ?)`).run(
        message.channel_type,
        message.platform_id,
        message.thread_id,
      );
    });
  }

  inputs(): InboundMessage[] {
    return withDatabase(
      this.directory,
      "inbound",
      true,
      (db) => db.prepare("SELECT * FROM messages_in ORDER BY seq").all() as InboundMessage[],
    );
  }

  outputs(): OutboundMessage[] {
    return withDatabase(
      this.directory,
      "outbound",
      true,
      (db) => db.prepare("SELECT * FROM messages_out ORDER BY seq").all() as OutboundMessage[],
    );
  }

  acknowledgements(): ProcessingAck[] {
    return withDatabase(
      this.directory,
      "outbound",
      true,
      (db) => db.prepare("SELECT * FROM processing_ack ORDER BY rowid").all() as ProcessingAck[],
    );
  }

  continuation(): string | undefined {
    return withDatabase(
      this.directory,
      "outbound",
      true,
      (db) =>
        (
          db.prepare("SELECT value FROM session_state WHERE key = 'continuation'").get() as
            | { value: string }
            | undefined
        )?.value,
    );
  }

  activity(): ContainerState | undefined {
    return withDatabase(
      this.directory,
      "outbound",
      true,
      (db) =>
        db.prepare("SELECT * FROM container_state WHERE id = 1").get() as
          | ContainerState
          | undefined,
    );
  }

  syncAcknowledgements(): void {
    const acknowledgements = this.acknowledgements();
    withDatabase(this.directory, "inbound", false, (db) => {
      for (const ack of acknowledgements) {
        if (ack.status !== "processing")
          db.prepare("UPDATE messages_in SET status = ? WHERE id = ?").run(
            ack.status,
            ack.message_id,
          );
      }
    });
  }

  markDelivered(
    id: string,
    status: "delivered" | "failed",
    platformMessageId: string | null = null,
  ): void {
    withDatabase(this.directory, "inbound", false, (db) =>
      db
        .prepare("INSERT OR IGNORE INTO delivered VALUES (?, ?, ?, ?)")
        .run(id, platformMessageId, status, new Date().toISOString()),
    );
  }

  deliveryStatus(id: string): string | undefined {
    return withDatabase(
      this.directory,
      "inbound",
      true,
      (db) =>
        (
          db.prepare("SELECT status FROM delivered WHERE message_out_id = ?").get(id) as
            | { status: string }
            | undefined
        )?.status,
    );
  }
}

export class RunnerMailbox {
  readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
  }

  pending(): InboundMessage[] {
    const handled = withDatabase(
      this.directory,
      "outbound",
      true,
      (db) =>
        new Set(
          (db.prepare("SELECT message_id FROM processing_ack").all() as ProcessingAck[]).map(
            (row) => row.message_id,
          ),
        ),
    );
    return withDatabase(this.directory, "inbound", true, (db) =>
      (
        db
          .prepare(
            "SELECT * FROM messages_in WHERE status = 'pending' AND trigger = 1 AND (process_after IS NULL OR process_after <= ?) ORDER BY seq",
          )
          .all(new Date().toISOString()) as InboundMessage[]
      ).filter((row) => !handled.has(row.id)),
    );
  }

  acknowledge(id: string, status: ProcessingAck["status"]): void {
    withDatabase(this.directory, "outbound", false, (db) =>
      db
        .prepare("INSERT OR REPLACE INTO processing_ack VALUES (?, ?, ?)")
        .run(id, status, new Date().toISOString()),
    );
  }

  reply(input: InboundMessage, content: string, kind: OutboundMessage["kind"] = "message"): void {
    withDatabase(this.directory, "outbound", false, (db) =>
      db
        .prepare(`INSERT INTO messages_out (id, seq, in_reply_to, timestamp, kind, platform_id, channel_type, thread_id, content)
      VALUES (?, (SELECT COALESCE(MAX(seq), -1) + 2 FROM messages_out), ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          randomUUID(),
          input.id,
          new Date().toISOString(),
          kind,
          input.platform_id,
          input.channel_type,
          input.thread_id,
          content,
        ),
    );
  }

  continuation(): string | undefined {
    return new HostMailbox(this.directory).continuation();
  }

  saveContinuation(value: string): void {
    withDatabase(this.directory, "outbound", false, (db) =>
      db
        .prepare("INSERT OR REPLACE INTO session_state VALUES ('continuation', ?, ?)")
        .run(value, new Date().toISOString()),
    );
  }

  saveRouting(routing: Routing): void {
    withDatabase(this.directory, "outbound", false, (db) =>
      db
        .prepare("INSERT OR REPLACE INTO session_state VALUES ('reply_routing', ?, ?)")
        .run(JSON.stringify(routing), new Date().toISOString()),
    );
  }

  touch(): void {
    withDatabase(this.directory, "outbound", false, (db) =>
      db
        .prepare("UPDATE container_state SET updated_at = ? WHERE id = 1")
        .run(new Date().toISOString()),
    );
  }

  activity(tool: string | null, timeoutMs: number | null = null): void {
    const now = new Date().toISOString();
    withDatabase(this.directory, "outbound", false, (db) =>
      db
        .prepare("INSERT OR REPLACE INTO container_state VALUES (1, ?, ?, ?, ?)")
        .run(tool, timeoutMs, tool ? now : null, now),
    );
  }
}
