import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { summaryMessage } from "./compaction.ts";
import type { Message, ToolCall } from "./messages.ts";

export interface Completion {
  turnId: string;
  replyId: string;
  payload: string;
  destination: string;
}

export interface PendingReply extends Completion {
  sessionId: string;
  confirmedChunks: number;
}

function completion(value: unknown): Completion | undefined {
  const raw = asRecord(value);
  if (
    typeof raw?.turnId !== "string" ||
    !raw.turnId ||
    typeof raw.replyId !== "string" ||
    !raw.replyId ||
    typeof raw.payload !== "string" ||
    typeof raw.destination !== "string" ||
    !/^(platform-cli:cli-user|platform-telegram:\d+:-?\d+|platform-ws:.+)$/.test(raw.destination)
  )
    return undefined;
  return {
    turnId: raw.turnId,
    replyId: raw.replyId,
    payload: raw.payload,
    destination: raw.destination,
  };
}

function deliveryProjection(entries: LogEntry[], sessionId: string): PendingReply[] {
  const replies = new Map<string, PendingReply>();
  const acknowledged = new Set<string>();
  const turns = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const raw = entry.raw;
    if (!raw) continue;
    if (Object.hasOwn(raw, "completion")) {
      const saved = completion(raw.completion);
      const inputs = entries.slice(0, index).filter((candidate) => candidate.id === saved?.turnId);
      if (
        !saved ||
        !entry.message ||
        entry.message.role !== "assistant" ||
        entry.message.tool_calls?.length ||
        saved.payload !== entry.message.content ||
        typeof raw.id !== "string" ||
        !raw.id ||
        inputs.length !== 1 ||
        inputs[0].message?.role !== "user" ||
        replies.has(saved.replyId) ||
        turns.has(saved.turnId)
      ) {
        throw new Error(`Invalid completion metadata in session ${sessionId}, line ${entry.line}`);
      }
      turns.add(saved.turnId);
      replies.set(saved.replyId, { ...saved, sessionId, confirmedChunks: 0 });
    }
    if (raw.type === "reply_progress" || raw.type === "reply_acknowledged") {
      const reply = typeof raw.replyId === "string" ? replies.get(raw.replyId) : undefined;
      if (!reply)
        throw new Error(`Invalid delivery state in session ${sessionId}, line ${entry.line}`);
      if (raw.type === "reply_acknowledged") acknowledged.add(reply.replyId);
      else {
        if (
          !Number.isSafeInteger(raw.confirmedChunks) ||
          (raw.confirmedChunks as number) < reply.confirmedChunks ||
          acknowledged.has(reply.replyId)
        )
          throw new Error(`Invalid chunk progress in session ${sessionId}, line ${entry.line}`);
        reply.confirmedChunks = raw.confirmedChunks as number;
      }
    }
  }
  return [...replies.values()].filter((reply) => !acknowledged.has(reply.replyId));
}

/** Session metadata stored in the JSONL index. */
export interface SessionRecord {
  id: string;
  agent_id: string;
  title: string | null;
  message_count: number;
  created_at: string;
  updated_at: string;
}

/** One recorded conversation message in the JSONL message log. */
export interface HistoryMessage {
  timestamp: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_calls: ToolCall[] | null;
  tool_call_id: string | null;
  reasoning_content?: string;
  completion?: Completion;
  interrupted_tool_call?: { assistantEntryId: string; outcome: "unknown" };
}

interface IndexEntry {
  record: SessionRecord;
  raw: Record<string, unknown>;
}

export interface RecoveredContext {
  messages: { id: string; message: Message }[];
  summary?: Message;
  diagnostics: string[];
}

interface LogEntry {
  raw?: Record<string, unknown>;
  id: string;
  message?: HistoryMessage;
  line: number;
}

function toolExchanges(entries: readonly LogEntry[]) {
  const originals = entries.filter(
    (entry) => entry.message && !entry.message.interrupted_tool_call,
  );
  return originals.flatMap((assistant, index) => {
    const calls =
      assistant.message?.role === "assistant" ? assistant.message.tool_calls : undefined;
    if (!calls?.length) return [];
    const results: LogEntry[] = [];
    for (let next = index + 1; originals[next]?.message?.role === "tool"; next++)
      results.push(originals[next]);
    const repairs = entries.filter(
      (entry) => entry.message?.interrupted_tool_call?.assistantEntryId === assistant.id,
    );
    return [{ assistant, calls, results, repairs }];
  });
}

