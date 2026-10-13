import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationHistory } from "../src/core/history.ts";
import { chatFixture, toolReply } from "./chat-fixture.ts";

let fixture: Awaited<ReturnType<typeof chatFixture>>;
afterEach(async () => {
  await fixture?.close();
});

it("commits the original final assistant and pending reply together before returning", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  fixture.responses.push({
    status: 200,
    body: {
      choices: [
        {
          message: {
            role: "assistant",
            content: "Saved answer",
            reasoning_content: "Saved reasoning",
          },
        },
      ],
    },
  });
  const agent = await fixture.openAgent({ workspace });
  expect(await agent.chat("Question")).toBe("Saved answer");
  const lines = (
    await readFile(join(workspace, ".history", "sessions", `${agent.sessionId}.jsonl`), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(lines).toHaveLength(3);
  expect(lines[2]).toMatchObject({
    role: "assistant",
    content: "Saved answer",
    reasoning_content: "Saved reasoning",
    completion: {
      turnId: lines[1].id,
      replyId: expect.any(String),
      payload: "Saved answer",
      destination: "platform-cli:cli-user",
    },
  });
  const history = await ConversationHistory.open(join(workspace, ".history"));
  expect(await history.getMessages(agent.sessionId)).toHaveLength(2);
});

it("rebuilds missing pending files from a committed completion in a fresh Agent", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  const agent = await fixture.openAgent({ workspace });
  await agent.chat("Question");
  const log = (
    await readFile(join(workspace, ".history", "sessions", `${agent.sessionId}.jsonl`), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const saved = log.at(-1).completion;
  await rm(join(workspace, ".event"), { recursive: true, force: true });
  await fixture.openAgent({ workspace, sessionId: agent.sessionId });
  expect(
    JSON.parse(
      await readFile(
        join(workspace, ".event", "pending", agent.sessionId, `${saved.replyId}.json`),
        "utf8",
      ),
    ),
  ).toEqual({ ...saved, sessionId: agent.sessionId, confirmedChunks: 0 });
  expect(fixture.requests).toHaveLength(1);
});

it("recovers confirmed chunks, resumes a controlled sink, and suppresses stale acknowledged files", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  const agent = await fixture.openAgent({ workspace });
  await agent.chat("Question", undefined, "platform-telegram:123:-456");
  const [reply] = await agent.getPendingReplies();
  const sink = ["chunk one"];
  await agent.confirmChunks(reply.replyId, 1);
  const projection = join(workspace, ".event", "pending", agent.sessionId, `${reply.replyId}.json`);
  await rm(projection);
  const resumed = await fixture.openAgent({ workspace, sessionId: agent.sessionId });
  expect(await resumed.getPendingReplies()).toEqual([{ ...reply, confirmedChunks: 1 }]);
  sink.push(
    ...["chunk one", "chunk two"].slice((await resumed.getPendingReplies())[0].confirmedChunks),
  );
  await resumed.confirmChunks(reply.replyId, 2);
  const stale = await readFile(projection, "utf8");
  await resumed.acknowledgeReply(reply.replyId);
  await writeFile(projection, stale);
  const fresh = await fixture.openAgent({ workspace, sessionId: agent.sessionId });
  expect(await fresh.getPendingReplies()).toEqual([]);
  expect(await readdir(join(workspace, ".event", "pending", agent.sessionId))).toEqual([]);
  expect(sink).toEqual(["chunk one", "chunk two"]);
  const history = await ConversationHistory.open(join(workspace, ".history"));
  expect((await history.getSession(agent.sessionId))?.message_count).toBe(2);
  expect(await history.getMessages(agent.sessionId)).toHaveLength(2);
  await fresh.chat("Next");
  expect(fixture.requests.at(-1)?.messages).toEqual([
    { role: "system", content: "Give concise answers." },
    { role: "user", content: "Question" },
    { role: "assistant", content: "Hello!", reasoning_content: "Full reasoning." },
    { role: "user", content: "Next" },
  ]);
});

it("keeps pending replies ordered and rejects regressing or unrelated progress", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  const agent = await fixture.openAgent({ workspace });
  await agent.chat("First");
  await agent.chat("Second");
  const [first, second] = await agent.getPendingReplies();
  await agent.confirmChunks(first.replyId, 2);
  const path = join(workspace, ".history", "sessions", `${agent.sessionId}.jsonl`);
  const before = await readFile(path, "utf8");
  for (const count of [-1, 1, 1.5, Number.NaN]) {
    await expect(agent.confirmChunks(first.replyId, count)).rejects.toThrow(
      "Invalid chunk progress",
    );
  }
  await expect(agent.acknowledgeReply("unknown")).rejects.toThrow("Invalid delivery state");
  expect(await readFile(path, "utf8")).toBe(before);
  const fresh = await fixture.openAgent({ workspace, sessionId: agent.sessionId });
  expect(await fresh.getPendingReplies()).toEqual([{ ...first, confirmedChunks: 2 }, second]);
  await fresh.acknowledgeReply(first.replyId);
  expect(await fresh.getPendingReplies()).toEqual([second]);
});

