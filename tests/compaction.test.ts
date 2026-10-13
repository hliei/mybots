import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Agent } from "../src/core/agent.ts";
import { ConversationHistory } from "../src/core/history.ts";
import { chatFixture, toolReply } from "./chat-fixture.ts";

let fixture: Awaited<ReturnType<typeof chatFixture>> | undefined;
afterEach(async () => {
  const current = fixture;
  fixture = undefined;
  await current?.close();
});

it("reports active messages and a model budget that covers the output allowance without chat", async () => {
  fixture = await chatFixture();
  const agent = await Agent.open({
    workspace: await fixture.workspace(fixture.root, "  max_tokens: 32000\n"),
  });
  const report = await agent.runCommand("/CONTEXT");
  expect(report).toContain("**Active messages:** 0");
  expect(report).toMatch(/\*\*Estimated tokens:\*\* [1-9]\d*/);
  expect(report).toContain("**Context window:** 1000000");
  expect(report).toContain("**Output reserve:** 32000");
  expect(report).toContain("**Compaction threshold:** 968000");
  expect(fixture.requests).toHaveLength(0);
});

function summaryResponse(
  content = "## Goal\nRemember Alice.\n## Next Steps\nContinue the recent work.",
) {
  return {
    status: 200,
    body: { choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] },
  };
}

it("automatically compacts before the next request exceeds the effective input budget", async () => {
  fixture = await chatFixture();
  const agent = await Agent.open({
    workspace: await fixture.workspace(fixture.root, "  context_window: 100000\n"),
  });
  await agent.chat(`Older objective ${"o".repeat(90000)}`);
  await agent.chat(`Recent objective ${"r".repeat(90000)}`);
  fixture.responses.push(summaryResponse("Remember the older objective."));
  expect(await agent.chat(`Continue ${"c".repeat(90000)}`)).toBe("Hello!");
  expect(fixture.requests[2].tools).toBeUndefined();
  expect(fixture.requests[2].messages[1].content).toContain("Older objective");
  const next = fixture.requests[3].messages;
  expect(next[1].content).toContain("Remember the older objective.");
  expect(next[2].content).toContain("Continue");
  expect(next.some((message) => message.content.startsWith("Older objective"))).toBe(false);
  const history = await ConversationHistory.open(join(fixture.root, ".history"));
  expect(await history.getMessages(agent.sessionId)).toHaveLength(6);
});

it("compacts older visible tool work while preserving the complete recent turn, reasoning, and original history", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  const path = join(workspace, "note.txt");
  await writeFile(path, `Older artifact ${"x".repeat(10000)}`);
  const agent = await Agent.open({ workspace });
  fixture.responses.push({
    status: 200,
    body: toolReply([{ name: "read", id: "old-read", args: { path } }], "Secret older reasoning"),
  });
  await agent.chat(`Remember Alice ${"o".repeat(90000)}`);
  fixture.responses.push({
    status: 200,
    body: toolReply(
      [{ name: "read", id: "recent-read", args: { path } }],
      "Original recent reasoning",
    ),
  });
  await agent.chat(`Recent objective ${"r".repeat(90000)}`);
  const retained = fixture.requests.at(-1)?.messages.slice(5);
  const log = join(workspace, ".history", "sessions", `${agent.sessionId}.jsonl`);
  const before = await readFile(log, "utf8");
  fixture.responses.push(summaryResponse());
  expect(await agent.runCommand("/COMPACT")).toContain("Compacted");
  const summarization = fixture.requests.at(-1);
  expect(summarization?.tools).toBeUndefined();
  expect(summarization?.messages).toHaveLength(2);
  const serialized = summarization?.messages[1].content;
  expect(serialized).toContain("Remember Alice");
  expect(serialized).toContain("read");
  expect(serialized).toContain(path);
  expect(serialized).toContain("Older artifact");
  expect(serialized).toContain("truncated");
  expect(serialized).not.toContain("Secret older reasoning");
  expect(serialized).not.toContain("Recent objective");
  const saved = await readFile(log, "utf8");
  expect(saved.startsWith(before)).toBe(true);
  expect(JSON.parse(saved.slice(before.length))).toMatchObject({ type: "compaction" });
  const reader = await ConversationHistory.open(join(workspace, ".history"));
  expect(await reader.getMessages(agent.sessionId)).toHaveLength(8);
  await agent.chat("Continue");
  const next = fixture.requests.at(-1)?.messages;
  expect(next?.[1]).toMatchObject({
    role: "user",
    content: expect.stringContaining("Remember Alice"),
  });
  expect(next?.slice(2, -1)).toEqual([
    ...(retained ?? []),
    { role: "assistant", content: "Hello!", reasoning_content: "Full reasoning." },
  ]);
  expect(
    next?.filter((message) => message.tool_call_id).map((message) => message.tool_call_id),
  ).toEqual(["recent-read"]);
  expect(next?.find((message) => message.tool_calls)?.reasoning_content).toBe(
    "Original recent reasoning",
  );
});