function pendingCalls(entries: readonly LogEntry[]) {
  return toolExchanges(entries).flatMap(({ assistant, calls, results, repairs }) => {
    const saved = new Set([...results, ...repairs].map((entry) => entry.message?.tool_call_id));
    return calls
      .filter((call) => !saved.has(call.id))
      .map((call) => ({ assistantEntryId: assistant.id, call }));
  });
}

function projectContext(entries: LogEntry[], diagnostics: string[]): RecoveredContext {
  let start = 0;
  let summary: Message | undefined;
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
  for (let index = entries.length - 1; index >= 0; index--) {
    const { raw, id, line } = entries[index];
    if (raw?.type !== "compaction") continue;
    const boundary = raw.firstKeptEntryId;
    const kept = entries.findIndex((entry) => entry.id === boundary);
    const empty = boundary === id;
    const valid =
      typeof raw.id === "string" &&
      raw.id.length > 0 &&
      counts.get(id) === 1 &&
      typeof raw.summary === "string" &&
      raw.summary.trim().length > 0 &&
      typeof boundary === "string" &&
      counts.get(boundary) === 1 &&
      (empty ||
        (kept >= 0 &&
          kept < index &&
          (entries[kept].message?.role === "user" ||
            entries[kept].message?.role === "assistant"))) &&
      pendingCalls([
        ...entries.slice(0, empty ? index : kept),
        ...entries.slice(0, index).filter((entry) => entry.message?.interrupted_tool_call),
      ]).length === 0;
    if (!valid) {
      diagnostics.push(
        `Line ${line}: invalid compaction summary, identity, or retention boundary.`,
      );
      continue;
    }
    for (const key of ["tokensBefore", "tokensAfter"]) {
      if (
        raw[key] !== undefined &&
        (typeof raw[key] !== "number" || !Number.isFinite(raw[key]) || raw[key] < 0)
      ) {
        diagnostics.push(`Line ${line}: ignoring invalid compaction statistic ${key}.`);
      }
    }
    start = empty ? index + 1 : kept;
    summary = summaryMessage(raw.summary as string);
    break;
  }
  const retained = entries.slice(start);
  const insertions = new Map<LogEntry, LogEntry[]>();
  for (const { assistant, results, repairs } of toolExchanges(retained)) {
    insertions.set(results.at(-1) ?? assistant, repairs);
  }
  return {
    messages: retained
      .filter((entry) => entry.message && !entry.message.interrupted_tool_call)
      .flatMap((entry) => [entry, ...(insertions.get(entry) ?? [])])
      .flatMap(({ id, message }) => (message ? [{ id, message: toMessage(message) }] : [])),
    summary,
    diagnostics,
  };
}

function toMessage(record: HistoryMessage): Message {
  const {
    timestamp: _timestamp,
    completion: _completion,
    interrupted_tool_call: _interruption,
    tool_calls,
    tool_call_id,
    ...fields
  } = record;
  const { role, content } = fields;
  if (role === "assistant") {
    return { ...fields, role, content, ...(tool_calls !== null ? { tool_calls } : {}) };
  }
  if (role === "tool") return { ...fields, role, content, tool_call_id: tool_call_id ?? "" };
  return { ...fields, role, content };
}

const roles = ["user", "assistant", "system", "tool"] as const;
const titleLength = 50;
// One process may open several history readers for the same Workspace.
const writes = new Map<string, Promise<void>>();

function sessionTitle(content: string): string {
  const characters = Array.from(content);
  return characters.length > titleLength
    ? `${characters.slice(0, titleLength).join("")}...`
    : content;
}

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

function sessionMetadata(value: unknown) {
  const raw = asRecord(value);
  if (
    raw?.type !== "session" ||
    typeof raw.id !== "string" ||
    !raw.id ||
    typeof raw.agent_id !== "string" ||
    !raw.agent_id ||
    typeof raw.created_at !== "string" ||
    !raw.created_at
  )
    return undefined;
  return { id: raw.id, agent_id: raw.agent_id, created_at: raw.created_at };
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
      !call.id ||
      call.type !== "function" ||
      typeof fn?.name !== "string" ||
      !fn.name ||
      typeof fn.arguments !== "string"
    ) {
      return undefined;
    }
    calls.push(call as unknown as ToolCall);
  }
  return calls;
}

