import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import {
  MEMORY_CORE_CHARACTER_LIMIT,
  type MemorySnapshot,
  memoryCharacters,
  memoryTopicId,
  memoryVersion,
  readBotMemory,
} from "@mybots/mailbox";
import { BotRequestError } from "./bots.ts";

export interface MemoryDocument {
  kind: "index" | "definition" | "topic";
  id: string | null;
  content: string;
  version: string;
  characters: number;
  /** True when execution loads only the first 16,000 characters of this core file. */
  truncated: boolean;
}

export interface MemoryView {
  index: MemoryDocument | null;
  definition: MemoryDocument | null;
  topics: MemoryDocument[];
  coreCharacterLimit: number;
}

export class MemoryConflictError extends BotRequestError {
  readonly observed: MemoryDocument | null;
  constructor(observed: MemoryDocument | null) {
    super("Memory changed since it was read. Reread the current file and reconcile.", 409);
    this.observed = observed;
  }
}

function document(
  kind: MemoryDocument["kind"],
  id: string | null,
  content: string,
): MemoryDocument {
  const characters = memoryCharacters(content);
  return {
    kind,
    id,
    content,
    version: memoryVersion(content),
    characters,
    truncated: kind !== "topic" && characters > MEMORY_CORE_CHARACTER_LIMIT,
  };
}

function view(snapshot: MemorySnapshot): MemoryView {
  return {
    index: snapshot.index === null ? null : document("index", null, snapshot.index),
    definition:
      snapshot.definition === null ? null : document("definition", null, snapshot.definition),
    topics: snapshot.topics.map((topic) => document("topic", topic.id, topic.content)),
    coreCharacterLimit: MEMORY_CORE_CHARACTER_LIMIT,
  };
}

export function parseMemorySave(value: unknown): { content: string; version: string | null } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BotRequestError("Memory save requires a JSON object.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "content" && key !== "version"))
    throw new BotRequestError("Memory save accepts only content and version.");
  if (typeof input.content !== "string") throw new BotRequestError("Memory content must be text.");
  if (memoryCharacters(input.content) > 1_000_000)
    throw new BotRequestError("Memory text must be at most 1000000 characters.", 413);
  if (
    input.version !== null &&
    (typeof input.version !== "string" || !/^[a-f0-9]{64}$/.test(input.version))
  )
    throw new BotRequestError(
      "Memory version must be the version you read, or null for a new file.",
    );
  return { content: input.content, version: input.version };
}

export function parseMemoryDelete(value: unknown): { version: string | null } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BotRequestError("Memory deletion requires a JSON object.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "version"))
    throw new BotRequestError("Memory deletion accepts only version.");
  if (
    input.version !== null &&
    (typeof input.version !== "string" || !/^[a-f0-9]{64}$/.test(input.version))
  )
    throw new BotRequestError(
      "Memory version must be the version you read, or null when the file is absent.",
    );
  return { version: input.version };
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new BotRequestError("Memory directory must be a real directory.", 409);
  } catch (error) {
    if (error instanceof BotRequestError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(path, { recursive: true });
  }
}

/** Version-aware owner edits for one Bot workspace. There is no cross-file lock. */
export class BotMemory {
  private readonly workspace: string;
  constructor(workspace: string) {
    this.workspace = workspace;
  }

  async read(): Promise<MemoryView> {
    return view(await readBotMemory(this.workspace));
  }

  private path(kind: "index" | "definition" | "topic", topicId?: string): string {
    const directory = join(this.workspace, "memory");
    if (kind === "index") return join(directory, "index.md");
    if (kind === "definition") return join(directory, "definition.md");
    try {
      return join(join(directory, "topics"), `${memoryTopicId(topicId ?? "")}.md`);
    } catch {
      throw new BotRequestError(
        "Topic id must use lowercase letters, digits, and hyphens (1–64 characters).",
      );
    }
  }

  private async current(
    kind: "index" | "definition" | "topic",
    topicId?: string,
  ): Promise<MemoryDocument | null> {
    const snapshot = await readBotMemory(this.workspace);
    if (kind === "index")
      return snapshot.index === null ? null : document("index", null, snapshot.index);
    if (kind === "definition")
      return snapshot.definition === null
        ? null
        : document("definition", null, snapshot.definition);
    const topic = snapshot.topics.find((item) => item.id === topicId);
    return topic ? document("topic", topic.id, topic.content) : null;
  }

  async save(
    kind: "index" | "definition" | "topic",
    content: string,
    version: string | null,
    topicId?: string,
  ): Promise<MemoryView> {
    const path = this.path(kind, topicId);
    await this.requireRegular(path);
    const current = await this.current(kind, topicId);
    if ((current?.version ?? null) !== version) throw new MemoryConflictError(current);
    await ensureDirectory(join(this.workspace, "memory"));
    if (kind === "topic") await ensureDirectory(join(this.workspace, "memory", "topics"));
    if (!path.startsWith(`${this.workspace}${sep}`))
      throw new BotRequestError("Memory path must stay inside the Bot workspace.");
    await writeFile(path, content);
    return this.read();
  }

  async delete(
    kind: "index" | "definition" | "topic",
    version: string | null,
    topicId?: string,
  ): Promise<MemoryView> {
    const path = this.path(kind, topicId);
    let info: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      info = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (info?.isSymbolicLink()) {
      if (version !== null) throw new MemoryConflictError(null);
      await rm(path);
      return this.read();
    }
    const current = await this.current(kind, topicId);
    if ((current?.version ?? null) !== version) throw new MemoryConflictError(current);
    if (info) await rm(path);
    return this.read();
  }

  private async requireRegular(path: string): Promise<void> {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile())
        throw new BotRequestError(
          "Memory file must be a regular file inside the Bot workspace. Remove the unusual file before saving.",
          409,
        );
    } catch (error) {
      if (error instanceof BotRequestError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