it("uses valid provider usage and clears it after compaction", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  const agent = await Agent.open({ workspace });
  await agent.chat(`Older objective ${"o".repeat(90000)}`);
  fixture.responses.push({
    status: 200,
    body: {
      ...summaryResponse("Recent answer").body,
      usage: { prompt_tokens: 400000, completion_tokens: 100000, total_tokens: 500000 },
    },
  });
  await agent.chat(`Recent objective ${"r".repeat(90000)}`);
  expect(await agent.runCommand("/context")).toContain("**Estimated tokens:** 500000");
  fixture.responses.push(summaryResponse());
  await agent.runCommand("/compact");
  const report = await agent.runCommand("/context");
  const tokens = Number(/Estimated tokens:\*\* (\d+)/.exec(report ?? "")?.[1]);
  expect(tokens).toBeGreaterThan(30000);
  expect(tokens).toBeLessThan(40000);
  expect(report).toContain("**Active messages:** 3");
});

it("uses the configured context window for a custom model and Agent overrides", async () => {
  fixture = await chatFixture();
  const agent = await Agent.open({
    workspace: await fixture.workspace(
      fixture.root,
      "  model: custom-model\n  context_window: 64000\n  max_tokens: 24000\n",
      "llm:\n  context_window: 96000\n",
    ),
  });
  const report = await agent.runCommand("/context");
  expect(report).toContain("**Context window:** 96000");
  expect(report).toContain("**Compaction threshold:** 72000");
});

it.each([
  [
    "provider failure",
    { status: 503, body: { error: { message: "Unavailable" } } },
    "Compaction failed",
  ],
  ["empty summary", summaryResponse(" \n "), "Unusable summary"],
  [
    "truncated summary",
    {
      status: 200,
      body: {
        choices: [
          { finish_reason: "length", message: { role: "assistant", content: "Partial summary" } },
        ],
      },
    },
    "Unusable summary",
  ],
  ["larger summary", summaryResponse("s".repeat(120000)), "Unusable summary"],
  [
    "tool response",
    {
      status: 200,
      body: toolReply([{ name: "read", id: "bad-summary", args: { path: "unused" } }]),
    },
    "Unusable summary",
  ],
])("preserves active context and history after %s", async (_name, response, expected) => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  const agent = await Agent.open({ workspace });
  await agent.chat(`Older ${"o".repeat(90000)}`);
  await agent.chat(`Recent ${"r".repeat(90000)}`);
  const before = await agent.runCommand("/context");
  const log = join(workspace, ".history", "sessions", `${agent.sessionId}.jsonl`);
  const saved = await readFile(log, "utf8");
  fixture.responses.push(response);
  expect(await agent.runCommand("/compact")).toContain(expected);
  expect(await agent.runCommand("/context")).toBe(before);
  expect(await readFile(log, "utf8")).toBe(saved);
  await agent.chat("Continue");
  expect(fixture.requests.at(-1)?.messages.map((message) => message.role)).toEqual([
    "system",
    "user",
    "assistant",
    "user",
    "assistant",
    "user",
  ]);
});

