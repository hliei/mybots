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
import type { WithDatabase } from "./connection.ts";
import { clearMailboxLocks } from "./lock.ts";
import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from "./schema.ts";

export function createMailbox(withDatabase: WithDatabase) {
  /** Bootstrap only, before a runner owns outbound.db. */
  function initializeMailbox(directory: string): void {
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
          const version = db.get("PRAGMA user_version") as { user_version: number };
          if (version.user_version !== 1) throw new Error("Unsupported mailbox schema version");
        });
      }
    }
  }

  class HostMailbox {
    readonly directory: string;
    constructor(directory: string) {
      this.directory = directory;
    }

    submit(
      message: { id: string; content: string; kind?: InboundMessage["kind"] } & Routing,
    ): void {
      withDatabase(this.directory, "inbound", false, (db) => {
        db.run(
          `INSERT INTO messages_in (id, seq, kind, timestamp, platform_id, channel_type, thread_id, content)
        VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_in), ?, ?, ?, ?, ?, ?)`,
          message.id,
          message.kind ?? "message",
          new Date().toISOString(),
          message.platform_id,
          message.channel_type,
          message.thread_id,
          message.content,
        );
        db.run(
          `INSERT OR REPLACE INTO session_routing VALUES (1, ?, ?, ?)`,
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
        (db) => db.all("SELECT * FROM messages_in ORDER BY seq") as InboundMessage[],
      );
    }

    outputs(): OutboundMessage[] {
      return withDatabase(
        this.directory,
        "outbound",
        true,
        (db) => db.all("SELECT * FROM messages_out ORDER BY seq") as OutboundMessage[],
      );
    }

    acknowledgements(): ProcessingAck[] {
      return withDatabase(
        this.directory,
        "outbound",
        true,
        (db) => db.all("SELECT * FROM processing_ack ORDER BY rowid") as ProcessingAck[],
      );
    }

    continuation(): string | undefined {
      return withDatabase(
        this.directory,
        "outbound",
        true,
        (db) =>
          (
            db.get("SELECT value FROM session_state WHERE key = 'continuation'") as
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
        (db) => db.get("SELECT * FROM container_state WHERE id = 1") as ContainerState | undefined,
      );
    }

    syncAcknowledgements(): void {
      const acknowledgements = this.acknowledgements();
      withDatabase(this.directory, "inbound", false, (db) => {
        for (const ack of acknowledgements) {
          if (ack.status !== "processing")
            db.run("UPDATE messages_in SET status = ? WHERE id = ?", ack.status, ack.message_id);
        }
      });
    }

    markDelivered(
      id: string,
      status: "delivered" | "failed",
      platformMessageId: string | null = null,
    ): void {
      withDatabase(this.directory, "inbound", false, (db) =>
        db.run(
          "INSERT OR IGNORE INTO delivered VALUES (?, ?, ?, ?)",
          id,
          platformMessageId,
          status,
          new Date().toISOString(),
        ),
      );
    }

    deliveryStatus(id: string): string | undefined {
      return withDatabase(
        this.directory,
        "inbound",
        true,
        (db) =>
          (
            db.get("SELECT status FROM delivered WHERE message_out_id = ?", id) as
              | { status: string }
              | undefined
          )?.status,
      );
    }
  }

  class RunnerMailbox {
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
            (db.all("SELECT message_id FROM processing_ack") as ProcessingAck[]).map(
              (row) => row.message_id,
            ),
          ),
      );
      return withDatabase(this.directory, "inbound", true, (db) =>
        (
          db.all(
            "SELECT * FROM messages_in WHERE status = 'pending' AND trigger = 1 AND (process_after IS NULL OR process_after <= ?) ORDER BY seq",
            new Date().toISOString(),
          ) as InboundMessage[]
        ).filter((row) => !handled.has(row.id)),
      );
    }

    acknowledge(id: string, status: ProcessingAck["status"]): void {
      withDatabase(this.directory, "outbound", false, (db) =>
        db.run(
          "INSERT OR REPLACE INTO processing_ack VALUES (?, ?, ?)",
          id,
          status,
          new Date().toISOString(),
        ),
      );
    }

    reply(input: InboundMessage, content: string, kind: OutboundMessage["kind"] = "message"): void {
      withDatabase(this.directory, "outbound", false, (db) =>
        db.run(
          `INSERT INTO messages_out (id, seq, in_reply_to, timestamp, kind, platform_id, channel_type, thread_id, content)
      VALUES (?, (SELECT COALESCE(MAX(seq), -1) + 2 FROM messages_out), ?, ?, ?, ?, ?, ?, ?)`,
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
        db.run(
          "INSERT OR REPLACE INTO session_state VALUES ('continuation', ?, ?)",
          value,
          new Date().toISOString(),
        ),
      );
    }

    saveRouting(routing: Routing): void {
      withDatabase(this.directory, "outbound", false, (db) =>
        db.run(
          "INSERT OR REPLACE INTO session_state VALUES ('reply_routing', ?, ?)",
          JSON.stringify(routing),
          new Date().toISOString(),
        ),
      );
    }

    touch(): void {
      withDatabase(this.directory, "outbound", false, (db) =>
        db.run("UPDATE container_state SET updated_at = ? WHERE id = 1", new Date().toISOString()),
      );
    }

    activity(tool: string | null, timeoutMs: number | null = null): void {
      const now = new Date().toISOString();
      withDatabase(this.directory, "outbound", false, (db) =>
        db.run(
          "INSERT OR REPLACE INTO container_state VALUES (1, ?, ?, ?, ?)",
          tool,
          timeoutMs,
          tool ? now : null,
          now,
        ),
      );
    }
  }

  return { initializeMailbox, HostMailbox, RunnerMailbox };
}

export type RunnerMailbox = InstanceType<ReturnType<typeof createMailbox>["RunnerMailbox"]>;
