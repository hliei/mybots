import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

export interface ModelRequest {
  tools?: { function: { name: string } }[];
  messages: Array<{
    role: string;
    content?: unknown;
    tool_calls?: { id: string }[];
    tool_call_id?: string;
    reasoning_content?: string;
  }>;
}

export type ModelReply =
  | { text: string; finishReason?: string; reasoning?: string }
  | { tool: string; arguments: Record<string, unknown>; text?: string; reasoning?: string }
  | {
      tools: { name: string; arguments: Record<string, unknown> }[];
      text?: string;
      reasoning?: string;
    }
  | { status: number; error?: string }
  | { hold: true }
  | { chunks: AsyncIterable<string> };

/** Real HTTP/SSE boundary; SDK execution and persistence are not substituted. */
export async function startDurableModel(
  respond: (request: ModelRequest) => ModelReply | Promise<ModelReply>,
  options?: { contextWindow?: number },
) {
  const requests: ModelRequest[] = [];
  const wire: { headers: IncomingHttpHeaders; path: string; body: Record<string, unknown> }[] = [];
  let observeRequest: (() => void) | undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ModelRequest;
    wire.push({
      headers: request.headers,
      path: request.url ?? "",
      body: body as unknown as Record<string, unknown>,
    });
    requests.push(body);
    observeRequest?.();
    const reply = await respond(body);
    if ("hold" in reply) return;
    if ("status" in reply) {
      response.writeHead(reply.status, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ error: { message: reply.error ?? "Controlled model failure" } }),
      );
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const tools =
      "tool" in reply
        ? [{ name: reply.tool, arguments: reply.arguments }]
        : "tools" in reply
          ? reply.tools
          : [];
    const replyText = "text" in reply ? (reply.text ?? "") : "";
    const reasoning = "reasoning" in reply ? reply.reasoning : undefined;
    const event = (type: string, value: unknown) =>
      response.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
    if (request.url?.split("?")[0]?.endsWith("/messages")) {
      event("message_start", {
        type: "message_start",
        message: {
          id: "msg_fixture",
          type: "message",
          role: "assistant",
          model: "minimax-m3",
          content: [],
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      });
      let index = 0;
      if (reasoning) {
        event("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "thinking", thinking: "", signature: "fixture-signature" },
        });
        event("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "thinking_delta", thinking: reasoning },
        });
        event("content_block_stop", { type: "content_block_stop", index: index++ });
      }
      if (replyText) {
        event("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        });
        event("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: replyText },
        });
        event("content_block_stop", { type: "content_block_stop", index: index++ });
      }
      for (const tool of tools) {
        event("content_block_start", {
          type: "content_block_start",
          index,
          content_block: {
            type: "tool_use",
            id: `call-${requests.length}-${index}`,
            name: tool.name,
            input: {},
          },
        });
        event("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.arguments) },
        });
        event("content_block_stop", { type: "content_block_stop", index: index++ });
      }
      event("message_delta", {
        type: "message_delta",
        delta: { stop_reason: tools.length ? "tool_use" : "end_turn", stop_sequence: null },
        usage: { output_tokens: 10 },
      });
      event("message_stop", { type: "message_stop" });
      response.end();
      return;
    }
    if (request.url?.includes(":streamGenerateContent")) {
      const parts = [
        ...(reasoning ? [{ text: reasoning, thought: true }] : []),
        ...(replyText ? [{ text: replyText }] : []),
        ...tools.map((tool, index) => ({
          functionCall: {
            id: `call-${requests.length}-${index}`,
            name: tool.name,
            args: tool.arguments,
          },
          thoughtSignature: "fixture-google-signature",
        })),
      ];
      response.end(
        `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 20 } })}\n\n`,
      );
      return;
    }
    if (request.url?.endsWith("/responses")) {
      const usage = {
        input_tokens: 10,
        output_tokens: 10,
        total_tokens: 20,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      };
      const base = {
        id: `resp_${requests.length}`,
        object: "response",
        created_at: 1,
        model: "gpt-6-luna",
        usage,
      };
      event("response.created", {
        type: "response.created",
        response: { ...base, status: "in_progress", output: [] },
      });
      const items: Record<string, unknown>[] = [];
      if (reasoning) {
        const item = {
          id: `rs_${requests.length}`,
          type: "reasoning",
          summary: [{ type: "summary_text", text: reasoning }],
          encrypted_content: "fixture-encrypted-reasoning",
        };
        items.push(item);
        event("response.output_item.added", {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...item, summary: [] },
        });
        event("response.reasoning_summary_text.delta", {
          type: "response.reasoning_summary_text.delta",
          item_id: item.id,
          output_index: 0,
          summary_index: 0,
          delta: reasoning,
        });
        event("response.output_item.done", {
          type: "response.output_item.done",
          output_index: 0,
          item,
        });
      }
      if (replyText) {
        const index = items.length;
        const item = {
          id: `msg_${requests.length}`,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: replyText, annotations: [] }],
        };
        items.push(item);
        event("response.output_item.added", {
          type: "response.output_item.added",
          output_index: index,
          item: { ...item, content: [] },
        });
        event("response.content_part.added", {
          type: "response.content_part.added",
          output_index: index,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        });
        event("response.output_text.delta", {
          type: "response.output_text.delta",
          output_index: index,
          content_index: 0,
          delta: replyText,
        });
        event("response.output_item.done", {
          type: "response.output_item.done",
          output_index: index,
          item,
        });
      }
      for (const tool of tools) {
        const index = items.length;
        const item = {
          id: `fc_${requests.length}_${index}`,
          type: "function_call",
          call_id: `call-${requests.length}-${index}`,
          name: tool.name,
          arguments: JSON.stringify(tool.arguments),
          status: "completed",
        };
        items.push(item);
        event("response.output_item.added", {
          type: "response.output_item.added",
          output_index: index,
          item: { ...item, arguments: "" },
        });
        event("response.function_call_arguments.delta", {
          type: "response.function_call_arguments.delta",
          output_index: index,
          delta: item.arguments,
        });
        event("response.output_item.done", {
          type: "response.output_item.done",
          output_index: index,
          item,
        });
      }
      event("response.completed", {
        type: "response.completed",
        response: { ...base, status: "completed", output: items },
      });
      response.end();
      return;
    }
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
    if ("reasoning" in reply) send({ reasoning_content: reply.reasoning });
    if ("chunks" in reply) {
      send({ role: "assistant" });
      for await (const text of reply.chunks) send({ content: text });
    } else send({ role: "assistant", content: reply.text ?? null });
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
    send(
      {},
      "tool" in reply || "tools" in reply
        ? "tool_calls"
        : "finishReason" in reply
          ? (reply.finishReason ?? "stop")
          : "stop",
    );
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    config: {
      id: "controlled",
      name: "Controlled model",
      modelId: "controlled-model",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "fixture-key",
      contextWindow: options?.contextWindow ?? 32768,
      maxTokens: 1024,
    },
    requests,
    wire,
    contextWindow: options?.contextWindow,
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
