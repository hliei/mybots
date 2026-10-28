import { appendFileSync } from "node:fs";

// Observe only protocol metadata; never persist keys, prompts, replies or reasoning text.
const destination = process.env.MYBOTS_LIVE_OBSERVATIONS;
const originalFetch = globalThis.fetch;
let requests = 0;
const record = (value) => appendFileSync(destination, `${JSON.stringify(value)}\n`, { mode: 0o600 });
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  if (new URL(request.url).hostname !== "api.deepseek.com") return originalFetch(input, init);
  if (++requests > 16) throw new Error("Live acceptance request limit reached");
  const body = await request.clone().json();
  record({
    event: "request",
    model: body.model,
    stream: body.stream,
    thinking: body.thinking,
    reasoningEffort: body.reasoning_effort,
    previousReasoning: body.messages.some(
      (message) =>
        message.role === "assistant" &&
        message.tool_calls?.length > 0 &&
        Boolean(message.reasoning_content),
    ),
    toolResults: body.messages.filter((message) => message.role === "tool").length,
  });
  const response = await originalFetch(input, init);
  record({ event: "response", status: response.status });
  if (!response.ok || !response.body) return response;
  const seen = new Set();
  let pending = "";
  const decoder = new TextDecoder();
  return new Response(
    response.body.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          controller.enqueue(chunk);
          pending += decoder.decode(chunk, { stream: true });
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ") || line.trim() === "data: [DONE]") continue;
            const value = JSON.parse(line.slice(6));
            for (const choice of value.choices ?? []) {
              for (const field of ["reasoning_content", "content", "tool_calls"]) {
                if (!choice.delta?.[field] || seen.has(field)) continue;
                seen.add(field);
                record({ event: "delta", field });
              }
            }
          }
        },
      }),
    ),
    { status: response.status, headers: response.headers },
  );
};
