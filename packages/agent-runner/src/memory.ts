import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readBotMemory, renderMemorySupply } from "@mybots/mailbox";

/** Read current memory and remember what this Run supplied, without editing the SDK ledger. */
export async function currentMemoryPrompt(workspace: string, sessionDir: string): Promise<string> {
  const revisionPath = join(sessionDir, "memory-revision");
  let previous: string | null = null;
  try {
    previous = await readFile(revisionPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const rendered = renderMemorySupply(previous, await readBotMemory(workspace));
  await writeFile(revisionPath, rendered.revision);
  return rendered.prompt;
}