it("reports insufficient compactable content without a model call or message loss", async () => {
  fixture = await chatFixture();
  const agent = await Agent.open({ workspace: await fixture.workspace() });
  expect(await agent.runCommand("/compact")).toContain("Not enough compactable context");
  await agent.chat(`Only one large turn ${"x".repeat(90000)}`);
  const before = await agent.runCommand("/context");
  expect(await agent.runCommand("/compact")).toContain("Not enough compactable context");
  expect(await agent.runCommand("/context")).toBe(before);
  expect(fixture.requests).toHaveLength(1);
});

it("counts reasoning, tool arguments, and tool definitions even with no provider usage", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  const agent = await Agent.open({ workspace });
  const initial = await agent.runCommand("/context");
  expect(Number(/Estimated tokens:\*\* (\d+)/.exec(initial ?? "")?.[1])).toBeGreaterThan(300);
  fixture.responses.push({
    status: 200,
    body: toolReply(
      [{ name: "missing", id: "arguments", args: { value: "a".repeat(9000) } }],
      "r".repeat(12000),
    ),
  });
  await agent.chat("Inspect");
  const report = await agent.runCommand("/context");
  expect(Number(/Estimated tokens:\*\* (\d+)/.exec(report ?? "")?.[1])).toBeGreaterThan(7000);
});

it.each([
  { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  { prompt_tokens: -1, completion_tokens: 501, total_tokens: 500 },
  { prompt_tokens: 100, completion_tokens: 100, total_tokens: 900000 },
  { prompt_tokens: "100", completion_tokens: 100, total_tokens: 200 },
])("ignores invalid provider usage %j", async (usage) => {
  fixture = await chatFixture();
  const agent = await Agent.open({ workspace: await fixture.workspace() });
  fixture.responses.push({ status: 200, body: { ...summaryResponse("Answer").body, usage } });
  await agent.chat("Question");
  const report = await agent.runCommand("/context");
  const tokens = Number(/Estimated tokens:\*\* (\d+)/.exec(report ?? "")?.[1]);
  expect(tokens).toBeGreaterThan(300);
  expect(tokens).toBeLessThan(1000);
});

it("cancels an in-flight summary and prevents overlapping mutation without changing context or history", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  const agent = await Agent.open({ workspace });
  await agent.chat(`Older ${"o".repeat(90000)}`);
  await agent.chat(`Recent ${"r".repeat(90000)}`);
  const before = await agent.runCommand("/context");
  const log = join(workspace, ".history", "sessions", `${agent.sessionId}.jsonl`);
  const saved = await readFile(log, "utf8");
  let release = (_value: unknown) => {};
  fixture.responses.push({
    status: 200,
    body: new Promise((resolve) => {
      release = resolve;
    }),
  });
  const controller = new AbortController();
  const requested = once(fixture.server, "request");
  const running = agent.runCommand("/compact", controller.signal);
  try {
    await requested;
    await expect(agent.chat("Overlapping input")).rejects.toThrow("already in progress");
    await expect(agent.runCommand("/compact")).rejects.toThrow("already in progress");
    controller.abort();
    expect(await running).toContain("Compaction cancelled");
    expect(await agent.runCommand("/context")).toBe(before);
    expect(await readFile(log, "utf8")).toBe(saved);
  } finally {
    controller.abort();
    release(summaryResponse().body);
    await running;
  }
  await agent.chat("Continue");
  expect(fixture.requests.at(-1)?.messages).toHaveLength(6);
});

