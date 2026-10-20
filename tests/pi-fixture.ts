import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface ModelRequest {
  tools?: { function: { name: string } }[];
  messages: Array<{ role: string; content?: unknown; tool_calls?: unknown }>;
}

export type ModelReply =
  | { text: string; finishReason?: string }
  | { tool: string; arguments: Record<string, unknown>; text?: string }
  | { tools: { name: string; arguments: Record<string, unknown> }[]; text?: string }
  | { status: number }
  | { hold: true };

/** Real HTTP/SSE boundary; SDK execution and persistence are not substituted. */
export async function startPiService(
  respond: (request: ModelRequest) => ModelReply | Promise<ModelReply>,
  options?: { contextWindow?: number },
) {
  const requests: ModelRequest[] = [];
  let observeRequest: (() => void) | undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ModelRequest;
    requests.push(body);
    observeRequest?.();
    const reply = await respond(body);
    if ("hold" in reply) return;
    if ("status" in reply) {
      response.writeHead(reply.status, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Controlled model failure" } }));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (delta: unknown, finishReason: string | null = null) => {
      response.write(
        `data: ${JSON.stringify({
          id: "controlled-reply",
          object: "chat.completion.chunk",
          created: 1,
          model: "controlled-model",
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`,
      );
    };
    send({ role: "assistant", content: reply.text ?? null });
    if ("tool" in reply || "tools" in reply) {
      send({
        tool_calls: ("tools" in reply
          ? reply.tools
          : [{ name: reply.tool, arguments: reply.arguments }]
        ).map((tool, index) => ({
          index,
          id: `call-${requests.length}-${index}`,
          type: "function",
          function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
        })),
      });
    }
    send({}, "tool" in reply || "tools" in reply ? "tool_calls" : (reply.finishReason ?? "stop"));
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  runtime.registerProvider("controlled", {
    api: "openai-completions",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "non-secret-fixture-placeholder",
    models: [
      {
        id: "controlled-model",
        name: "Controlled model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: options?.contextWindow ?? 32768,
        maxTokens: 4096,
      },
    ],
  });
  const model = runtime.getModel("controlled", "controlled-model");
  if (!model) throw new Error("Controlled model unavailable");
  return {
    runtime,
    model,
    requests,
    waitForRequest: async (count = 1) => {
      if (requests.length >= count) return;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          observeRequest = () => {
            if (requests.length >= count) resolve();
          };
          timeout = setTimeout(
            () => reject(new Error("No controlled model request arrived")),
            3000,
          );
        });
      } finally {
        clearTimeout(timeout);
        observeRequest = undefined;
      }
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
