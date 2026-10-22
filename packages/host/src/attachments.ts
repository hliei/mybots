import { lstat, mkdir, open, readdir, readFile, realpath, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { ChatRequestError } from "./chat.ts";

/** Initial per-file limit: 25 MiB. */
export const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;

const IDENTITY = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function fileLimitMessage(maxBytes: number): string {
  return maxBytes === DEFAULT_MAX_FILE_BYTES
    ? "File exceeds the 25 MiB limit."
    : `File exceeds the installation file limit of ${maxBytes} bytes.`;
}

export function attachmentFilename(value: string): string {
  if (
    value.length === 0 ||
    value.length > 120 ||
    value !== value.trim() ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  )
    throw new ChatRequestError(
      "File name must be a single path segment of at most 120 characters.",
    );
  return value;
}

/** Real directory for one Task. Other Tasks and Bots do not receive this path. */
export async function ensureTaskAttachmentDirectory(
  root: string,
  botId: string,
  taskId: string,
): Promise<string> {
  if (!IDENTITY.test(botId) || !IDENTITY.test(taskId))
    throw new ChatRequestError("Task not found.", 404);
  const base = await realpath(root);
  let current = base;
  for (const part of ["data", "task-attachments", botId, taskId]) {
    current = join(current, part);
    await mkdir(current, { mode: 0o700 }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error("Task attachments must use real directories");
  }
  if ((await realpath(current)) !== current)
    throw new Error("Task attachments must use real directories");
  return current;
}

export async function writeTaskAttachment(
  directory: string,
  filename: string,
  bytes: Buffer,
): Promise<void> {
  const name = attachmentFilename(filename);
  const handle = await open(join(directory, name), "wx", 0o600);
  try {
    await handle.writeFile(bytes);
  } catch (error) {
    await handle.close();
    await rm(join(directory, name), { force: true });
    throw error;
  }
  await handle.close();
}

export async function readTaskAttachment(directory: string, filename: string): Promise<Buffer> {
  const name = attachmentFilename(filename);
  const file = join(directory, name);
  const info = await lstat(file).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new ChatRequestError("Attachment not found.", 404);
    throw error;
  });
  if (info.isSymbolicLink() || !info.isFile())
    throw new ChatRequestError("Attachment not found.", 404);
  return readFile(file);
}

export function workspaceRelativePath(value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0 || value.length > 240 || value.includes("\0"))
    throw new ChatRequestError("Workspace path must stay inside this Bot workspace.");
  const parts = value.split("/");
  if (
    parts.some((part) => part.length === 0 || part === "." || part === "..") ||
    parts[0] === ".task-attachments"
  )
    throw new ChatRequestError("Workspace path must stay inside this Bot workspace.");
  return parts;
}

/** Copy bytes to a new file inside the Bot workspace, rejecting links and escapes. */
export async function saveInsideWorkspace(
  workspace: string,
  parts: string[],
  bytes: Buffer,
): Promise<string> {
  const root = await realpath(workspace);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    await mkdir(current, { mode: 0o755 }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory() || (await realpath(current)) !== current)
      throw new ChatRequestError("Workspace path must stay inside this Bot workspace.");
    if (current !== root && !current.startsWith(`${root}${sep}`))
      throw new ChatRequestError("Workspace path must stay inside this Bot workspace.");
  }
  const file = join(current, parts.at(-1) as string);
  const info = await lstat(file).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (info)
    throw new ChatRequestError(
      info.isSymbolicLink()
        ? "Workspace path must stay inside this Bot workspace."
        : "Workspace file already exists.",
      info.isSymbolicLink() ? 400 : 409,
    );
  const handle = await open(file, "wx", 0o644);
  try {
    await handle.writeFile(bytes);
  } catch (error) {
    await handle.close();
    await rm(file, { force: true });
    throw error;
  }
  await handle.close();
  return file;
}

/** Regular files deliberately stored in one Bot workspace. Links are not followed. */
export async function listWorkspaceFiles(
  workspace: string,
): Promise<{ path: string; bytes: number }[]> {
  const root = await realpath(workspace);
  const files: { path: string; bytes: number }[] = [];
  await collectWorkspaceFiles(root, root, files);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

async function collectWorkspaceFiles(
  root: string,
  directory: string,
  files: { path: string; bytes: number }[],
): Promise<void> {
  if (files.length >= 1000) return;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (files.length >= 1000) return;
    if (entry.isSymbolicLink()) continue;
    const full = join(directory, entry.name);
    const info = await lstat(full);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      if ((await realpath(full)) !== full) continue;
      await collectWorkspaceFiles(root, full, files);
    } else if (info.isFile()) {
      const path = relative(root, full).split(sep).join("/");
      files.push({ path, bytes: info.size });
    }
  }
}

/** Read one workspace file without following a link outside the Bot workspace. */
export async function readWorkspaceFile(
  workspace: string,
  parts: string[],
  maxBytes: number,
): Promise<Buffer> {
  const root = await realpath(workspace);
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const info = await lstat(current).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new ChatRequestError("Workspace file not found.", 404);
      throw error;
    });
    if (
      info.isSymbolicLink() ||
      (await realpath(current)) !== current ||
      (current !== root && !current.startsWith(`${root}${sep}`))
    )
      throw new ChatRequestError("Workspace path must stay inside this Bot workspace.");
    if (index < parts.length - 1 && !info.isDirectory())
      throw new ChatRequestError("Workspace file not found.", 404);
  }
  const info = await lstat(current);
  if (!info.isFile()) throw new ChatRequestError("Workspace file not found.", 404);
  if (info.size > maxBytes) throw new ChatRequestError(fileLimitMessage(maxBytes), 413);
  return readFile(current);
}