it("honors cancellation before summarization without making a request", async () => {
  fixture = await chatFixture();
  const agent = await Agent.open({ workspace: await fixture.workspace() });
  await agent.chat(`Older ${"o".repeat(90000)}`);
  await agent.chat(`Recent ${"r".repeat(90000)}`);
  const before = await agent.runCommand("/context");
  expect(await agent.runCommand("/compact", AbortSignal.abort())).toContain("Compaction cancelled");
  expect(await agent.runCommand("/context")).toBe(before);
  expect(fixture.requests).toHaveLength(2);
});

it("adds tool-result estimates to the latest usage after a later request fails", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  const path = join(workspace, "large.txt");
  await writeFile(path, "x".repeat(12000));
  const agent = await Agent.open({ workspace });
  fixture.responses.push(
    {
      status: 200,
      body: {
        ...toolReply([{ name: "read", id: "read", args: { path } }]),
        usage: { prompt_tokens: 19000, completion_tokens: 1000, total_tokens: 20000 },
      },
    },
    { status: 503, body: { error: { message: "Unavailable" } } },
  );
  await expect(agent.chat("Read the file")).rejects.toThrow("HTTP 503");
  const report = await agent.runCommand("/context");
  expect(report).toContain("**Active messages:** 3");
  const tokens = Number(/Estimated tokens:\*\* (\d+)/.exec(report ?? "")?.[1]);
  expect(tokens).toBeGreaterThan(24000);
  expect(tokens).toBeLessThan(25000);
});

it("selects multiple recent turns by their token budget instead of a fixed message count", async () => {
  fixture = await chatFixture();
  const agent = await Agent.open({ workspace: await fixture.workspace() });
  await agent.chat(`Older ${"o".repeat(90000)}`);
  await agent.chat(`Recent one ${"a".repeat(30000)}`);
  await agent.chat(`Recent two ${"b".repeat(30000)}`);
  await agent.chat(`Recent three ${"c".repeat(30000)}`);
  fixture.responses.push(summaryResponse());
  expect(await agent.runCommand("/compact")).toContain(
    "Compacted 4 older messages; 5 active messages remain",
  );
  expect(fixture.requests.at(-1)?.messages[1].content).toContain("Recent one");
  expect(fixture.requests.at(-1)?.messages[1].content).not.toContain("Recent two");
  await agent.chat("Continue");
  expect(
    fixture.requests
      .at(-1)
      ?.messages.slice(2)
      .map((message) => message.role),
  ).toEqual(["user", "assistant", "user", "assistant", "user"]);
  expect(fixture.requests.at(-1)?.messages[2].content).toContain("Recent two");
});

it("preserves every call and result when a large tool group extends the retained turn", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  const agent = await Agent.open({ workspace });
  await agent.chat(`Older ${"o".repeat(90000)}`);
  const path = join(workspace, "large.txt");
  await writeFile(path, "x".repeat(90000));
  fixture.responses.push({
    status: 200,
    body: toolReply(
      [
        { name: "read", id: "first", args: { path } },
        { name: "read", id: "second", args: { path } },
      ],
      "Keep all original reasoning",
    ),
  });
  await agent.chat("Read both files");
  fixture.responses.push(summaryResponse());
  expect(await agent.runCommand("/compact")).toContain(
    "Compacted 2 older messages; 6 active messages remain",
  );
  await agent.chat("Continue");
  const messages = fixture.requests.at(-1)?.messages;
  expect(messages?.[2]).toEqual({ role: "user", content: "Read both files" });
  expect(messages?.[3].tool_calls?.map((call) => call.id)).toEqual(["first", "second"]);
  expect(messages?.[3].reasoning_content).toBe("Keep all original reasoning");
  expect(messages?.slice(4, 6).map((message) => message.tool_call_id)).toEqual(["first", "second"]);
});