function historyMessage(value: unknown): HistoryMessage | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  if (raw.type !== undefined) return undefined;
  if (raw.id !== undefined && (typeof raw.id !== "string" || !raw.id)) return undefined;
  if (!roles.includes(raw.role as (typeof roles)[number])) return undefined;
  if (typeof raw.timestamp !== "string") return undefined;
  const content = typeof raw.content === "string" ? raw.content : raw.content === null ? "" : null;
  if (content === null) return undefined;
  const calls = toolCalls(raw.tool_calls);
  if (raw.tool_calls != null && !calls) return undefined;
  if (raw.role !== "assistant" && calls?.length) return undefined;
  if (raw.role === "tool" && (typeof raw.tool_call_id !== "string" || !raw.tool_call_id))
    return undefined;
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
  const interruption = asRecord(raw.interrupted_tool_call);
  if (
    raw.interrupted_tool_call !== undefined &&
    (raw.role !== "tool" ||
      typeof interruption?.assistantEntryId !== "string" ||
      !interruption.assistantEntryId ||
      interruption.outcome !== "unknown")
  )
    return undefined;
  const { id: _id, reasoning_content: _reasoning, ...fields } = raw;
  return {
    ...fields,
    timestamp: raw.timestamp,
    role: raw.role as HistoryMessage["role"],
    content,
    tool_calls: calls ?? null,
    tool_call_id: typeof raw.tool_call_id === "string" ? raw.tool_call_id : null,
    ...(typeof raw.reasoning_content === "string"
      ? { reasoning_content: raw.reasoning_content }
      : {}),
    ...(interruption
      ? {
          interrupted_tool_call: {
            assistantEntryId: interruption.assistantEntryId as string,
            outcome: "unknown" as const,
          },
        }
      : {}),
  };
}

function toHistoryMessage(message: Message, timestamp: string): HistoryMessage {
  const { role, content, ...fields } = message;
  return {
    timestamp,
    role,
    content,
    tool_calls: message.role === "assistant" ? (message.tool_calls ?? null) : null,
    tool_call_id: message.role === "tool" ? message.tool_call_id : null,
    ...fields,
  };
}

function serialized(value: object): string {
  return `${JSON.stringify(value)}\n`;
}

function byUpdatedAtDesc(left: SessionRecord, right: SessionRecord): number {
  return right.updated_at.localeCompare(left.updated_at);
}

/**
 * JSONL conversation history: an append-only message log
 * per session plus a session index, both read through this interface.
 */
export class ConversationHistory {
  private readonly sessionsPath: string;
  private readonly indexFile: string;
  private readonly pendingPath: string;
  private readonly now: () => Date;

  private constructor(historyPath: string, now: () => Date, eventPath: string) {
    this.pendingPath = join(eventPath, "pending");
    this.sessionsPath = join(historyPath, "sessions");
    this.indexFile = join(historyPath, "index.jsonl");
    this.now = now;
  }

  static async open(historyPath: string, options: { now?: () => Date; eventPath?: string } = {}) {
    return new ConversationHistory(
      resolve(historyPath),
      options.now ?? (() => new Date()),
      resolve(options.eventPath ?? join(historyPath, "..", ".event")),
    );
  }

  /** Create session metadata in the log and its index entry. */
  async createSession(agentId: string, sessionId: string): Promise<SessionRecord> {
    return this.mutate(async () => {
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
      await writeFile(
        this.sessionPath(sessionId),
        serialized({ type: "session", id: sessionId, agent_id: agentId, created_at: timestamp }),
        { flag: "wx", flush: true },
      );
      await appendFile(this.indexFile, serialized(record));
      return record;
    });
  }

  /** Append one message and update the session index. */
  async saveMessage(sessionId: string, message: Message): Promise<string> {
    return this.saveRecord(sessionId, message);
  }

  async saveCompletion(sessionId: string, message: Message, metadata: Completion): Promise<string> {
    if (!completion(metadata))
      throw new Error(`Invalid completion metadata in session ${sessionId}`);
    return this.saveRecord(sessionId, message, metadata);
  }

