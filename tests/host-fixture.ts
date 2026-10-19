import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { InboundMessage } from "@mybots/mailbox";
import { RunnerMailbox } from "@mybots/mailbox/node";
import type {
  ObservingSessionDriver,
  SessionDriver,
  SessionHandle,
  SessionMaterial,
  SessionObservation,
} from "../packages/host/src/drivers/types.ts";

/** External execution boundary: this fixture uses only the runner's mailbox API. */
export class MailboxDriver implements SessionDriver, ObservingSessionDriver {
  readonly launches: { material: SessionMaterial; continuation?: string; ref: string }[] = [];
  /** Containers the runtime reports as running before this host started. */
  observations: SessionObservation[] = [];
  readonly adopted: SessionObservation[] = [];
  readonly stopped: string[] = [];
  fail = false;
  respond?: (
    input: InboundMessage,
    material: SessionMaterial,
    signal: AbortSignal,
  ) => Promise<string | { error: string }>;

  async start(material: SessionMaterial, signal: AbortSignal): Promise<SessionHandle> {
    if (this.fail) throw new Error("Controlled driver unavailable");
    const mailbox = new RunnerMailbox(material.directory);
    const ref = `container:${material.key.agentGroupId}:${material.key.sessionId}:${
      this.launches.length + 1
    }`;
    this.launches.push({ material, continuation: mailbox.continuation(), ref });
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
          const reply = this.respond
            ? await this.respond(input, material, runningSignal)
            : `Reply: ${input.content}`;
          if (runningSignal.aborted) break;
          mailbox.acknowledge(input.id, typeof reply === "string" ? "completed" : "failed");
          mailbox.reply(
            input,
            typeof reply === "string" ? reply : reply.error,
            typeof reply === "string" ? "message" : "error",
          );
        }
        await setTimeout(5, undefined, { signal: runningSignal }).catch((error) => {
          if (!runningSignal.aborted) throw error;
        });
      }
    })();
    return {
      ref,
      wait: () => running,
      stop: async () => {
        this.stopped.push(ref);
        controller.abort();
        await running;
      },
    };
  }

  async list(): Promise<SessionObservation[]> {
    return this.observations;
  }

  /** Attach to an observation without creating another container. */
  async adopt(
    observation: SessionObservation,
    _material: SessionMaterial,
    signal: AbortSignal,
  ): Promise<SessionHandle> {
    if (this.fail) throw new Error("Controlled driver unavailable");
    this.adopted.push(observation);
    const done = Promise.withResolvers<void>();
    const onAbort = () => done.resolve();
    signal.addEventListener("abort", onAbort, { once: true });
    return {
      ref: observation.ref,
      wait: () => done.promise,
      stop: async () => {
        this.stopped.push(observation.ref);
        done.resolve();
        signal.removeEventListener("abort", onAbort);
      },
    };
  }
}