it("leaves context unchanged when the separate summary request cannot fit the model budget", async () => {
  fixture = await chatFixture();
  const agent = await Agent.open({
    workspace: await fixture.workspace(fixture.root, "  context_window: 24000\n"),
  });
  for (const content of ["o".repeat(90000), "r".repeat(90000)]) {
    fixture.responses.push({
      status: 200,
      body: {
        ...summaryResponse(content).body,
        usage: { prompt_tokens: 50, completion_tokens: 50, total_tokens: 100 },
      },
    });
    await agent.chat("Short input");
  }
  const before = await agent.runCommand("/context");
  expect(await agent.runCommand("/compact")).toContain("Not enough model budget");
  expect(await agent.runCommand("/context")).toBe(before);
  expect(fixture.requests).toHaveLength(2);
});

it("continues a long tool turn with incremental prefix summaries and complete retained exchanges", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace(fixture.root, "  context_window: 100000\n");
  const path = join(workspace, "large.txt");
  await writeFile(path, "Artifact ".repeat(11250));
  const agent = await Agent.open({ workspace });
  const round = (id: string) => ({
    status: 200,
    body: toolReply(
      [
        { name: "read", id: `${id}-a`, args: { path } },
        { name: "read", id: `${id}-b`, args: { path } },
      ],
      `Complete reasoning for ${id} ${"r".repeat(9000)}`,
    ),
  });
  fixture.responses.push(
    round("first"),
    round("second"),
    summaryResponse("Goal: inspect both artifacts. Done: first round."),
    round("third"),
    summaryResponse("Goal: inspect both artifacts. Done: first and second rounds."),
  );
  expect(await agent.chat("Inspect both artifacts and report differences")).toBe("Hello!");
  const summaries = fixture.requests.filter((request) => !request.tools);
  expect(summaries).toHaveLength(2);
  expect(summaries[0].messages[1].content).toContain(
    "Inspect both artifacts and report differences",
  );
  expect(summaries[0].messages[1].content).toContain("first-a");
  expect(summaries[0].messages[1].content).not.toContain("second-a");
  expect(summaries[1].messages[1].content).toContain(
    "Goal: inspect both artifacts. Done: first round.",
  );
  expect(summaries[1].messages[1].content).toContain("second-a");
  expect(summaries[1].messages[1].content).not.toContain("first-a");
  const last = fixture.requests.at(-1)?.messages;
  expect(last?.[1].role).toBe("user");
  expect(last?.[1].content).toContain("Goal: inspect both artifacts");
  expect(last?.[2]).toMatchObject({
    role: "assistant",
    reasoning_content: `Complete reasoning for third ${"r".repeat(9000)}`,
  });
  expect(last?.[2].tool_calls?.map((call) => call.id)).toEqual(["third-a", "third-b"]);
  expect(last?.slice(3).map((message) => message.tool_call_id)).toEqual(["third-a", "third-b"]);
  const history = await ConversationHistory.open(join(workspace, ".history"));
  expect(await history.getMessages(agent.sessionId)).toHaveLength(11);
});

it.each([
  [75981, false],
  [75982, true],
])(
  "checks appended input against the output-adjusted boundary after usage %i",
  async (tokens, compacted) => {
    fixture = await chatFixture();
    const agent = await Agent.open({
      workspace: await fixture.workspace(
        fixture.root,
        "  context_window: 100000\n  max_tokens: 24000\n",
      ),
    });
    await agent.chat(`Older ${"o".repeat(90000)}`);
    fixture.responses.push({
      status: 200,
      body: {
        ...summaryResponse("Recent answer").body,
        usage: { prompt_tokens: tokens - 1, completion_tokens: 1, total_tokens: tokens },
      },
    });
    await agent.chat(`Recent ${"r".repeat(90000)}`);
    if (compacted) fixture.responses.push(summaryResponse("Older work completed."));
    // "Next" is a 32-byte serialized user message: 11 estimate tokens + 8 framing.
    expect(await agent.chat("Next")).toBe("Hello!");
    expect(fixture.requests.filter((request) => !request.tools)).toHaveLength(compacted ? 1 : 0);
    const report = await agent.runCommand("/context");
    if (compacted) {
      expect(Number(/Estimated tokens:\*\* (\d+)/.exec(report ?? "")?.[1])).toBeLessThan(40000);
    } else {
      expect(report).toContain("**Estimated tokens:** 76034");
    }
  },
);

