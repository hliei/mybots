import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunContext } from "@mybots/mailbox";
import { RunnerMailbox } from "@mybots/mailbox/node";
import { runMailbox } from "../packages/agent-runner/src/poll-loop.ts";
import type { AgentProvider } from "../packages/agent-runner/src/providers/types.ts";
import type { SessionDriver } from "../packages/host/src/drivers/types.ts";

/** Actual SDK/mailbox execution; only the external container boundary is replaced. */
export function piRunDriver(provider: AgentProvider): SessionDriver {
  return {
    start: async (material, signal) => {
      const controller = new AbortController();
      const context = JSON.parse(await readFile(material.contextFile, "utf8")) as {
        runContext: RunContext;
        instructions?: string;
      };
      const running = runMailbox({
        mailbox: new RunnerMailbox(material.directory),
        provider,
        cwd: material.workspace,
        sessionDir: join(material.directory, "pi"),
        instructions: context.instructions,
        runContext: context.runContext,
        signal: AbortSignal.any([signal, controller.signal]),
        pollMs: 2,
      });
      return {
        wait: () => running,
        stop: async () => {
          controller.abort();
          await running;
        },
      };
    },
  };
}
