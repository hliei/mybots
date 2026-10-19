import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import type { AgentResources, RunContext, RunnerMailbox, WebConfiguration } from "@mybots/mailbox";
import type { AgentProvider, AgentQuery, ProviderEvent } from "./providers/types.ts";

async function* queryEvents(query: AgentQuery): AsyncGenerator<ProviderEvent> {
  try {
    yield* query.events;
  } catch {
    yield { type: "result", text: null, isError: true, error: "Agent query failed." };
  }
}

export interface PollLoopOptions {
  mailbox: RunnerMailbox;
  provider: AgentProvider;
  cwd: string;
  sessionDir: string;
  instructions?: string;
  resources?: AgentResources;
  web?: WebConfiguration;
  runContext?: RunContext;
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
      inputId: input.id,
      runContext: options.runContext,
      cwd: options.cwd,
      sessionDir: options.sessionDir,
      continuation: mailbox.continuation(),
      control: input.kind === "reset" ? "reset" : undefined,
      systemContext: {
        instructions: options.instructions,
        resources: options.resources,
        web: options.web,
      },
    });
    const answering = [input];
    const pollingController = new AbortController();
    const pollingSignal = AbortSignal.any([signal, pollingController.signal]);
    let closed = false;
    let pollFailure: unknown;
    const closeAdmission = () => {
      closed = true;
      query.end();
      pollingController.abort();
    };
    const polling = (async () => {
      while (!pollingSignal.aborted && !closed) {
        for (const followUp of mailbox.pending()) {
          if (answering.some((row) => row.id === followUp.id)) continue;
          // Controls form a FIFO boundary: neither the control nor later messages
          // may enter the active SDK queue. The outer loop runs them after cleanup.
          if (
            input.kind === "reset" ||
            followUp.kind === "reset" ||
            closed ||
            pollingSignal.aborted ||
            !query.push(followUp.content, followUp.id)
          )
            break;
          answering.push(followUp);
          // Deliberately early: SDK queue entries need not survive a hard crash.
          if (!options.runContext) mailbox.acknowledge(followUp.id, "completed");
        }
        await setTimeout(options.pollMs ?? 100, undefined, { signal: pollingSignal }).catch(
          (error) => {
            if (!pollingSignal.aborted) throw error;
          },
        );
      }
    })().catch((error: unknown) => {
      pollFailure = error;
      closeAdmission();
      void query.abort().catch(() => {});
    });
    const abort = () => {
      closeAdmission();
      void query.abort().catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      for await (const event of queryEvents(query)) {
        if (signal.aborted) break;
        switch (event.type) {
          case "recorded":
            mailbox.recordInput(event.inputId);
            break;
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
          case "result": {
            if (options.runContext) {
              const completed = answering.filter((row) => event.inputIds?.includes(row.id));
              if (event.isError && !completed.length) completed.push(...answering);
              mailbox.recordResultGroup(
                randomUUID(),
                completed.map((row) => row.id),
              );
              for (const current of completed) {
                mailbox.acknowledge(current.id, event.isError ? "failed" : "completed");
                mailbox.reply(
                  current,
                  event.isError ? (event.error ?? "Agent query failed.") : (event.text ?? ""),
                  event.isError ? "error" : "message",
                );
                answering.splice(answering.indexOf(current), 1);
              }
              // Unconsumed steering stays pending for a later query of this Run.
              closeAdmission();
              answering.length = 0;
              break;
            }
            const current = answering.shift();
            if (!current) throw new Error("Agent query returned an uncorrelated result");
            // Deliberate separate commits: a crash here can lose the final reply.
            if (current.id === input.id)
              mailbox.acknowledge(current.id, event.isError ? "failed" : "completed");
            if (event.isError) {
              mailbox.reply(current, event.error ?? "Agent query failed.", "error");
            } else if (event.text !== null) mailbox.reply(current, event.text);
            if (answering.length === 0) closeAdmission();
            break;
          }
        }
      }
      if (pollFailure) throw pollFailure;
      if (answering.length > 0 && !signal.aborted) {
        closeAdmission();
        for (const unfinished of answering) {
          if (unfinished.id === input.id) mailbox.acknowledge(unfinished.id, "failed");
          mailbox.reply(unfinished, "Agent query ended before completing the exchange.", "error");
        }
      }
    } finally {
      closeAdmission();
      signal.removeEventListener("abort", abort);
      await polling;
      await query.abort();
      mailbox.activity(null);
    }
  }
}
