import { setTimeout } from "node:timers/promises";
import type { RunnerMailbox } from "@mybots/mailbox";
import type { AgentProvider } from "./providers/types.ts";

export interface PollLoopOptions {
  mailbox: RunnerMailbox;
  provider: AgentProvider;
  cwd: string;
  sessionDir: string;
  instructions?: string;
  signal: AbortSignal;
  pollMs?: number;
}

export async function runMailbox(options: PollLoopOptions): Promise<void> {
  const { mailbox, provider, signal } = options;
  while (!signal.aborted) {
    const input = mailbox.pending()[0];
    if (!input) {
      await setTimeout(options.pollMs ?? 100, undefined, { signal }).catch((error) => {
        if (!signal.aborted) throw error;
      });
      continue;
    }
    mailbox.acknowledge(input.id, "processing");
    mailbox.saveRouting({
      channel_type: input.channel_type,
      platform_id: input.platform_id,
      thread_id: input.thread_id,
    });
    mailbox.activity(null);
    const query = provider.query({
      prompt: input.content,
      cwd: options.cwd,
      sessionDir: options.sessionDir,
      continuation: mailbox.continuation(),
      systemContext: { instructions: options.instructions },
    });
    const abort = () => {
      void query.abort().catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    let terminal = false;
    try {
      for await (const event of query.events) {
        if (signal.aborted) break;
        switch (event.type) {
          case "init":
            mailbox.saveContinuation(event.continuation);
            break;
          case "activity":
            mailbox.touch();
            break;
          case "tool":
            mailbox.activity(event.name, event.timeoutMs ?? null);
            break;
          case "progress":
            mailbox.activity(event.message);
            break;
          case "result":
            terminal = true;
            // Deliberate separate commits: a crash here can lose the final reply.
            mailbox.acknowledge(input.id, event.isError ? "failed" : "completed");
            if (event.isError) mailbox.reply(input, event.error ?? "Agent query failed.", "error");
            else if (event.text !== null) mailbox.reply(input, event.text);
            break;
        }
      }
      if (!terminal && !signal.aborted) throw new Error("Agent query ended without a result");
    } finally {
      signal.removeEventListener("abort", abort);
      await query.abort();
      mailbox.activity(null);
    }
  }
}
