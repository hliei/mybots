import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { SessionDriver, SessionMaterial } from "../src/drivers/types.ts";
import { RunnerMailbox } from "../src/mailbox/node.ts";

/** External execution boundary: this fixture uses only the runner's mailbox API. */
export class MailboxDriver implements SessionDriver {
  readonly launches: { material: SessionMaterial; continuation?: string }[] = [];
  fail = false;
  async start(material: SessionMaterial, signal: AbortSignal) {
    if (this.fail) throw new Error("Controlled driver unavailable");
    const mailbox = new RunnerMailbox(material.directory);
    this.launches.push({ material, continuation: mailbox.continuation() });
    const controller = new AbortController();
    const runningSignal = AbortSignal.any([signal, controller.signal]);
    const running = (async () => {
      while (!runningSignal.aborted) {
        for (const input of mailbox.pending()) {
          if (runningSignal.aborted) break;
          mailbox.acknowledge(input.id, "processing");
          if (!mailbox.continuation()) {
            const piDirectory = join(material.directory, "pi", "sessions");
            await mkdir(piDirectory, { recursive: true });
            const file = join(piDirectory, "fixture.jsonl");
            await writeFile(file, "Controlled external driver conversation\n");
            mailbox.saveContinuation(`pi:${file}`);
          }
          mailbox.acknowledge(input.id, "completed");
          mailbox.reply(input, `Reply: ${input.content}`);
        }
        await setTimeout(5, undefined, { signal: runningSignal }).catch((error) => {
          if (!runningSignal.aborted) throw error;
        });
      }
    })();
    return {
      wait: () => running,
      stop: async () => {
        controller.abort();
        await running;
      },
    };
  }
}
