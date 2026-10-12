import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Message, ToolCall } from "./messages.ts";

/** Session metadata stored in the JSONL index, matching the reference contract. */
export interface SessionRecord {
  id: string;
  agent_id: string;
  title: string | null;
  message_count: number;
  created_at: string;
  updated_at: string;
}

/** One recorded conversation message, matching the reference JSONL contract. */
export interface HistoryMessage {
  timestamp: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_calls: ToolCall[] | null;
  tool_call_id: string | null;
  reasoning_content?: string;
}

interface IndexEntry {
  record: SessionRecord;
  raw: Record<string, unknown>;
}

const roles = ["user", "assistant", "system", "tool"] as const;
const titleLength = 50;

function nowIso(now: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` +
    `.${pad(now.getMilliseconds() * 1000, 6)}`
  );
}

async function nonBlankLines(path: string): Promise<string[]> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function parse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function sessionRecord(raw: Record<string, unknown>): SessionRecord | undefined {
  if (
    typeof raw.id !== "string" ||
    typeof raw.agent_id !== "string" ||
    typeof raw.created_at !== "string" ||
    typeof raw.updated_at !== "string"
  ) {
    return undefined;
  }
  if (raw.title !== null && raw.title !== undefined && typeof raw.title !== "string")
    return undefined;
  if (
    raw.message_count !== undefined &&
    (typeof raw.message_count !== "number" || !Number.isInteger(raw.message_count))
  ) {
    return undefined;
  }
  return {
    id: raw.id,
    agent_id: raw.agent_id,
    title: typeof raw.title === "string" ? raw.title : null,
    message_count: typeof raw.message_count === "number" ? raw.message_count : 0,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
  };
}

function toolCalls(value: unknown): ToolCall[] | undefined {
  if (value === null || value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const calls: ToolCall[] = [];
  for (const entry of value) {
    const call = asRecord(entry);
    const fn = asRecord(call?.function);
    if (
      typeof call?.id !== "string" ||
      call.type !== "function" ||
      typeof fn?.name !== "string" ||
      typeof fn.arguments !== "string"
    ) {
      return undefined;
    }
    calls.push({
      id: call.id,
      type: "function",
      function: { name: fn.name, arguments: fn.arguments },
    });
  }
  return calls;
}

function historyMessage(value: unknown): HistoryMessage | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  if (!roles.includes(raw.role as (typeof roles)[number])) return undefined;
  if (typeof raw.timestamp !== "string") return undefined;
  const content = typeof raw.content === "string" ? raw.content : raw.content === null ? "" : null;
  if (content === null) return undefined;
  const calls = toolCalls(raw.tool_calls);
  if (raw.tool_calls != null && !calls) return undefined;
  if (
    raw.tool_call_id !== null &&
    raw.tool_call_id !== undefined &&
    typeof raw.tool_call_id !== "string"
  )
    return undefined;
  if (
    raw.reasoning_content !== undefined &&
    raw.reasoning_content !== null &&
    typeof raw.reasoning_content !== "string"
  ) {
    return undefined;
  }
  return {
    timestamp: raw.timestamp,
    role: raw.role as HistoryMessage["role"],
    content,
    tool_calls: calls ?? null,
    tool_call_id: typeof raw.tool_call_id === "string" ? raw.tool_call_id : null,
    ...(typeof raw.reasoning_content === "string"
      ? { reasoning_content: raw.reasoning_content }
      : {}),
  };
}

function toHistoryMessage(message: Message, timestamp: string): HistoryMessage {
  const base = {
    timestamp,
    role: message.role,
    content: message.content,
    tool_calls: message.role === "assistant" ? (message.tool_calls ?? null) : null,
    tool_call_id: message.role === "tool" ? message.tool_call_id : null,
  };
  return message.role === "assistant" && message.reasoning_content !== undefined
    ? { ...base, reasoning_content: message.reasoning_content }
    : base;
}

function serialized(value: object): string {
  return `${JSON.stringify(value)}\n`;
}

function byUpdatedAtDesc(left: SessionRecord, right: SessionRecord): number {
  return right.updated_at.localeCompare(left.updated_at);
}

/**
 * Reference-compatible JSONL conversation history: an append-only message log
 * per session plus a session index, both read through this interface.
 */
export class ConversationHistory {
  private readonly sessionsPath: string;
  private readonly indexFile: string;
  private readonly now: () => Date;

  private constructor(historyPath: string, now: () => Date) {
    this.sessionsPath = join(historyPath, "sessions");
    this.indexFile = join(historyPath, "index.jsonl");
    this.now = now;
  }

  static async open(historyPath: string, options: { now?: () => Date } = {}) {
    return new ConversationHistory(resolve(historyPath), options.now ?? (() => new Date()));
  }

  /** Create the session index entry and empty message log for a new session. */
  async createSession(agentId: string, sessionId: string): Promise<SessionRecord> {
    await mkdir(this.sessionsPath, { recursive: true });
    const timestamp = nowIso(this.now());
    const record: SessionRecord = {
      id: sessionId,
      agent_id: agentId,
      title: null,
      message_count: 0,
      created_at: timestamp,
      updated_at: timestamp,
    };
    await appendFile(this.indexFile, serialized(record));
    await appendFile(this.sessionPath(sessionId), "");
    return record;
  }

  /** Append one message and update the session index. */
  async saveMessage(sessionId: string, message: Message): Promise<void> {
    const entries = await this.readIndex();
    const entry = entries.find((candidate) => candidate.record.id === sessionId);
    if (!entry) throw new Error(`Session not found: ${sessionId}`);
    const record = toHistoryMessage(message, nowIso(this.now()));
    await appendFile(this.sessionPath(sessionId), serialized(record));
    entry.record.message_count += 1;
    entry.record.updated_at = nowIso(this.now());
    if (entry.record.title === null && record.role === "user") {
      entry.record.title =
        record.content.length > titleLength
          ? `${record.content.slice(0, titleLength)}...`
          : record.content;
    }
    await this.writeIndex(entries);
  }

  /** Sessions ordered most recently updated first. */
  async listSessions(): Promise<SessionRecord[]> {
    return (await this.readIndex()).map((entry) => entry.record).sort(byUpdatedAtDesc);
  }

  async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    return (await this.readIndex()).find((entry) => entry.record.id === sessionId)?.record;
  }

  /** Recorded messages in order; unreadable records are skipped. */
  async getMessages(sessionId: string): Promise<HistoryMessage[]> {
    const messages: HistoryMessage[] = [];
    for (const line of await nonBlankLines(this.sessionPath(sessionId))) {
      const record = historyMessage(parse(line));
      if (record) messages.push(record);
    }
    return messages;
  }

  private sessionPath(sessionId: string): string {
    return join(this.sessionsPath, `${sessionId}.jsonl`);
  }

  private async readIndex(): Promise<IndexEntry[]> {
    const entries: IndexEntry[] = [];
    for (const line of await nonBlankLines(this.indexFile)) {
      const raw = asRecord(parse(line));
      const record = raw ? sessionRecord(raw) : undefined;
      if (raw && record) entries.push({ record, raw });
    }
    return entries;
  }

  private async writeIndex(entries: IndexEntry[]): Promise<void> {
    entries.sort((left, right) => byUpdatedAtDesc(left.record, right.record));
    await writeFile(
      this.indexFile,
      entries.map(({ record, raw }) => serialized({ ...raw, ...record })).join(""),
    );
  }
}
