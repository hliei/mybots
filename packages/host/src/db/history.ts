import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { ChatRequestError } from "../chat.ts";

interface Original {
  id: string;
  seq: number;
  runId: string;
  role: string;
  content: string;
  createdAt: string;
}
export interface HistoryScope {
  threadId: string;
  backgroundBoundary: number;
  searchBeforeSeq?: number;
}
function integer(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new ChatRequestError("Invalid history cursor or text offset.");
  return value;
}
function excerpt(row: Original, limit: number, offset: number) {
  const chars = Array.from(row.content);
  const end = Math.min(chars.length, offset + limit);
  const { content: _, ...source } = row;
  return {
    ...source,
    text: chars.slice(offset, end).join(""),
    textOffset: offset,
    nextTextOffset: end < chars.length ? end : null,
    truncated: offset > 0 || end < chars.length,
  };
}

/** Read-only original navigation; no SDK session is opened by these queries. */
export function history(db: DatabaseSync, scope: HistoryScope, value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ChatRequestError("History requires an object.");
  const input = value as Record<string, unknown>;
  const fields = ["query", "beforeSeq", "messageId", "direction", "textOffset"];
  if (Object.keys(input).some((key) => !fields.includes(key)))
    throw new ChatRequestError("Unknown history field.");
  const before = integer(input.beforeSeq, Number.MAX_SAFE_INTEGER);
  const offset = integer(input.textOffset, 0);
  const query = input.query;
  if (query !== undefined && (typeof query !== "string" || !query.trim() || query.length > 500))
    throw new ChatRequestError("History query must contain 1 to 500 characters.");
  if (query !== undefined && input.messageId !== undefined)
    throw new ChatRequestError("Choose search or anchor reading.");
  const searching = typeof query === "string";
  const terms = searching ? query.normalize("NFKC").toLowerCase().trim().split(/\s+/u) : [];
  const select =
    "SELECT id, seq, run_id AS runId, role, content, created_at AS createdAt FROM thread_messages";
  const visibility = "thread_id = ? AND seq >= ?";
  const args: SQLInputValue[] = [scope.threadId, scope.backgroundBoundary];
  let rows: Original[];
  let descending = true;
  if (input.messageId !== undefined) {
    if (typeof input.messageId !== "string") throw new ChatRequestError("Invalid history anchor.");
    const anchor = db
      .prepare(`${select} WHERE ${visibility} AND id = ?`)
      .get(...args, input.messageId) as unknown as Original | undefined;
    if (!anchor) throw new ChatRequestError("History anchor not found.", 404);
    const direction = input.direction ?? "around";
    if (!["around", "older", "newer"].includes(direction as string))
      throw new ChatRequestError("Invalid history direction.");
    descending = direction === "older";
    const preceding = db
      .prepare(`${select} WHERE ${visibility} AND seq < ? ORDER BY seq DESC LIMIT 2`)
      .all(...args, anchor.seq) as unknown as Original[];
    const aroundStart = preceding.at(-1)?.seq ?? anchor.seq;
    rows =
      input.textOffset !== undefined
        ? [anchor]
        : (db
            .prepare(
              `${select} WHERE ${visibility} AND seq ${direction === "older" ? "<" : direction === "newer" ? ">" : ">="} ? ORDER BY seq ${descending ? "DESC" : "ASC"} LIMIT 6`,
            )
            .all(
              ...args,
              direction === "around" ? aroundStart : anchor.seq,
            ) as unknown as Original[]);
  } else {
    rows = [];
    for (const value of db
      .prepare(`${select} WHERE ${visibility} AND seq < ? ORDER BY seq DESC`)
      .iterate(...args, Math.min(before, searching ? (scope.searchBeforeSeq ?? before) : before))) {
      const row = value as unknown as Original;
      const text = row.content.normalize("NFKC").toLowerCase();
      if (!terms.every((term) => text.includes(term))) continue;
      rows.push(row);
      if (rows.length === 6) break;
    }
  }
  const more = rows.length > 5;
  rows = rows.slice(0, 5);
  const messages = rows.map((row) => excerpt(row, searching ? 800 : 2000, offset));
  const runs = [...new Set(rows.map((row) => row.runId))].map((id) => {
    const run = db
      .prepare(
        "SELECT id, task_id AS taskId, state, source_message_id AS sourceMessageId FROM runs WHERE id = ?",
      )
      .get(id);
    const outcome = db
      .prepare(
        "SELECT id FROM thread_messages WHERE run_id = ? AND thread_id = ? AND role = 'assistant' ORDER BY seq DESC LIMIT 1",
      )
      .get(id, scope.threadId);
    return { ...run, outcomeMessageId: outcome?.id ?? null };
  });
  const result = {
    untrusted: true,
    threadId: scope.threadId,
    coverage: {
      fromSeq: scope.backgroundBoundary,
      searchBeforeSeq: searching ? (scope.searchBeforeSeq ?? null) : null,
      status: more ? "partial" : "exhausted",
      scope: searching ? "requested_query_and_range" : "original_page",
    },
    messages,
    runs,
    nextBeforeSeq: descending && more ? (rows.at(-1)?.seq ?? null) : null,
    olderMessageId: rows.length ? rows.reduce((a, b) => (a.seq < b.seq ? a : b)).id : null,
    newerMessageId: rows.length ? rows.reduce((a, b) => (a.seq > b.seq ? a : b)).id : null,
    next: more ? { messageId: rows.at(-1)?.id, direction: descending ? "older" : "newer" } : null,
  };
  // JSON escaping and multibyte text both count toward the complete response bound.
  while (Buffer.byteLength(JSON.stringify(result), "utf8") > 10000) {
    const longest = messages.reduce((a, b) => (a.text.length > b.text.length ? a : b));
    const chars = Array.from(longest.text);
    longest.text = chars.slice(0, Math.floor(chars.length / 2)).join("");
    longest.nextTextOffset = longest.textOffset + Array.from(longest.text).length;
    longest.truncated = true;
  }
  return result;
}
