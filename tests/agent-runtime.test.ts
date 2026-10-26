import type { Bot, ChatView } from "@mybots/contracts";
import { expect, test } from "vitest";
import { apiFixture } from "./durable-api-fixture.ts";

const models = [
  "deepseek/deepseek-flash",
  "opencode-go/glm-5.3",
  "opencode-go/minimax-m3",
  "opencode-go/gpt-6-luna",
  "opencode-go/gemini-4-argon",
];

async function settle(
  fixture: Awaited<ReturnType<typeof apiFixture>>,
  bot: Bot,
): Promise<ChatView> {
  await expect
    .poll(async () => (await fixture.request(`bots/${bot.id}/chat`)).busy, { timeout: 5000 })
    .toBe(false);
  return fixture.request(`bots/${bot.id}/chat`);
}

test.each(models)(
  "%s exposes an empty post-tool answer without repeating committed work",
  async (model) => {
    const fixture = await apiFixture(() =>
      fixture.service.requests.length === 1
        ? {
            tool: "memory_write",
            arguments: { scope: "bot", content: "Committed once" },
            text: "I am saving the result.",
          }
        : { text: "  ", reasoning: "The tool completed" },
    );
    try {
      const bot = await fixture.request("bots", { name: "Empty", instructions: "", model });
      await fixture.request(`bots/${bot.id}/send`, { text: "Remember this", requestId: "empty" });
      const view = await settle(fixture, bot);
      expect(view.inputs).toEqual([
        expect.objectContaining({
          status: "unanswered",
          reason: "model_error",
          detail: expect.stringContaining("final answer"),
        }),
      ]);
      expect(view.messages.filter((message) => message.role === "tool")).toHaveLength(1);
      expect(fixture.service.requests).toHaveLength(2);
      expect(await fixture.request(`bots/${bot.id}/memory`)).toMatchObject({
        content: "Committed once",
      });
      await fixture.reopen();
      expect((await settle(fixture, bot)).inputs).toEqual(view.inputs);
      expect(fixture.service.requests).toHaveLength(2);
    } finally {
      await fixture.close();
    }
  },
);

test("runtime guidance and scoped resources refresh only for the next request", async () => {
  let release: () => void = () => {};
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = await apiFixture(async () => {
    if (fixture.service.requests.length === 1) {
      await barrier;
      return { tool: "memory_read", arguments: { scope: "bot" } };
    }
    return { text: "Current resources loaded" };
  });
  try {
    const bot = await fixture.request("bots", {
      name: "Runtime",
      instructions: "BOT_ROLE_SENTINEL",
      model: models[0],
    });
    const other = await fixture.request("bots", {
      name: "Other",
      instructions: "",
      model: models[0],
    });
    await fixture.request(`bots/${other.id}/memory`, { content: "OTHER_PRIVATE_MEMORY" }, "PUT");
    await fixture.request(`bots/${bot.id}/memory`, { content: "OLD_BOT_MEMORY" }, "PUT");
    await fixture.request("memory/owner", { content: "SHARED_OWNER_MEMORY" }, "PUT");
    await fixture.request(`bots/${bot.id}/send`, {
      text: "Read resources",
      requestId: "resources",
    });
    await fixture.service.waitForRequest();
    const first = JSON.stringify(fixture.service.requests[0]);
    for (const value of [
      "BOT_ROLE_SENTINEL",
      `/workspace/bots/${bot.id}`,
      "/workspace/shared",
      "Python",
      "read_file",
      "skill_read",
      "history_search",
      "untrusted",
      "final reply",
      "OLD_BOT_MEMORY",
      "SHARED_OWNER_MEMORY",
    ])
      expect(first).toContain(value);
    expect(first).not.toContain("OTHER_PRIVATE_MEMORY");
    await fixture.request(`bots/${bot.id}/memory`, { content: "NEW_BOT_MEMORY" }, "PUT");
    await fixture.request(
      "skills/new-skill",
      { description: "NEW_SKILL_CATALOG", content: "FULL_SKILL_BODY" },
      "PUT",
    );
    await fixture.request(
      `bots/${bot.id}`,
      { ...bot, instructions: "UPDATED_BOT_ROLE", model: models[1] },
      "PATCH",
    );
    expect(JSON.stringify(fixture.service.requests[0])).toBe(first);
    expect(fixture.service.wire[0]?.body.model).toBe("deepseek-flash");
    release();
    await settle(fixture, bot);
    const next = JSON.stringify(fixture.service.requests[1]);
    expect(next).toContain("NEW_BOT_MEMORY");
    expect(next).toContain("NEW_SKILL_CATALOG");
    expect(next).toContain("UPDATED_BOT_ROLE");
    expect(fixture.service.wire[1]?.body.model).toBe("glm-5.3");
    expect(next).not.toMatch(
      /BOT_ROLE_SENTINEL|OLD_BOT_MEMORY|OTHER_PRIVATE_MEMORY|FULL_SKILL_BODY/,
    );
  } finally {
    release();
    await fixture.close();
  }
});

