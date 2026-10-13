import { access, appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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

async function savedSession(lines: unknown[]) {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  const root = join(workspace, ".history");
  const log = join(root, "sessions", "saved.jsonl");
  await mkdir(join(root, "sessions"), { recursive: true });
  await writeFile(
    join(root, "index.jsonl"),
    `${JSON.stringify({
      id: "saved",
      agent_id: "helper",
      created_at: "t",
      updated_at: "t",
      message_count: 0,
      extension: { source: "legacy" },
    })}\n`,
  );
  await writeFile(
    log,
    `${lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n")}\n`,
  );
  return { workspace, root, log };
}

const user = (content: string, id?: string) => ({
  timestamp: "t",
  role: "user",
  content,
  ...(id ? { id } : {}),
});
const compaction = (id: string, summary: unknown, firstKeptEntryId: unknown) => ({
  type: "compaction",
  id,
  timestamp: "t",
  summary,
  firstKeptEntryId,
});

it.each([
  ["empty summary", "", "recent"],
  ["wrong summary type", 42, "recent"],
  ["missing boundary", "bad", undefined],
  ["wrong boundary type", "bad", 42],
  ["unresolved boundary", "bad", "absent"],
  ["state boundary", "bad", "state"],
  ["future boundary", "bad", "later"],
])(
  "falls back from a compaction with %s to the last valid summary",
  async (_name, summary, boundary) => {
    const { workspace } = await savedSession([
      user("Old", "old"),
      user("Recent", "recent"),
      compaction("valid", "Saved checkpoint", "recent"),
      { type: "turn_interrupted", id: "state", timestamp: "t" },
      compaction("invalid", summary, boundary),
      user("Later", "later"),
    ]);
    const agent = await Agent.open({ workspace, sessionId: "saved" });
    expect(fixture?.requests).toHaveLength(0);
    expect(agent.recoveryDiagnostics.join("\n")).toContain("invalid compaction");
    await agent.chat("Next");
    expect(
      fixture?.requests
        .at(-1)
        ?.messages.slice(1)
        .map((message) => message.content),
    ).toEqual([expect.stringContaining("Saved checkpoint"), "Recent", "Later", "Next"]);
  },
);

it.each([
  ["invalid records", ["not json", { type: "compaction", summary: "orphan" }]],
  ["whitespace-only bytes", ["   ", "\t"]],
])("rejects and preserves a nonempty unrecognizable session with %s", async (_name, lines) => {
  const { workspace, log } = await savedSession(lines);
  const before = await readFile(log, "utf8");
  await expect(Agent.open({ workspace, sessionId: "saved" })).rejects.toThrow(
    "Unrecognizable session log",
  );
  expect(await readFile(log, "utf8")).toBe(before);
});

it("projects interruption repairs next to their original exchange even after later turns", async () => {
  const call = (name: string) => ({
    id: "reused-call",
    type: "function",
    function: { name, arguments: "{}" },
  });
  const { workspace, log } = await savedSession([
    user("First turn", "first"),
    {
      timestamp: "t",
      id: "first-call",
      role: "assistant",
      content: "",
      tool_calls: [call("read")],
    },
    user("Second turn", "second"),
    {
      timestamp: "t",
      id: "second-call",
      role: "assistant",
      content: "",
      tool_calls: [call("write")],
    },
    {
      timestamp: "t",
      role: "tool",
      tool_call_id: "reused-call",
      content: "Confirmed second result",
    },
    { timestamp: "t", role: "assistant", content: "Second answer" },
  ]);
  const before = await readFile(log, "utf8");
  const resumed = await Agent.open({ workspace, sessionId: "saved" });
  const repaired = await readFile(log, "utf8");
  expect(repaired.startsWith(before)).toBe(true);
  await Agent.open({ workspace, sessionId: "saved" });
  expect(await readFile(log, "utf8")).toBe(repaired);
  await resumed.chat("Next");
  expect(fixture?.requests.at(-1)?.messages.slice(1)).toEqual([
    { role: "user", content: "First turn" },
    { role: "assistant", content: "", tool_calls: [call("read")] },
    {
      role: "tool",
      tool_call_id: "reused-call",
      content: "Tool execution interrupted; outcome unknown.",
    },
    { role: "user", content: "Second turn" },
    { role: "assistant", content: "", tool_calls: [call("write")] },
    { role: "tool", content: "Confirmed second result", tool_call_id: "reused-call" },
    { role: "assistant", content: "Second answer" },
    { role: "user", content: "Next" },
  ]);
});

it("can compact a repaired earlier exchange and recover the retained later turn", async () => {
  const { workspace } = await savedSession([
    user(`Older ${"o".repeat(90000)}`, "older"),
    {
      timestamp: "t",
      id: "call-entry",
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "missing", type: "function", function: { name: "read", arguments: "{}" } },
      ],
    },
    user(`Recent ${"r".repeat(90000)}`, "recent"),
    { timestamp: "t", role: "assistant", content: "Recent answer" },
  ]);
  const first = await Agent.open({ workspace, sessionId: "saved" });
  fixture?.responses.push({
    status: 200,
    body: {
      choices: [{ finish_reason: "stop", message: { content: "Earlier tool outcome unknown." } }],
    },
  });
  expect(await first.runCommand("/compact")).toContain("Compacted");
  const second = await Agent.open({ workspace, sessionId: "saved" });
  expect(second.recoveryDiagnostics.join("\n")).not.toContain("invalid compaction");
  await second.chat("Next");
  expect(
    fixture?.requests
      .at(-1)
      ?.messages.slice(1)
      .map((message) => message.content),
  ).toEqual([
    expect.stringContaining("Earlier tool outcome unknown."),
    `Recent ${"r".repeat(90000)}`,
    "Recent answer",
    "Next",
  ]);
});

