import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Shared filesystem exclusion; host and VM kernel advisory locks need not interoperate. */
export function lockDatabase(directory: string, side: "inbound" | "outbound"): () => void {
  const path = join(directory, `.${side}.lock`);
  const deadline = performance.now() + 5000;
  while (true) {
    try {
      mkdirSync(path);
      return () => rmSync(path, { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (performance.now() >= deadline)
        throw new Error("Mailbox lock unavailable; stop its runtime before recovery");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}

/** Only after all holders have stopped; never steal a live reader or writer lock. */
export function clearMailboxLocks(directory: string): void {
  for (const side of ["inbound", "outbound"])
    rmSync(join(directory, `.${side}.lock`), { recursive: true, force: true });
}