it("adds tool-result estimates to provider usage before continuing the current turn", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace(fixture.root, "  context_window: 100000\n");
  const path = join(workspace, "large.txt");
  await writeFile(path, "x".repeat(90000));
  const agent = await Agent.open({ workspace });
  fixture.responses.push(
    {
      status: 200,
      body: {
        ...toolReply([{ name: "read", id: "usage-read", args: { path } }], "Retain real reasoning"),
        usage: { prompt_tokens: 59000, completion_tokens: 1000, total_tokens: 60000 },
      },
    },
    summaryResponse("Goal: read the large artifact and report its content."),
  );
  expect(await agent.chat(`Read and report ${"o".repeat(90000)}`)).toBe("Hello!");
  expect(fixture.requests[1].tools).toBeUndefined();
  expect(fixture.requests[2].messages[2]).toMatchObject({
    role: "assistant",
    reasoning_content: "Retain real reasoning",
  });
  expect(fixture.requests[2].messages[3].tool_call_id).toBe("usage-read");
});

it("rejects an oversized retained exchange without committing a partial automatic summary", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace(fixture.root, "  context_window: 100000\n");
  const path = join(workspace, "huge.txt");
  await writeFile(path, "x".repeat(270000));
  const agent = await Agent.open({ workspace });
  fixture.responses.push(
    { status: 200, body: toolReply([{ name: "read", id: "huge", args: { path } }]) },
    summaryResponse("Goal: read the file."),
  );
  await expect(agent.chat(`Read the file ${"o".repeat(9000)}`)).rejects.toThrow(
    "cannot fit the input budget",
  );
  expect(fixture.requests).toHaveLength(2);
  expect(await agent.runCommand("/context")).toContain("**Active messages:** 3");
  const history = await ConversationHistory.open(join(workspace, ".history"));
  const raw = await history.getMessages(agent.sessionId);
  expect(raw).toHaveLength(3);
  expect(raw[0].content).toContain("Read the file");
  expect(raw[2].tool_call_id).toBe("huge");
});

it("cancels automatic summarization while preserving committed usage, context, and raw history", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace(fixture.root, "  context_window: 100000\n");
  const agent = await Agent.open({ workspace });
  await agent.chat(`Older ${"o".repeat(90000)}`);
  await agent.chat(`Recent ${"r".repeat(90000)}`);
  const before = await agent.runCommand("/context");
  let release = (_value: unknown) => {};
  fixture.responses.push({
    status: 200,
    body: new Promise((resolve) => {
      release = resolve;
    }),
  });
  const controller = new AbortController();
  const requested = once(fixture.server, "request");
  const running = agent.chat(`Next ${"n".repeat(90000)}`, controller.signal);
  const cancelled = expect(running).rejects.toThrow("Compaction cancelled");
  try {
    await requested;
    await expect(agent.runCommand("/compact")).rejects.toThrow("already in progress");
    controller.abort();
    await cancelled;
    expect(await agent.runCommand("/context")).toBe(before);
    const history = await ConversationHistory.open(join(workspace, ".history"));
    expect(await history.getMessages(agent.sessionId)).toHaveLength(5);
    expect(fixture.requests).toHaveLength(3);
  } finally {
    controller.abort();
    release(summaryResponse().body);
    await cancelled;
  }
  expect(await agent.chat("Recover below the budget")).toBe("Hello!");
  expect(fixture.requests.at(-1)?.messages[1].content).toContain("Older");
});