it("keeps physical legacy IDs stable across malformed lines and unterminated appends", async () => {
  const { workspace, log, root } = await savedSession([
    user("Old"),
    "broken JSON",
    "",
    user("Retained"),
    compaction("checkpoint", "Saved physical boundary", "legacy:4"),
  ]);
  await appendFile(log, '{"role":');
  const before = await readFile(log, "utf8");
  const first = await Agent.open({ workspace, sessionId: "saved" });
  expect(first.recoveryDiagnostics.join("\n")).toContain("Line 2");
  await first.chat("After restart");
  expect((await readFile(log, "utf8")).startsWith(`${before}\n`)).toBe(true);
  const second = await Agent.open({ workspace, sessionId: "saved" });
  await second.chat("Again");
  expect(
    fixture?.requests
      .at(-1)
      ?.messages.slice(1)
      .map((message) => message.content),
  ).toEqual([
    expect.stringContaining("Saved physical boundary"),
    "Retained",
    "After restart",
    "Hello!",
    "Again",
  ]);
  const index = JSON.parse((await readFile(join(root, "index.jsonl"), "utf8")).trim());
  expect(index).toMatchObject({ message_count: 6, extension: { source: "legacy" } });
});

it("repairs missing tool results once, preserving reasoning and never replaying effects", async () => {
  const call = (id: string) => ({
    id,
    type: "function",
    function: { name: "write", arguments: '{"path":"must-not-exist","content":"effect"}' },
  });
  const { workspace, root, log } = await savedSession([
    user("Run two writes", "input"),
    {
      id: "calls",
      timestamp: "t",
      role: "assistant",
      content: "",
      reasoning_content: "Original reasoning",
      tool_calls: [call("confirmed"), call("uncertain")],
    },
    { timestamp: "t", role: "tool", content: "Already saved result", tool_call_id: "confirmed" },
  ]);
  const first = await Agent.open({ workspace, sessionId: "saved" });
  expect(fixture?.requests).toHaveLength(0);
  const reader = await ConversationHistory.open(root);
  const messages = await reader.getMessages("saved");
  expect(messages).toHaveLength(4);
  expect(messages[3]).toMatchObject({
    role: "tool",
    tool_call_id: "uncertain",
    content: expect.stringMatching(/interrupted.*unknown/i),
  });
  const repaired = await readFile(log, "utf8");
  expect(JSON.parse(repaired.trim().split("\n").at(-1) ?? "")).toMatchObject({
    type: "turn_interrupted",
  });
  const second = await Agent.open({ workspace, sessionId: "saved" });
  expect(await readFile(log, "utf8")).toBe(repaired);
  await expect(access(join(workspace, "must-not-exist"))).rejects.toThrow();
  await second.chat("Continue without replay");
  expect(fixture?.requests.at(-1)?.messages[2]).toMatchObject({
    role: "assistant",
    reasoning_content: "Original reasoning",
    tool_calls: [call("confirmed"), call("uncertain")],
  });
  expect((await reader.getSession(first.sessionId))?.message_count).toBe(6);
});

