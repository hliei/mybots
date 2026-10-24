import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool } from "@earendil-works/pi-durable";
import { context, openAgent } from "@mybots/agent";
import { Type } from "typebox";
import { expect, test } from "vitest";
import { startDurableModel } from "./durable-model-fixture.ts";

test("new work receives bounded recent background while originals survive reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "mybots-context-"));
  const service = await startDurableModel(() => ({ text: "A saved reply" }));
  let harness = await openAgent(join(root, "durable.sqlite"), [service.config]);
  try {
    const chat = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: { provider: "controlled", modelId: "controlled-model" },
          instructions: "Keep the Bot role.",
        },
      },
      context,
    );
    for (let i = 0; i < 6; i++) {
      await (await chat.submit({ type: "input", content: `question-${i}` }, context)).wait(context);
    }
    const last = JSON.stringify(service.requests.at(-1));
    expect(last).toContain("question-5");
    expect(last).toContain("question-4");
    expect(last).not.toContain("question-0");
    expect(last).toContain("Keep the Bot role.");
    await harness.close(context);
    harness = await openAgent(join(root, "durable.sqlite"), [service.config]);
    const reopened = await harness.conversation(chat.id, context);
    if (!reopened) throw new Error("Conversation missing after reopen");
    expect(JSON.stringify((await reopened?.entries({}, 100, undefined, context))?.items)).toContain(
      "question-0",
    );
  } finally {
    await harness.close(context);
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("native compaction preserves current tool pairs and originals across reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "mybots-compact-"));
  let rounds = 0;
  let journey = false;
  const service = await startDurableModel(
    (request) => {
      if (JSON.stringify(request.messages[0]).includes("summarization"))
        return { text: "Native checkpoint of the ongoing tool journey." };
      if (!journey) return { text: "Previous answer" };
      if (rounds++ < 4) return { tool: "controlled_exchange", arguments: {} };
      return { text: "Journey complete" };
    },
    { contextWindow: 5000 },
  );
  const extension = {
    name: "controlled-tools",
    tools: [
      defineTool({
        name: "controlled_exchange",
        description: "Controlled execution exchange",
        parameters: Type.Object({}),
        replay: "safe",
        execute: async () => ({
          output: [{ type: "text", text: `ORIGINAL_TOOL_EVIDENCE ${"details ".repeat(1000)}` }],
        }),
      }),
    ],
  };
  let harness = await openAgent(join(root, "durable.sqlite"), [service.config], [extension]);
  try {
    const chat = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: { provider: "controlled", modelId: "controlled-model" },
        },
      },
      context,
    );
    for (let index = 0; index < 6; index++)
      await (await chat.submit({ type: "input", content: `earlier-${index}` }, context)).wait(
        context,
      );
    journey = true;
    const result = await (
      await chat.submit({ type: "input", content: "Complete this tool journey" }, context)
    ).wait(context);
    expect(result.status).toBe("done");
    const summaries = service.requests.filter((request) =>
      JSON.stringify(request.messages[0]).includes("summarization"),
    );
    expect(summaries.length).toBeGreaterThan(0);
    const generations = service.requests.filter((request) => !summaries.includes(request));
    expect(JSON.stringify(generations.at(-1))).toContain("Native checkpoint");
    const current = generations.slice(6);
    expect(JSON.stringify(current[0])).not.toContain("earlier-0");
    expect(JSON.stringify(current[0])).toContain("earlier-5");
    expect(JSON.stringify(current[1])).toContain("Complete this tool journey");
    expect(JSON.stringify(current[1])).toContain("ORIGINAL_TOOL_EVIDENCE");
    for (const request of generations) {
      const calls = request.messages.flatMap((message) =>
        Array.isArray(message.tool_calls) ? message.tool_calls : [],
      );
      const results = request.messages.filter((message) => message.role === "tool");
      expect(results.length).toBe(calls.length);
    }
    expect(
      (await chat.entries({}, 100, undefined, context)).items.filter(
        (entry) => entry.kind === "pi.compaction",
      ).length,
    ).toBeGreaterThan(0);
    await harness.close(context);
    harness = await openAgent(join(root, "durable.sqlite"), [service.config], [extension]);
    const reopened = await harness.conversation(chat.id, context);
    if (!reopened) throw new Error("Conversation missing after reopen");
    expect(JSON.stringify((await reopened.entries({}, 100, undefined, context)).items)).toContain(
      "ORIGINAL_TOOL_EVIDENCE",
    );
    await (
      await reopened.submit({ type: "input", content: "Continue after reopen" }, context)
    ).wait(context);
    expect(JSON.stringify(service.requests.at(-1))).toContain("Continue after reopen");
  } finally {
    await harness.close(context);
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