it("updates summaries across alternating manual and automatic compaction without rereading raw history", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace(fixture.root, "  context_window: 100000\n");
  const agent = await Agent.open({ workspace });
  await agent.chat(`First raw objective ${"a".repeat(90000)}`);
  await agent.chat(`Second objective ${"b".repeat(90000)}`);
  fixture.responses.push(summaryResponse("Checkpoint one: first objective."));
  expect(await agent.runCommand("/compact")).toContain("Compacted");
  await agent.chat(`Third objective ${"c".repeat(90000)}`);
  fixture.responses.push(summaryResponse("Checkpoint two: first through third objectives."));
  await agent.chat(`Fourth objective ${"d".repeat(90000)}`);
  const automatic = fixture.requests.at(-2)?.messages[1].content;
  expect(automatic).toContain("Checkpoint one");
  expect(automatic).toContain("Second objective");
  expect(automatic).toContain("Third objective");
  expect(automatic).not.toContain("First raw objective");
  await agent.chat(`Fifth objective ${"e".repeat(90000)}`);
  fixture.responses.push(summaryResponse("Checkpoint three: first through fourth objectives."));
  expect(await agent.runCommand("/compact")).toContain("Compacted");
  const manual = fixture.requests.at(-1)?.messages[1].content;
  expect(manual).toContain("Checkpoint two");
  expect(manual).toContain("Fourth objective");
  expect(manual).not.toContain("Second objective");
  expect(manual).not.toContain("Third objective");
  await agent.chat("Next");
  expect(fixture.requests.at(-1)?.messages[1].content).toContain("Checkpoint three");
  const history = await ConversationHistory.open(join(workspace, ".history"));
  expect(await history.getMessages(agent.sessionId)).toHaveLength(12);
});

it.each([
  ["provider failure", { status: 503, body: { error: { message: "Unavailable" } } }],
  ["empty summary", summaryResponse(" ")],
  ["nonreducing summary", summaryResponse("s".repeat(120000))],
])("stops automatic compaction atomically after %s", async (_name, response) => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace(fixture.root, "  context_window: 100000\n");
  const agent = await Agent.open({ workspace });
  await agent.chat(`Older ${"o".repeat(90000)}`);
  fixture.responses.push({
    status: 200,
    body: {
      ...summaryResponse("Recent answer").body,
      usage: { prompt_tokens: 89000, completion_tokens: 1000, total_tokens: 90000 },
    },
  });
  await agent.chat(`Recent ${"r".repeat(90000)}`);
  const before = await agent.runCommand("/context");
  fixture.responses.push(response);
  await expect(agent.chat("Next")).rejects.toThrow("Automatic compaction");
  expect(await agent.runCommand("/context")).toBe(before);
  expect(fixture.requests).toHaveLength(3);
  const history = await ConversationHistory.open(join(workspace, ".history"));
  const raw = await history.getMessages(agent.sessionId);
  expect(raw).toHaveLength(5);
  expect(raw[0].content).toContain("Older");
  expect(raw.at(-1)?.content).toBe("Next");
  fixture.responses.push(summaryResponse("Recovered checkpoint."));
  expect(await agent.chat("Recover")).toBe("Hello!");
  expect(fixture.requests.at(-1)?.messages[1].content).toContain("Recovered checkpoint.");
});

it("keeps an unanswered input out of committed context when chat fails after successful compaction", async () => {
  fixture = await chatFixture();
  const agent = await Agent.open({
    workspace: await fixture.workspace(fixture.root, "  context_window: 100000\n"),
  });
  await agent.chat(`Older ${"o".repeat(90000)}`);
  await agent.chat(`Recent ${"r".repeat(90000)}`);
  fixture.responses.push(summaryResponse("Checkpoint."), {
    status: 503,
    body: { error: { message: "Unavailable" } },
  });
  await expect(agent.chat(`Unanswered ${"n".repeat(90000)}`)).rejects.toThrow("HTTP 503");
  expect(await agent.runCommand("/context")).toContain("**Active messages:** 1");
  await agent.chat("Recover");
  expect(fixture.requests.at(-1)?.messages.map((message) => message.role)).toEqual([
    "system",
    "user",
    "user",
  ]);
  expect(
    fixture.requests.at(-1)?.messages.some((message) => message.content.startsWith("Unanswered")),
  ).toBe(false);
});