it("does not turn legacy assistant messages into pending deliveries", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  const agent = await fixture.openAgent({ workspace });
  const history = await ConversationHistory.open(join(workspace, ".history"));
  await history.saveMessage(agent.sessionId, { role: "user", content: "Old question" });
  await history.saveMessage(agent.sessionId, { role: "assistant", content: "Old answer" });
  const fresh = await fixture.openAgent({ workspace, sessionId: agent.sessionId });
  expect(await fresh.getPendingReplies()).toEqual([]);
  expect(fixture.requests).toHaveLength(0);
});

it.each(["missing", "truncated"])(
  "does not recover a %s completion as success or pending delivery",
  async (mode) => {
    fixture = await chatFixture();
    const workspace = await fixture.workspace();
    const agent = await fixture.openAgent({ workspace });
    await agent.chat("Question");
    const path = join(workspace, ".history", "sessions", `${agent.sessionId}.jsonl`);
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    const saved = lines.pop() ?? "";
    const broken = `${lines.join("\n")}\n${mode === "truncated" ? saved.slice(0, -2) : ""}`;
    await writeFile(path, broken);
    const fresh = await fixture.openAgent({ workspace, sessionId: agent.sessionId });
    expect(await fresh.getPendingReplies()).toEqual([]);
    const history = await ConversationHistory.open(join(workspace, ".history"));
    expect((await history.getMessages(agent.sessionId)).map((message) => message.role)).toEqual([
      "user",
    ]);
    const repaired = await readFile(path, "utf8");
    expect(repaired.startsWith(broken)).toBe(true);
    expect(repaired).toContain('"type":"turn_interrupted"');
    expect(fixture.requests).toHaveLength(1);
  },
);

it.each([
  null,
  {},
  { turnId: "wrong", replyId: "reply", payload: "Hello!", destination: "platform-cli:cli-user" },
])(
  "rejects invalid completion metadata instead of falling back to an ordinary final answer: %j",
  async (invalid) => {
    fixture = await chatFixture();
    const workspace = await fixture.workspace();
    const agent = await fixture.openAgent({ workspace });
    await agent.chat("Question");
    const path = join(workspace, ".history", "sessions", `${agent.sessionId}.jsonl`);
    const lines = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    lines.at(-1).completion = invalid;
    const bytes = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
    await writeFile(path, bytes);
    await expect(fixture.openAgent({ workspace, sessionId: agent.sessionId })).rejects.toThrow(
      "Invalid completion metadata",
    );
    const history = await ConversationHistory.open(join(workspace, ".history"));
    await expect(history.getMessages(agent.sessionId)).rejects.toThrow(
      "Invalid completion metadata",
    );
    expect(await readFile(path, "utf8")).toBe(bytes);
  },
);