  private async saveRecord(
    sessionId: string,
    message: Message,
    metadata?: Completion,
  ): Promise<string> {
    return this.mutate(async () => {
      const entries = await this.readIndex();
      const entry = entries.find((candidate) => candidate.record.id === sessionId);
      if (!entry) throw new Error(`Session not found: ${sessionId}`);
      const id = randomUUID();
      const record = {
        id,
        ...toHistoryMessage(message, nowIso(this.now())),
        ...(metadata ? { completion: metadata } : {}),
      };
      const { entries: log } = await this.readLog(sessionId);
      deliveryProjection(
        [...log, { id, raw: record, message: historyMessage(record), line: log.length + 1 }],
        sessionId,
      );
      await this.appendRecord(sessionId, record);
      entry.record.message_count = (await this.getMessages(sessionId)).length;
      entry.record.updated_at = nowIso(this.now());
      if (entry.record.title === null && record.role === "user") {
        entry.record.title = sessionTitle(record.content);
      }
      await this.writeIndex(entries);
      if (metadata)
        await this.repairPending(
          sessionId,
          deliveryProjection((await this.readLog(sessionId)).entries, sessionId),
        );
      return id;
    });
  }

  async saveCompaction(
    sessionId: string,
    summary: string,
    firstKeptEntryId: string | undefined,
  ): Promise<void> {
    return this.mutate(async () => {
      const id = randomUUID();
      await this.appendRecord(sessionId, {
        type: "compaction",
        id,
        timestamp: nowIso(this.now()),
        summary,
        firstKeptEntryId: firstKeptEntryId ?? id,
      });
    });
  }

  /** Sessions ordered most recently updated first. */
  async listSessions(): Promise<SessionRecord[]> {
    return (await this.readIndex()).map((entry) => entry.record).sort(byUpdatedAtDesc);
  }

