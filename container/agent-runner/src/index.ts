import type { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { RunnerMailbox } from "@mybots/mailbox/bun";
import { runMailbox } from "./poll-loop.ts";
import { PiProvider } from "./providers/pi.ts";

async function main(): Promise<void> {
  if (process.versions.bun !== "1.4.0") throw new Error("Agent runner requires Bun 1.4.0.");
  const context: unknown = JSON.parse(await readFile("/run/mybots/context.json", "utf8"));
  if (!context || typeof context !== "object" || !("model" in context))
    throw new Error("Missing runner model configuration.");
  const model = context.model;
  if (
    !model ||
    typeof model !== "object" ||
    !("provider" in model) ||
    !("id" in model) ||
    !("baseUrl" in model) ||
    !("contextWindow" in model) ||
    !("maxTokens" in model) ||
    typeof model.provider !== "string" ||
    typeof model.id !== "string" ||
    typeof model.baseUrl !== "string" ||
    typeof model.contextWindow !== "number" ||
    typeof model.maxTokens !== "number"
  )
    throw new Error("Invalid runner model configuration.");
  const endpoint = new URL(model.baseUrl);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error("Runner model endpoint must be HTTPS without credentials.");
  if (!process.env.HTTPS_PROXY || !process.env.NODE_EXTRA_CA_CERTS)
    throw new Error("Runner requires a credential gateway and public trust.");
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  runtime.registerProvider(model.provider, {
    api: "openai-completions",
    baseUrl: endpoint.href,
    apiKey: "gateway-managed",
    models: [
      {
        id: model.id,
        name: model.id,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      },
    ],
  });
  const selected = runtime.getModel(model.provider, model.id);
  if (!selected) throw new Error("Runner model unavailable.");
  const controller = new AbortController();
  const stop = () => controller.abort();
  const signals: EventEmitter = process;
  signals.once("SIGTERM", stop);
  signals.once("SIGINT", stop);
  try {
    await runMailbox({
      mailbox: new RunnerMailbox("/session"),
      provider: new PiProvider({ modelRuntime: runtime, model: selected }),
      cwd: "/workspace/group",
      sessionDir: join("/session", "pi"),
      instructions:
        "instructions" in context && typeof context.instructions === "string"
          ? context.instructions
          : undefined,
      signal: controller.signal,
    });
  } finally {
    signals.removeListener("SIGTERM", stop);
    signals.removeListener("SIGINT", stop);
  }
}

main().catch(() => {
  // Configuration and SDK errors may contain transport identity; keep diagnostics bounded.
  process.stderr.write(
    "Agent runner failed: requires Bun 1.4.0, immutable model context and a usable credential gateway.\n",
  );
  process.exitCode = 1;
});