it("recovers a committed reply after projection failure without replaying its tool", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  const agent = await fixture.openAgent({ workspace });
  const artifact = join(workspace, "artifact");
  fixture.responses.push({
    status: 200,
    body: toolReply([
      { id: "write-once", name: "write", args: { path: artifact, content: "Tool effect" } },
    ]),
  });
  await writeFile(join(workspace, ".event"), "Block pending projection");
  await expect(agent.chat("Write")).rejects.toThrow();
  expect(await readFile(artifact, "utf8")).toBe("Tool effect");
  await writeFile(artifact, "Changed after tool");
  await rm(join(workspace, ".event"));
  const fresh = await fixture.openAgent({ workspace, sessionId: agent.sessionId });
  expect(await fresh.getPendingReplies()).toMatchObject([{ payload: "Hello!" }]);
  expect(await readFile(artifact, "utf8")).toBe("Changed after tool");
  expect(fixture.requests).toHaveLength(2);
});

it("preserves completed tools when the final log append fails without exposing a reply", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  const agent = await fixture.openAgent({ workspace });
  const artifact = join(workspace, "artifact");
  let release = (_value: unknown) => {};
  fixture.responses.push(
    {
      status: 200,
      body: toolReply([
        { id: "write-once", name: "write", args: { path: artifact, content: "Tool effect" } },
      ]),
    },
    {
      status: 200,
      body: new Promise((resolve) => {
        release = resolve;
      }),
    },
  );
  const turn = agent.chat("Write");
  const rejected = expect(turn).rejects.toThrow();
  await vi.waitFor(() => expect(fixture.requests).toHaveLength(2));
  const log = join(workspace, ".history", "sessions", `${agent.sessionId}.jsonl`);
  const saved = `${log}.saved`;
  const before = await readFile(log, "utf8");
  await rename(log, saved);
  await mkdir(log);
  try {
    release({ choices: [{ message: { role: "assistant", content: "Must not return" } }] });
    await rejected;
  } finally {
    await rm(log, { recursive: true });
    await rename(saved, log);
  }
  expect(await readFile(log, "utf8")).toBe(before);
  await writeFile(artifact, "Changed after tool");
  const fresh = await fixture.openAgent({ workspace, sessionId: agent.sessionId });
  expect(await fresh.getPendingReplies()).toEqual([]);
  expect(await readFile(artifact, "utf8")).toBe("Changed after tool");
  const history = await ConversationHistory.open(join(workspace, ".history"));
  expect((await history.getMessages(agent.sessionId)).map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "tool",
  ]);
  expect(fixture.requests).toHaveLength(2);
});

it("rejects an invalid entire completion before appending any final message", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  const agent = await fixture.openAgent({ workspace });
  const history = await ConversationHistory.open(join(workspace, ".history"));
  const turnId = await history.saveMessage(agent.sessionId, { role: "user", content: "Question" });
  const log = join(workspace, ".history", "sessions", `${agent.sessionId}.jsonl`);
  const before = await readFile(log, "utf8");
  const metadata = {
    turnId,
    replyId: "stable",
    payload: "Answer",
    destination: "platform-cli:cli-user",
  };
  // Exercise the disk boundary with runtime data that erased TypeScript types cannot protect.
  const malformed = JSON.parse('{"role":"assistant","content":"Answer","reasoning_content":42}');
  await expect(history.saveCompletion(agent.sessionId, malformed, metadata)).rejects.toThrow(
    "Invalid completion metadata",
  );
  expect(await readFile(log, "utf8")).toBe(before);
  await expect(
    history.saveCompletion(
      agent.sessionId,
      { role: "assistant", content: "Answer" },
      JSON.parse("null"),
    ),
  ).rejects.toThrow("Invalid completion metadata");
  expect(await readFile(log, "utf8")).toBe(before);
});

it("restores committed context before the same Agent continues after projection failure", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  const agent = await fixture.openAgent({ workspace });
  await writeFile(join(workspace, ".event"), "Block pending projection");
  await expect(agent.chat("First question")).rejects.toThrow();
  await rm(join(workspace, ".event"));
  await agent.chat("Second question");
  expect(fixture.requests.at(-1)?.messages).toEqual([
    { role: "system", content: "Give concise answers." },
    { role: "user", content: "First question" },
    { role: "assistant", content: "Hello!", reasoning_content: "Full reasoning." },
    { role: "user", content: "Second question" },
  ]);
  expect(await agent.getPendingReplies()).toHaveLength(2);
});
