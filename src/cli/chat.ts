import { Socket } from "node:net";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { EventRuntime } from "../core/runtime.ts";

export async function runCli(args: string[]): Promise<number> {
  let runtime: EventRuntime | undefined;
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        workspace: { type: "string", short: "w" },
        agent: { type: "string", short: "a" },
        help: { type: "boolean", short: "h" },
      },
    });
    if (values.help) {
      console.log(
        "Usage: npm run start:cli -- [--workspace PATH | -w PATH] [chat] [--agent ID | -a ID]",
      );
      console.log(
        "Workspace defaults to ../default_workspace; Agent defaults to default_agent in config.user.yaml.",
      );
      console.log(
        "Type /help for commands. Type quit, exit, or q to end; Ctrl+C and EOF also exit.",
      );
      return 0;
    }
    if (positionals.length > 1 || (positionals.length === 1 && positionals[0] !== "chat")) {
      throw new Error(`Unsupported arguments: ${positionals.join(" ")}`);
    }
    runtime = await EventRuntime.open({ workspace: values.workspace, agent: values.agent });
    const currentRuntime = runtime;
    const session = await runtime.openSession({ agent: values.agent });
    const lines = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "You: ",
    });
    const closed = Promise.withResolvers<void>();
    let inputClosed = false;
    let interrupted = false;
    let outputFailure: Error | undefined;
    let outputCancelled = false;
    lines.once("close", () => {
      inputClosed = true;
      closed.resolve();
    });
    const interrupt = () => {
      interrupted = true;
      void currentRuntime.stop({ graceMs: 0 }).catch(() => {});
      lines.close();
    };
    process.once("SIGINT", interrupt);
    lines.once("SIGINT", interrupt);
    const onOutputError = (error: Error) => {
      outputFailure = error;
      lines.close();
      void currentRuntime.stop({ graceMs: 0 }).catch(() => {});
    };
    process.stdout.on("error", onOutputError);
    console.log(`Chat with ${session.agent_name}. Type /help for commands, or quit to end.`);
    runtime.subscribe(async (event, signal) => {
      if (event.type !== "OutboundEvent" || event.session_id !== session.session_id) return;
      if (event.error !== null) console.error(`Error: ${event.error}`);
      else {
        const text = event.reply_id ? `${session.agent_id}: ${event.content}` : event.content;
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = (error?: unknown) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", abort);
            if (error !== undefined) reject(error);
            else resolve();
          };
          const abort = () => {
            outputCancelled = true;
            process.stdout.once("close", () => finish(signal.reason));
            // Standard output normally keeps its descriptor open on destroy.
            // Shutdown must close a blocked pipe instead of waiting for its reader.
            if (process.stdout instanceof Socket)
              process.stdout._destroy = Socket.prototype._destroy;
            process.stdout.destroy();
          };
          if (signal.aborted) abort();
          else {
            signal.addEventListener("abort", abort, { once: true });
            process.stdout.write(`${text}\n`, (error) => {
              if (!outputCancelled) finish(error ?? undefined);
            });
          }
        });
        if (event.reply_id)
          await currentRuntime.acknowledgeReply(session.session_id, event.reply_id);
      }
      if (!inputClosed) lines.prompt();
    });
    lines.on("line", (line) => {
      if (inputClosed) return;
      const input = line.trim();
      if (["quit", "exit", "q"].includes(input.toLowerCase())) {
        lines.close();
        return;
      }
      if (input) {
        void currentRuntime
          .submit({
            type: "InboundEvent",
            session_id: session.session_id,
            source: "platform-cli:cli-user",
            content: input,
            timestamp: Date.now() / 1000,
            retry_count: 0,
          })
          .catch((error: unknown) => {
            console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
          });
      }
      lines.prompt();
    });
    lines.prompt();
    try {
      await closed.promise;
      await runtime.stop();
    } finally {
      lines.close();
      process.removeListener("SIGINT", interrupt);
      process.stdout.removeListener("error", onOutputError);
    }
    for (const failure of runtime.subscriberFailures)
      console.error(
        `Error: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`,
      );
    if (outputFailure) console.error(`Error: ${outputFailure.message}`);
    if (!outputCancelled && !process.stdout.destroyed) console.log("Goodbye!");
    return interrupted ? 130 : outputFailure || runtime.subscriberFailures.length ? 1 : 0;
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await runtime?.stop();
  }
}