it("recognizes new sessions by log metadata and preserves stable IDs without the index", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  const original = await Agent.open({ workspace });
  const input = `${"a".repeat(49)}😀b`;
  await original.chat(input);
  const root = join(workspace, ".history");
  const log = join(root, "sessions", `${original.sessionId}.jsonl`);
  const before = await readFile(log, "utf8");
  const entries = before
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(entries[0]).toMatchObject({ type: "session", id: original.sessionId, agent_id: "helper" });
  expect(new Set(entries.map((entry) => entry.id)).size).toBe(3);
  await rm(join(root, "index.jsonl"));
  const resumed = await Agent.open({ workspace, sessionId: original.sessionId });
  await resumed.chat("Next");
  expect((await readFile(log, "utf8")).startsWith(before)).toBe(true);
  expect(
    fixture.requests
      .at(-1)
      ?.messages.slice(1)
      .map((message) => message.content),
  ).toEqual([input, "Hello!", "Next"]);
  const reader = await ConversationHistory.open(root);
  expect((await reader.getSession(original.sessionId))?.message_count).toBe(4);
  expect((await reader.getSession(original.sessionId))?.title).toBe(`${"a".repeat(49)}😀...`);
});

it("serializes session writes across independent readers without losing index updates", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  const root = join(workspace, ".history");
  const first = await ConversationHistory.open(root);
  const second = await ConversationHistory.open(root);
  await first.createSession("helper", "one");
  await second.createSession("helper", "two");
  await Promise.all([
    first.saveMessage("one", { role: "user", content: "First one" }),
    second.saveMessage("two", { role: "user", content: "First two" }),
    first.saveMessage("one", { role: "assistant", content: "One answer" }),
    second.saveMessage("two", { role: "assistant", content: "Two answer" }),
  ]);
  const reader = await ConversationHistory.open(root);
  expect(await reader.getSession("one")).toMatchObject({ title: "First one", message_count: 2 });
  expect(await reader.getSession("two")).toMatchObject({ title: "First two", message_count: 2 });
  expect((await reader.getMessages("one")).map((message) => message.content)).toEqual([
    "First one",
    "One answer",
  ]);
});

it("retains message extensions and exact tool arguments/results through resumed model and tool execution", async () => {
  const originalArguments = '{ "path": "unused", "extension": true }';
  const { workspace, root } = await savedSession([
    { ...user("Read", "input"), name: "saved-user" },
    {
      timestamp: "t",
      id: "assistant",
      role: "assistant",
      content: "",
      reasoning_content: "Exact reasoning",
      extension: { keep: true },
      tool_calls: [
        {
          id: "original-call",
          type: "function",
          extension: "call-field",
          function: { name: "read", arguments: originalArguments, extension: "function-field" },
        },
      ],
    },
    { timestamp: "t", role: "tool", content: "Exact result\n😀", tool_call_id: "original-call" },
    { timestamp: "t", role: "assistant", content: "Done" },
  ]);
  const path = join(workspace, "new-artifact");
  fixture?.responses.push({
    status: 200,
    body: toolReply([
      { id: "new-write", name: "write", args: { path, content: "Resumed effect" } },
    ]),
  });
  const resumed = await Agent.open({ workspace, sessionId: "saved" });
  expect(await resumed.chat("Write a new artifact")).toBe("Hello!");
  expect(await readFile(path, "utf8")).toBe("Resumed effect");
  const request = fixture?.requests[0].messages;
  expect(request?.[1]).toMatchObject({ name: "saved-user" });
  expect(request?.[2]).toMatchObject({
    extension: { keep: true },
    reasoning_content: "Exact reasoning",
    tool_calls: [
      {
        id: "original-call",
        extension: "call-field",
        function: { arguments: originalArguments, extension: "function-field" },
      },
    ],
  });
  expect(request?.[3]).toMatchObject({
    content: "Exact result\n😀",
    tool_call_id: "original-call",
  });
  expect((await (await ConversationHistory.open(root)).getMessages("saved"))[1]).toMatchObject({
    extension: { keep: true },
  });
});

it("does not install a summary when its log cannot be persisted", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  const agent = await Agent.open({ workspace });
  await agent.chat(`Older ${"o".repeat(90000)}`);
  await agent.chat(`Recent ${"r".repeat(90000)}`);
  const context = await agent.runCommand("/context");
  const log = join(workspace, ".history", "sessions", `${agent.sessionId}.jsonl`);
  const before = await readFile(log, "utf8");
  await rename(log, `${log}.saved`);
  await mkdir(log);
  fixture.responses.push({
    status: 200,
    body: { choices: [{ finish_reason: "stop", message: { content: "Must not install." } }] },
  });
  try {
    expect(await agent.runCommand("/compact")).toContain("Compaction failed");
    expect(await agent.runCommand("/context")).toBe(context);
  } finally {
    await rm(log, { recursive: true });
    await rename(`${log}.saved`, log);
  }
  expect(await readFile(log, "utf8")).toBe(before);
  await agent.chat("Continue");
  expect(fixture.requests.at(-1)?.messages[1].content).toContain("Older");
});

