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
  operationTimeoutMs?: number;
}

export async function runMailbox(options: PollLoopOptions): Promise<void> {
  const { mailbox, provider, signal } = options;
  const incarnation = mailbox.executionIncarnation();
  let streamId = randomUUID();
  let streamText = "";
  let tool: string | null = null;
  const snapshot = () => {
    const chars = Array.from(streamText);
    mailbox.saveSnapshot({
      id: streamId,
      text: chars.slice(-2000).join(""),
      textOffset: Math.max(0, chars.length - 2000),
      tool,
      incarnation,
    });
  };
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
      history: options.runContext
        ? async (operation, input, toolSignal) => {
            const fields =
              input && typeof input === "object" && !Array.isArray(input)
                ? (input as Record<string, unknown>)
                : undefined;
            const supplied = typeof fields?.requestId === "string" ? fields.requestId : undefined;
            const id =
              operation === "create_routine" ||
              operation === "manage_routine" ||
              operation === "ask_question" ||
              operation === "publish_progress" ||
              operation === "publish_result"
                ? supplied
                : randomUUID();
            if (!id) throw new Error("A stable requestId is required.");
            const requestSignal = AbortSignal.any([
              signal,
              ...(toolSignal ? [toolSignal] : []),
              AbortSignal.timeout(options.operationTimeoutMs ?? 30000),
            ]);
            mailbox.requestHistory({ id, incarnation, operation, input });
            try {
              for (;;) {
                requestSignal.throwIfAborted();
                const response = mailbox.historyResponse(id);
                if (response) {
                  if (response.error) throw new Error(response.error);
                  return response.result;
                }
                await setTimeout(options.pollMs ?? 100, undefined, { signal: requestSignal });
              }
            } catch (error) {
              if (supplied && requestSignal.aborted && !signal.aborted)
                throw new Error(
                  `Host operation ${supplied} is not confirmed. Call read_operation with the same requestId and do not publish again.`,
                );
              throw error;
            }
          }
        : undefined,
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
    streamId = randomUUID();
    streamText = "";
    tool = null;
    snapshot();
    const answering = [input];
    const pollingController = new AbortController();
    const pollingSignal = AbortSignal.any([signal, pollingController.signal]);
    let closed = false;
    let waiting = false;
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
          case "wait":
            closeAdmission();
            waiting = true;
            mailbox.requestDurableWait(event.reason);
            answering.length = 0;
            break;
          case "evidence":
            mailbox.recordExecution({ ...event.record, incarnation });
            break;
          case "text":
            streamText += event.text;
            snapshot();
            break;
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
            tool = event.name;
            snapshot();
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
      if (waiting) {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
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
