import { mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentProvider, AgentQuery, ProviderEvent, QueryInput } from "./types.ts";

export interface PiProviderOptions {
  modelRuntime: ModelRuntime;
  model: Model<Api>;
}

export class PiProvider implements AgentProvider {
  private readonly options: PiProviderOptions;

  constructor(options: PiProviderOptions) {
    this.options = options;
  }

  query(input: QueryInput): AgentQuery {
    const events: ProviderEvent[] = [];
    let wake: (() => void) | undefined;
    let finished = false;
    let aborted = false;
    let session: AgentSession | undefined;
    const emit = (event: ProviderEvent) => {
      events.push(event);
      wake?.();
    };
    const run = async () => {
      let unsubscribe: (() => void) | undefined;
      try {
        const sessionDir = resolve(input.sessionDir);
        const historyDir = join(sessionDir, "sessions");
        const agentDir = join(sessionDir, "config");
        await mkdir(historyDir, { recursive: true });
        let manager: SessionManager;
        if (input.continuation !== undefined) {
          const file = input.continuation.startsWith("pi:")
            ? resolve(input.continuation.slice(3))
            : "";
          if (dirname(file) !== historyDir) throw new Error("Invalid Pi continuation");
          // SessionManager.open can create a missing file; continuation must never do that.
          const saved = await stat(file);
          if (!saved.isFile() || saved.size === 0) throw new Error("Empty Pi continuation");
          manager = SessionManager.open(file, historyDir, input.cwd);
        } else {
          manager = SessionManager.create(input.cwd, historyDir);
        }
        const settingsManager = SettingsManager.inMemory();
        const resourceLoader = new DefaultResourceLoader({
          cwd: input.cwd,
          agentDir,
          settingsManager,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          appendSystemPrompt: input.systemContext?.instructions
            ? [input.systemContext.instructions]
            : [],
        });
        await resourceLoader.reload();
        const created = await createAgentSession({
          cwd: input.cwd,
          agentDir,
          modelRuntime: this.options.modelRuntime,
          model: this.options.model,
          thinkingLevel: "off",
          tools: ["read", "write", "edit", "bash"],
          sessionManager: manager,
          settingsManager,
          resourceLoader,
        });
        session = created.session;
        emit({ type: "init", continuation: `pi:${session.sessionFile}` });
        if (aborted) {
          emit({ type: "result", text: null, isError: true, error: "Agent query aborted." });
          return;
        }
        unsubscribe = session.subscribe((event) => {
          emit({ type: "activity" });
          if (
            event.type === "message_update" &&
            event.assistantMessageEvent.type === "text_delta"
          ) {
            emit({ type: "text", text: event.assistantMessageEvent.delta });
          } else if (event.type === "tool_execution_start") {
            emit({ type: "progress", message: event.toolName });
            const args = event.args as { timeout?: unknown };
            emit({
              type: "tool",
              name: event.toolName,
              timeoutMs: typeof args?.timeout === "number" ? args.timeout * 1000 : undefined,
            });
          } else if (event.type === "tool_execution_end") {
            emit({ type: "tool", name: null });
          }
        });
        // prompt resolves after SDK retries and persistence; individual message/agent ends
        // can precede tool continuation, so they must not become exchange results.
        await session.prompt(input.prompt, { expandPromptTemplates: false });
        const last = session.messages.findLast((message) => message.role === "assistant");
        if (aborted || (last?.role === "assistant" && last.stopReason === "aborted")) {
          emit({ type: "result", text: null, isError: true, error: "Agent query aborted." });
        } else if (last?.role === "assistant" && last.stopReason === "error") {
          emit({ type: "result", text: null, isError: true, error: "Agent model request failed." });
        } else {
          emit({ type: "result", text: session.getLastAssistantText() ?? null });
        }
      } catch {
        emit({
          type: "result",
          text: null,
          isError: true,
          error: aborted ? "Agent query aborted." : "Agent query failed.",
        });
      } finally {
        unsubscribe?.();
        session?.dispose();
        finished = true;
        wake?.();
      }
    };
    const completion = run();
    const abort = async () => {
      if (!finished) {
        aborted = true;
        await session?.abort();
      }
      await completion;
    };
    return {
      abort,
      events: (async function* () {
        try {
          while (!finished || events.length > 0) {
            const event = events.shift();
            if (event) yield event;
            else
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
          }
        } finally {
          await abort();
        }
      })(),
    };
  }
}
