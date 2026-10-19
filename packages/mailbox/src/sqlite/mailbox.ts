import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
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
  /**
   * Session-local liveness marker. The container touches it on mailbox work so
   * the host can observe a stalled container without trusting private maps.
   */
  function heartbeatPath(directory: string): string {
    return join(directory, ".heartbeat");
  }

  function touchHeartbeat(directory: string): void {
    const file = heartbeatPath(directory);
    const now = new Date();
    try {
      utimesSync(file, now, now);
    } catch {
      writeFileSync(file, "", { mode: 0o600 });
    }
  }

  function readHeartbeat(directory: string): number | undefined {
    try {
      return statSync(heartbeatPath(directory)).mtimeMs;
    } catch {
      return undefined;
    }
  }

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
    ): InboundMessage {
      return withDatabase(this.directory, "inbound", false, (db) => {
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
        return db.get("SELECT * FROM messages_in WHERE id = ?", message.id) as InboundMessage;
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

    /** Unfinished claims left by a container that stopped without settling them. */
    processingClaims(): ProcessingAck[] {
      return this.acknowledgements().filter((ack) => ack.status === "processing");
    }

    /**
     * Drop abandoned claims. The host only writes to outbound.db while no
     * container runs, so the next incarnation starts from a clean claim set.
     */
    clearProcessingClaims(): void {
      withDatabase(this.directory, "outbound", false, (db) =>
        db.run("DELETE FROM processing_ack WHERE status = 'processing'"),
      );
    }

    /** Reschedule a pending input for the next bounded recovery attempt. */
    retryInput(id: string, processAfter: string): void {
      withDatabase(this.directory, "inbound", false, (db) =>
        db.run(
          "UPDATE messages_in SET tries = tries + 1, process_after = ?, status = 'pending' WHERE id = ? AND status = 'pending'",
          processAfter,
          id,
        ),
      );
    }

    /** Terminal recovery exhaustion for a pending input. */
    failInput(id: string): void {
      withDatabase(this.directory, "inbound", false, (db) =>
        db.run("UPDATE messages_in SET status = 'failed' WHERE id = ? AND status = 'pending'", id),
      );
    }

    /** Hold unclaimed input while its work requires an explicit owner resolution. */
    holdInput(id: string): void {
      withDatabase(this.directory, "inbound", false, (db) =>
        db.run("UPDATE messages_in SET trigger = 0 WHERE id = ? AND status = 'pending'", id),
      );
    }

    /** Last observed container heartbeat, or undefined when never written. */
    heartbeat(): number | undefined {
      return readHeartbeat(this.directory);
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

    inputEvidence(): { messageId: string; recordedAt: string }[] {
      return withDatabase(
        this.directory,
        "outbound",
        true,
        (db) =>
          db.all(
            "SELECT substr(key, 7) AS messageId, updated_at AS recordedAt FROM session_state WHERE key LIKE 'input:%'",
          ) as { messageId: string; recordedAt: string }[],
      );
    }

    resultGroups(): { messageId: string; groupId: string }[] {
      return withDatabase(
        this.directory,
        "outbound",
        true,
        (db) =>
          db.all(
            "SELECT substr(key, 8) AS messageId, value AS groupId FROM session_state WHERE key LIKE 'result:%'",
          ) as { messageId: string; groupId: string }[],
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
      return withDatabase(this.directory, "inbound", true, (db) => {
        const pending = (
          db.all(
            "SELECT * FROM messages_in WHERE status = 'pending' AND trigger = 1 ORDER BY seq",
          ) as InboundMessage[]
        ).filter((row) => !handled.has(row.id));
        // Recovery backoff is a FIFO barrier, so newer input cannot overtake its retry.
        const now = new Date().toISOString();
        const delayed = pending.findIndex((row) => row.process_after && row.process_after > now);
        return pending.slice(0, delayed === -1 ? undefined : delayed);
      });
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

    recordResultGroup(groupId: string, inputIds: string[]): void {
      withDatabase(this.directory, "outbound", false, (db) => {
        for (const id of inputIds)
          db.run(
            "INSERT OR IGNORE INTO session_state VALUES (?, ?, ?)",
            `result:${id}`,
            groupId,
            new Date().toISOString(),
          );
      });
    }

    recordInput(id: string): void {
      withDatabase(this.directory, "outbound", false, (db) =>
        db.run(
          "INSERT OR IGNORE INTO session_state VALUES (?, 'recorded', ?)",
          `input:${id}`,
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
      touchHeartbeat(this.directory);
      withDatabase(this.directory, "outbound", false, (db) =>
        db.run("UPDATE container_state SET updated_at = ? WHERE id = 1", new Date().toISOString()),
      );
    }

    activity(tool: string | null, timeoutMs: number | null = null): void {
      const now = new Date().toISOString();
      touchHeartbeat(this.directory);
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
