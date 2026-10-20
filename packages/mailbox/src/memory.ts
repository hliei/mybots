import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, sep } from "node:path";

/** Installation default for each loaded core file. This is not a second context budget. */
export const MEMORY_CORE_CHARACTER_LIMIT = 16_000;

const TOPIC_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface MemoryTopic {
  id: string;
  content: string;
}

export interface MemorySnapshot {
  index: string | null;
  definition: string | null;
  topics: MemoryTopic[];
}

export function memoryVersion(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function memoryCharacters(content: string): number {
  return Array.from(content).length;
}

/** Keep the first 16,000 Unicode characters. The caller names the file for the rest. */
export function clipMemory(content: string): {
  text: string;
  characters: number;
  truncated: boolean;
} {
  const characters = memoryCharacters(content);
  const truncated = characters > MEMORY_CORE_CHARACTER_LIMIT;
  return {
    text: truncated ? Array.from(content).slice(0, MEMORY_CORE_CHARACTER_LIMIT).join("") : content,
    characters,
    truncated,
  };
}

export function memoryTopicId(value: string): string {
  if (!TOPIC_ID.test(value)) throw new Error("Invalid memory topic.");
  return value;
}

export function memoryRevision(snapshot: MemorySnapshot): string {
  const topics = snapshot.topics
    .map((topic) => `${topic.id}:${memoryVersion(topic.content)}`)
    .join(",");
  return [
    `index:${snapshot.index === null ? "-" : memoryVersion(snapshot.index)}`,
    `definition:${snapshot.definition === null ? "-" : memoryVersion(snapshot.definition)}`,
    `topics:${topics}`,
  ].join("\n");
}

const EMPTY_REVISION = "index:-\ndefinition:-\ntopics:";

function coreSection(label: string, path: string, content: string | null): string {
  if (content === null) return `${label}: absent.`;
  const clipped = clipMemory(content);
  const coverage = clipped.truncated
    ? `${MEMORY_CORE_CHARACTER_LIMIT} of ${clipped.characters} characters. Read ${path} for the omitted detail.`
    : `complete, ${clipped.characters} characters.`;
  return `${label}: ${coverage}\n${clipped.text}`;
}

/**
 * Instructions plus the current index and definition, or a change/deletion note.
 * Topic bodies stay on disk for ordinary file reads.
 */
export function renderMemorySupply(
  previousRevision: string | null,
  snapshot: MemorySnapshot,
): { prompt: string; revision: string } {
  const revision = memoryRevision(snapshot);
  const maintenance = [
    "Maintain this Bot's long-term memory as readable Markdown with ordinary file tools.",
    "No approval is required for these edits.",
    "Keep a concise index at memory/index.md and a concise definition at memory/definition.md.",
    "Keep detailed topics at memory/topics/<id>.md, where <id> is lowercase letters, digits, and hyphens.",
    "Do not copy the whole conversation into these files.",
    "Other Bots do not receive them.",
    "Mutable external facts still need a current check at their source.",
  ].join(" ");
  const present =
    snapshot.index !== null || snapshot.definition !== null || snapshot.topics.length > 0;
  const parts = [maintenance];
  if (previousRevision !== null && previousRevision !== revision) {
    parts.push(
      present
        ? "Current long-term memory changed since this Run last supplied it. The index and definition below are current and supersede older recollections in this transcript. Earlier ledger entries stay unchanged."
        : "Long-term memory files were deleted. Stop loading them as current shared memory. This does not erase retained conversation evidence or guarantee forgetting, and later file saves can record facts again.",
    );
  }
  if (present) {
    parts.push(
      coreSection("Index", "memory/index.md", snapshot.index),
      coreSection("Definition", "memory/definition.md", snapshot.definition),
      snapshot.topics.length
        ? `Topics: ${snapshot.topics.map((topic) => topic.id).join(", ")}. Read memory/topics/<id>.md for the full topic. Topic text is not copied here.`
        : "Topics: none.",
    );
  } else if (previousRevision === null || previousRevision === EMPTY_REVISION) {
    return { prompt: maintenance, revision };
  }
  return { prompt: parts.join("\n\n"), revision };
}

async function regularFile(path: string, directory: string): Promise<string | null> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) return null;
  if (!path.startsWith(`${directory}${sep}`)) return null;
  return readFile(path, "utf8");
}

/** Read one Bot workspace's memory files. Symlinks and non-files are omitted. */
export async function readBotMemory(workspace: string): Promise<MemorySnapshot> {
  const directory = join(workspace, "memory");
  const topicsDirectory = join(directory, "topics");
  const index = await regularFile(join(directory, "index.md"), directory);
  const definition = await regularFile(join(directory, "definition.md"), directory);
  let names: string[] = [];
  try {
    const directoryInfo = await lstat(topicsDirectory);
    if (!directoryInfo.isSymbolicLink() && directoryInfo.isDirectory())
      names = await readdir(topicsDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const topics: MemoryTopic[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".md")) continue;
    const id = name.slice(0, -3);
    if (!TOPIC_ID.test(id)) continue;
    const content = await regularFile(join(topicsDirectory, name), topicsDirectory);
    if (content !== null) topics.push({ id, content });
  }
  return { index, definition, topics };
}