it("recognizes the explicit empty-prefix marker and ignores invalid optional statistics", async () => {
  const { workspace, root } = await savedSession([
    user("Old", "old"),
    {
      ...compaction("checkpoint", "Keep this exact summary\n", "checkpoint"),
      tokensBefore: "bad",
      tokensAfter: -1,
    },
    user("Later", "later"),
  ]);
  const agent = await Agent.open({ workspace, sessionId: "saved" });
  expect(agent.recoveryDiagnostics.join("\n")).toContain("ignoring invalid compaction statistic");
  await agent.chat("Next");
  expect(
    fixture?.requests
      .at(-1)
      ?.messages.slice(1)
      .map((message) => message.content),
  ).toEqual([
    "The conversation history before this point was compacted into the following summary:\n\n<summary>\nKeep this exact summary\n\n</summary>",
    "Later",
    "Next",
  ]);
  expect(await (await ConversationHistory.open(root)).getMessages("saved")).toHaveLength(4);
});

it.each([
  ["missing identity", { type: "compaction", summary: "Bad", firstKeptEntryId: "recent" }],
  ["duplicate boundary", compaction("invalid", "Bad", "duplicate")],
  ["duplicate identity", compaction("duplicate", "Bad", "recent")],
])("uses recognized full history for a compaction with %s", async (_name, invalid) => {
  const { workspace } = await savedSession([
    user("Old", "duplicate"),
    user("Recent", "recent"),
    { type: "turn_interrupted", id: "duplicate" },
    invalid,
  ]);
  const agent = await Agent.open({ workspace, sessionId: "saved" });
  expect(agent.recoveryDiagnostics.join("\n")).toContain("invalid compaction");
  await agent.chat("Next");
  expect(
    fixture?.requests
      .at(-1)
      ?.messages.slice(1)
      .map((message) => message.content),
  ).toEqual(["Old", "Recent", "Next"]);
});

it.each(["result", "after-exchange"])(
  "rejects a compaction that cuts an unfinished tool exchange at %s",
  async (boundary) => {
    const call = { id: "missing", type: "function", function: { name: "read", arguments: "{}" } };
    const { workspace } = await savedSession([
      user("Input", "input"),
      { timestamp: "t", id: "calls", role: "assistant", content: "", tool_calls: [call] },
      { timestamp: "t", id: "result", role: "tool", content: "Unrelated", tool_call_id: "other" },
      user("After exchange", "after-exchange"),
      compaction("invalid", "Bad", boundary),
    ]);
    const agent = await Agent.open({ workspace, sessionId: "saved" });
    expect(agent.recoveryDiagnostics.join("\n")).toContain("invalid compaction");
    await agent.chat("Next");
    expect(fixture?.requests.at(-1)?.messages[1].content).toBe("Input");
  },
);

it("appends a successful compaction while preserving original messages", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  const agent = await Agent.open({ workspace });
  await agent.chat(`Older objective ${"o".repeat(90000)}`);
  await agent.chat(`Recent objective ${"r".repeat(90000)}`);
  const log = join(workspace, ".history", "sessions", `${agent.sessionId}.jsonl`);
  const before = await readFile(log, "utf8");
  fixture.responses.push({
    status: 200,
    body: { choices: [{ finish_reason: "stop", message: { content: "Older work complete." } }] },
  });
  expect(await agent.runCommand("/compact")).toContain("Compacted");
  const saved = await readFile(log, "utf8");
  expect(saved.startsWith(before)).toBe(true);
  expect(saved.slice(before.length)).not.toBe("");
  expect(JSON.parse(saved.slice(before.length))).toMatchObject({
    type: "compaction",
    id: expect.any(String),
    summary: "Older work complete.",
    firstKeptEntryId: expect.any(String),
  });
  const reader = await ConversationHistory.open(join(workspace, ".history"));
  expect(await reader.getMessages(agent.sessionId)).toHaveLength(4);
  expect((await reader.getSession(agent.sessionId))?.message_count).toBe(4);
});