  async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    const indexed = (await this.readIndex()).find((entry) => entry.record.id === sessionId)?.record;
    if (indexed) return indexed;
    const records = (await nonBlankLines(this.sessionPath(sessionId))).map((line) =>
      asRecord(parse(line)),
    );
    const metadata = records.map(sessionMetadata).find((record) => record?.id === sessionId);
    if (!metadata) return undefined;
    const messages = records.flatMap((raw) => {
      const message = historyMessage(raw);
      return message ? [message] : [];
    });
    const firstUser = messages.find((message) => message.role === "user");
    return {
      id: sessionId,
      agent_id: metadata.agent_id,
      created_at: metadata.created_at,
      updated_at: messages.at(-1)?.timestamp ?? metadata.created_at,
      title: firstUser ? sessionTitle(firstUser.content) : null,
      message_count: messages.length,
    };
  }

  async recoverContext(sessionId: string): Promise<RecoveredContext> {
    return this.mutate(async () => {
      const { entries, diagnostics } = await this.readLog(sessionId);
      const missing = pendingCalls(entries);
      const lastMessage = entries.findLastIndex((entry) => entry.message);
      const last = entries[lastMessage]?.message;
      const closed = entries
        .slice(lastMessage + 1)
        .some(({ raw }) => raw?.type === "turn_interrupted");
      const unfinished = last && (last.role !== "assistant" || last.tool_calls?.length);
      if (missing.length || (unfinished && !closed)) {
        for (const { call, assistantEntryId } of missing) {
          const id = randomUUID();
          const record = toHistoryMessage(
            {
              role: "tool",
              tool_call_id: call.id,
              content: "Tool execution interrupted; outcome unknown.",
            },
            nowIso(this.now()),
          );
          record.interrupted_tool_call = { assistantEntryId, outcome: "unknown" };
          await this.appendRecord(sessionId, { id, ...record });
          entries.push({ id, raw: { id, ...record }, message: record, line: entries.length + 1 });
        }
        const id = randomUUID();
        await this.appendRecord(sessionId, {
          type: "turn_interrupted",
          id,
          timestamp: nowIso(this.now()),
          tool_call_ids: missing.map(({ call }) => call.id),
        });
        diagnostics.push(
          "Interrupted turn closed without executing tools or restarting the request.",
        );
      }
      const index = await this.readIndex();
      let entry = index.find((candidate) => candidate.record.id === sessionId);
      if (!entry) {
        const record = await this.getSession(sessionId);
        if (!record) throw new Error(`Session not found: ${sessionId}`);
        entry = { record, raw: { ...record } };
        index.push(entry);
      }
      entry.record.message_count = entries.filter((entry) => entry.message).length;
      await this.writeIndex(index);
      await this.repairPending(sessionId, deliveryProjection(entries, sessionId));
      return projectContext(entries, diagnostics);
    });
  }

  /** Pending replies are reconstructed in completion order; files are only projections. */
  async getPendingReplies(sessionId: string): Promise<PendingReply[]> {
    return this.mutate(async () => {
      const { entries } = await this.readLog(sessionId);
      const replies = deliveryProjection(entries, sessionId);
      await this.repairPending(sessionId, replies);
      return replies;
    });
  }

  async confirmChunks(sessionId: string, replyId: string, confirmedChunks: number): Promise<void> {
    await this.saveDeliveryState(sessionId, { type: "reply_progress", replyId, confirmedChunks });
  }

  async acknowledgeReply(sessionId: string, replyId: string): Promise<void> {
    await this.saveDeliveryState(sessionId, { type: "reply_acknowledged", replyId });
  }

  private async saveDeliveryState(
    sessionId: string,
    state: Record<string, unknown>,
  ): Promise<void> {
    return this.mutate(async () => {
      const { entries } = await this.readLog(sessionId);
      const id = randomUUID();
      const record = { ...state, id, timestamp: nowIso(this.now()) };
      const replies = deliveryProjection(
        [...entries, { id, raw: record, line: entries.length + 1 }],
        sessionId,
      );
      await this.appendRecord(sessionId, record);
      await this.repairPending(sessionId, replies);
    });
  }

  private async repairPending(sessionId: string, replies: PendingReply[]): Promise<void> {
    const directory = join(this.pendingPath, encodeURIComponent(sessionId));
    await mkdir(directory, { recursive: true });
    const filenames = new Set<string>();
    for (const reply of replies) {
      const filename = `${encodeURIComponent(reply.replyId)}.json`;
      filenames.add(filename);
      const temporary = join(directory, `.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, serialized(reply), { flush: true });
        await rename(temporary, join(directory, filename));
      } finally {
        await rm(temporary, { force: true });
      }
    }
    for (const filename of await readdir(directory)) {
      if (filename.endsWith(".json") && !filenames.has(filename))
        await rm(join(directory, filename), { force: true });
    }
  }

  private async mutate<T>(action: () => Promise<T>): Promise<T> {
    const previous = writes.get(this.indexFile) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    writes.set(this.indexFile, current);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (writes.get(this.indexFile) === current) writes.delete(this.indexFile);
    }
  }

  private async readLog(sessionId: string) {
    const source = await readFile(this.sessionPath(sessionId), "utf8");
    const diagnostics: string[] = [];
    const entries: LogEntry[] = source.split("\n").flatMap((line, index) => {
      if (!line.trim()) return [];
      const raw = asRecord(parse(line));
      if (!raw) diagnostics.push(`Line ${index + 1}: malformed or non-object JSON record skipped.`);
      const message = historyMessage(raw);
      if (raw && raw.type === undefined && !message)
        diagnostics.push(`Line ${index + 1}: invalid message record skipped.`);
      return [
        {
          raw,
          id: typeof raw?.id === "string" ? raw.id : `legacy:${index + 1}`,
          message,
          line: index + 1,
        },
      ];
    });
    const session = await this.getSession(sessionId);
    const metadata = entries.some(({ raw }) => {
      const record = sessionMetadata(raw);
      return record?.id === sessionId && record.agent_id === session?.agent_id;
    });
    if (source.length > 0 && !metadata && !(session && entries.some((entry) => entry.message))) {
      throw new Error(`Unrecognizable session log: ${sessionId}`);
    }
    deliveryProjection(entries, sessionId);
    return { source, entries, diagnostics };
  }

  private async appendRecord(sessionId: string, record: object): Promise<void> {
    const { source } = await this.readLog(sessionId);
    await appendFile(
      this.sessionPath(sessionId),
      `${source && !source.endsWith("\n") ? "\n" : ""}${serialized(record)}`,
      { flush: true },
    );
  }

  /** Recorded messages in order; unreadable records are skipped. */
  async getMessages(sessionId: string): Promise<HistoryMessage[]> {
    const { entries } = await this.readLog(sessionId);
    return entries.flatMap((entry) => (entry.message ? [entry.message] : []));
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
