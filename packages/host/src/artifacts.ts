import { lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { ChatRequestError } from "./chat.ts";

const IDENTITY = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** Real directory for one Bot's immutable delivered snapshots. */
export async function ensureDeliveredArtifactDirectory(
  root: string,
  botId: string,
): Promise<string> {
  if (!IDENTITY.test(botId)) throw new ChatRequestError("Bot not found.", 404);
  const base = await realpath(root);
  let current = base;
  for (const part of ["data", "delivered-artifacts", botId]) {
    current = join(current, part);
    await mkdir(current, { mode: 0o700 }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error("Delivered artifacts must use real directories");
  }
  if ((await realpath(current)) !== current)
    throw new Error("Delivered artifacts must use real directories");
  return current;
}

export async function writeDeliveredArtifact(
  directory: string,
  id: string,
  bytes: Buffer,
): Promise<void> {
  if (!IDENTITY.test(id)) throw new ChatRequestError("Delivered artifact not found.", 404);
  const handle = await open(join(directory, id), "wx", 0o600);
  try {
    await handle.writeFile(bytes);
  } catch (error) {
    await handle.close();
    await rm(join(directory, id), { force: true });
    throw error;
  }
  await handle.close();
}

export async function readDeliveredArtifact(directory: string, id: string): Promise<Buffer> {
  if (!IDENTITY.test(id)) throw new ChatRequestError("Delivered artifact not found.", 404);
  const file = join(directory, id);
  const info = await lstat(file).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new ChatRequestError("Delivered artifact not found.", 404);
    throw error;
  });
  if (info.isSymbolicLink() || !info.isFile())
    throw new ChatRequestError("Delivered artifact not found.", 404);
  return readFile(file);
}