it("restores the saved summary and retained messages without another summary request", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  const original = await Agent.open({ workspace });
  await original.chat(`Older ${"o".repeat(90000)}`);
  await original.chat(`Recent ${"r".repeat(90000)}`);
  fixture.responses.push({
    status: 200,
    body: {
      choices: [{ finish_reason: "stop", message: { content: "Remember the older work." } }],
    },
  });
  await original.runCommand("/compact");
  const requestsBefore = fixture.requests.length;
  const resumed = await Agent.open({ workspace, sessionId: original.sessionId });
  expect(resumed.sessionId).toBe(original.sessionId);
  expect(fixture.requests).toHaveLength(requestsBefore);
  await resumed.chat("Continue");
  expect(fixture.requests.at(-1)?.messages).toEqual([
    { role: "system", content: "Give concise answers." },
    {
      role: "user",
      content:
        "The conversation history before this point was compacted into the following summary:\n\n<summary>\nRemember the older work.\n</summary>",
    },
    { role: "user", content: `Recent ${"r".repeat(90000)}` },
    { role: "assistant", content: "Hello!", reasoning_content: "Full reasoning." },
    { role: "user", content: "Continue" },
  ]);
});

it("recovers repeated compactions and incrementally updates only the retained transcript", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  const first = await Agent.open({ workspace });
  await first.chat(`First objective ${"a".repeat(90000)}`);
  await first.chat(`Second objective ${"b".repeat(90000)}`);
  fixture.responses.push({
    status: 200,
    body: { choices: [{ finish_reason: "stop", message: { content: "Checkpoint one." } }] },
  });
  await first.runCommand("/compact");
  const second = await Agent.open({ workspace, sessionId: first.sessionId });
  await second.chat(`Third objective ${"c".repeat(90000)}`);
  fixture.responses.push({
    status: 200,
    body: { choices: [{ finish_reason: "stop", message: { content: "Checkpoint two." } }] },
  });
  expect(await second.runCommand("/compact")).toContain("Compacted");
  const summaryInput = fixture.requests.at(-1)?.messages[1].content;
  expect(summaryInput).toContain("Checkpoint one.");
  expect(summaryInput).toContain("Second objective");
  expect(summaryInput).not.toContain("First objective");
  const third = await Agent.open({ workspace, sessionId: first.sessionId });
  await third.chat("Continue");
  const contents = fixture.requests
    .at(-1)
    ?.messages.slice(1)
    .map((message) => message.content);
  expect(contents).toEqual([
    expect.stringContaining("Checkpoint two."),
    `Third objective ${"c".repeat(90000)}`,
    "Hello!",
    "Continue",
  ]);
  const fresh = await Agent.open({ workspace });
  expect(fresh.sessionId).not.toBe(first.sessionId);
  expect(await fresh.runCommand("/context")).toContain("**Active messages:** 0");
});

it("keeps attempted input after a failed request without automatically restarting it", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  const first = await Agent.open({ workspace });
  fixture.responses.push({ status: 503, body: { error: { message: "Unavailable" } } });
  await expect(first.chat("Saved attempted input")).rejects.toThrow("HTTP 503");
  const resumed = await Agent.open({ workspace, sessionId: first.sessionId });
  expect(fixture.requests).toHaveLength(1);
  await resumed.chat("New input");
  expect(
    fixture.requests
      .at(-1)
      ?.messages.slice(1)
      .map((message) => message.content),
  ).toEqual(["Saved attempted input", "New input"]);
});

it("skips invalid saved messages with diagnostics instead of sending malformed tool data", async () => {
  const { workspace, root } = await savedSession([
    user("Recognized", "user"),
    { timestamp: "t", role: "tool", content: "Missing call identity" },
    {
      timestamp: "t",
      role: "assistant",
      content: "",
      tool_calls: [{ id: "", type: "function", function: { name: "read", arguments: "{}" } }],
    },
    { ...user("Invalid entry identity"), id: 42 },
    { timestamp: "t", role: "assistant", content: "Valid answer" },
  ]);
  const agent = await Agent.open({ workspace, sessionId: "saved" });
  expect(
    agent.recoveryDiagnostics.filter((diagnostic) => diagnostic.includes("invalid message")),
  ).toHaveLength(3);
  await agent.chat("Next");
  expect(
    fixture?.requests
      .at(-1)
      ?.messages.slice(1)
      .map((message) => message.content),
  ).toEqual(["Recognized", "Valid answer", "Next"]);
  expect(await (await ConversationHistory.open(root)).getMessages("saved")).toHaveLength(4);
});