const incompleteStreams = [
  [
    models[0],
    'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Unfinished narration"},"finish_reason":null}]}\n\ndata: [DONE]\n\n',
  ],
  [
    models[1],
    'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Unfinished narration"},"finish_reason":null}]}\n\ndata: [DONE]\n\n',
  ],
  [
    models[2],
    'event: message_start\ndata: {"type":"message_start","message":{"id":"fault","type":"message","role":"assistant","model":"minimax-m3","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
  ],
  [
    models[3],
    'event: response.created\ndata: {"type":"response.created","response":{"id":"fault","status":"in_progress","output":[]}}\n\n',
  ],
  [
    models[4],
    'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Unfinished narration"}]}}]}\n\n',
  ],
] as const;

test.each(incompleteStreams)(
  "%s bounds missing finish signals with SDK retries",
  async (model, wire) => {
    const fixture = await apiFixture(() =>
      fixture.service.requests.length === 1
        ? { tool: "memory_write", arguments: { scope: "bot", content: "Before retries" } }
        : { wire },
    );
    try {
      const bot = await fixture.request("bots", { name: "Truncated", instructions: "", model });
      await fixture.request(`bots/${bot.id}/send`, { text: "Answer", requestId: "truncated" });
      await expect
        .poll(async () => (await fixture.request(`bots/${bot.id}/chat`)).busy, { timeout: 22000 })
        .toBe(false);
      const view = await settle(fixture, bot);
      expect(view.inputs[0]).toMatchObject({ status: "unanswered", reason: "model_error" });
      expect(view.inputs[0]?.detail).toMatch(/stream|completion/i);
      expect(fixture.service.requests).toHaveLength(5);
      expect(view.messages.filter((message) => message.role === "tool")).toHaveLength(1);
      expect(view.messages.filter((message) => message.role === "user")).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  },
  30000,
);

test.each(models)("%s leaves post-tool authentication failure actionable", async (model) => {
  const fixture = await apiFixture(() =>
    fixture.service.requests.length === 1
      ? { tool: "memory_write", arguments: { scope: "bot", content: "Auth test committed" } }
      : { status: 401, error: "Rejected fixture-key and private account details" },
  );
  try {
    const bot = await fixture.request("bots", { name: "Access", instructions: "", model });
    await fixture.request(`bots/${bot.id}/send`, { text: "Save and answer", requestId: "auth" });
    const view = await settle(fixture, bot);
    expect(view.inputs[0]?.detail).toContain("authentication failed");
    expect(view.inputs[0]?.detail).not.toContain("final answer");
    expect(JSON.stringify(view)).not.toMatch(/fixture-key|private account/);
    expect(view.messages.filter((message) => message.role === "tool")).toHaveLength(1);
    expect(fixture.service.requests).toHaveLength(2);
  } finally {
    await fixture.close();
  }
});

test("output exhaustion is a failure even when partial prose was streamed", async () => {
  const fixture = await apiFixture(() => ({ text: "Half an answer", finishReason: "length" }));
  try {
    const bot = await fixture.request("bots", {
      name: "Limited",
      instructions: "",
      model: models[0],
    });
    await fixture.request(`bots/${bot.id}/send`, { text: "Answer fully", requestId: "length" });
    expect((await settle(fixture, bot)).inputs[0]?.detail).toContain("output limit");
    expect(fixture.service.requests).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});

test.each(models)("%s cancels a stalled post-tool stream promptly", async (model) => {
  const fixture = await apiFixture(() =>
    fixture.service.requests.length === 1
      ? { tool: "memory_write", arguments: { scope: "bot", content: "Before Stop" } }
      : { wire: ": keep-alive\n\n", stall: true },
  );
  try {
    const bot = await fixture.request("bots", { name: "Stop", instructions: "", model });
    await fixture.request(`bots/${bot.id}/send`, { text: "Save and answer", requestId: "stop" });
    await fixture.service.waitForRequest(2);
    await fixture.request(`bots/${bot.id}/stop`, {});
    const view = await settle(fixture, bot);
    expect(view.inputs[0]).toMatchObject({ status: "unanswered", reason: "aborted" });
    expect(view.messages.filter((message) => message.role === "tool")).toHaveLength(1);
    expect(fixture.service.requests).toHaveLength(2);
  } finally {
    await fixture.close();
  }
});

test("SDK retry can finish after a transient error without replaying the preceding tool", async () => {
  const fixture = await apiFixture(() => {
    if (fixture.service.requests.length === 1)
      return {
        tool: "memory_write",
        arguments: { scope: "bot", content: "Before transient error" },
      };
    if (fixture.service.requests.length === 2)
      return { status: 503, error: "Temporary failure fixture-key" };
    return { text: "Saved successfully" };
  });
  try {
    const bot = await fixture.request("bots", {
      name: "Retry",
      instructions: "",
      model: models[0],
    });
    await fixture.request(`bots/${bot.id}/send`, { text: "Save and answer", requestId: "retry" });
    const view = await settle(fixture, bot);
    expect(view.inputs).toEqual([]);
    expect(view.messages.at(-1)?.text).toBe("Saved successfully");
    expect(view.messages.filter((message) => message.role === "tool")).toHaveLength(1);
    expect(fixture.service.requests).toHaveLength(3);
    expect(JSON.stringify(view)).not.toContain("fixture-key");
  } finally {
    await fixture.close();
  }
});

test("subscription quota exhaustion does not enter transient SDK retry", async () => {
  const fixture = await apiFixture(() => ({
    status: 429,
    error: "GoUsageLimitError: Monthly usage limit reached. Enable available balance.",
  }));
  try {
    const bot = await fixture.request("bots", {
      name: "Quota",
      instructions: "",
      model: models[1],
    });
    await fixture.request(`bots/${bot.id}/send`, { text: "Answer", requestId: "quota" });
    const view = await settle(fixture, bot);
    expect(view.inputs[0]?.detail).toContain("quota exceeded");
    expect(fixture.service.requests).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});

test("an output limit never executes partial tool calls or leaves unmatched calls in later context", async () => {
  const wire = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "partial-write", type: "function", function: { name: "memory_write", arguments: '{"scope":"bot","content":"Must not commit"}' } }] }, finish_reason: "length" }] })}\n\ndata: [DONE]\n\n`;
  const fixture = await apiFixture(() =>
    fixture.service.requests.length === 1 ? { wire } : { text: "Later answer" },
  );
  try {
    const bot = await fixture.request("bots", {
      name: "Partial",
      instructions: "",
      model: models[0],
    });
    await fixture.request(`bots/${bot.id}/send`, { text: "Save and answer", requestId: "partial" });
    expect((await settle(fixture, bot)).inputs[0]?.detail).toContain("output limit");
    expect(await fixture.request(`bots/${bot.id}/memory`)).toEqual({ content: "" });
    await fixture.request(`bots/${bot.id}/send`, {
      text: "New request",
      requestId: "after-partial",
    });
    await settle(fixture, bot);
    expect(
      fixture.service.requests[1]?.messages.flatMap((message) => message.tool_calls ?? []),
    ).toEqual([]);
  } finally {
    await fixture.close();
  }
});
