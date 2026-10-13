import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { ConversationHistory } from "../src/core/history.ts";
import { EventRuntime } from "../src/core/runtime.ts";
import { chatFixture } from "./chat-fixture.ts";

let fixture: Awaited<ReturnType<typeof chatFixture>> | undefined;
let runtime: EventRuntime | undefined;
afterEach(async () => {
  await runtime?.stop();
  runtime = undefined;
  await fixture?.close();
  fixture = undefined;
});

it("binds concurrent first inputs to one saved session in reception order", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  runtime = await EventRuntime.open({ workspace });
  const [first, second] = await Promise.all([
    runtime.submit({ source: "platform-ws:alice:device", content: "Remember Alice" }),
    runtime.submit({ source: "platform-ws:alice:device", content: "Who?" }),
  ]);
  expect(first).toMatchObject({ error: null, content: "Hello!" });
  expect(second.session_id).toBe(first.session_id);
  expect(fixture.requests[1].messages).toEqual([
    { role: "system", content: "Give concise answers." },
    { role: "user", content: "Remember Alice" },
    { role: "assistant", content: "Hello!", reasoning_content: "Full reasoning." },
    { role: "user", content: "Who?" },
  ]);
  const saved = parse(await readFile(join(workspace, "config.runtime.yaml"), "utf8"));
  expect(saved.sources).toEqual({ "platform-ws:alice:device": { session_id: first.session_id } });
  expect(await runtime.getPendingReplies(first.session_id)).toEqual([
    expect.objectContaining({ destination: "platform-ws:alice:device" }),
    expect.objectContaining({ destination: "platform-ws:alice:device" }),
  ]);
});

it("records the source in session metadata and rejects forged session input", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  runtime = await EventRuntime.open({ workspace });
  const result = await runtime.submit({ source: "platform-telegram:123:-456", content: "Hello" });
  const index = await readFile(join(workspace, ".history", "index.jsonl"), "utf8");
  const log = await readFile(
    join(workspace, ".history", "sessions", `${result.session_id}.jsonl`),
    "utf8",
  );
  expect(JSON.parse(index.trim())).toMatchObject({ source: "platform-telegram:123:-456" });
  expect(JSON.parse(log.split("\n")[0])).toMatchObject({ source: "platform-telegram:123:-456" });
  await expect(
    runtime.submit({
      type: "InboundEvent",
      session_id: result.session_id,
      source: "platform-telegram:999:-456",
      content: "Wrong user",
      timestamp: 1,
      retry_count: 0,
    }),
  ).rejects.toThrow("source");
  await runtime.stop();
  const invalid = JSON.parse(index.trim());
  invalid.source = 42;
  await writeFile(join(workspace, ".history", "index.jsonl"), `${JSON.stringify(invalid)}\n`);
  runtime = await EventRuntime.open({ workspace });
  await expect(
    runtime.submit({ source: "platform-telegram:123:-456", content: "Again" }),
  ).rejects.toThrow("source");
  await runtime.stop();
  await writeFile(join(workspace, ".history", "index.jsonl"), index);
  const records = log
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  records[0].source = "platform-ws:someone-else";
  await writeFile(
    join(workspace, ".history", "sessions", `${result.session_id}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
  runtime = await EventRuntime.open({ workspace });
  await expect(
    runtime.submit({ source: "platform-telegram:123:-456", content: "Again" }),
  ).rejects.toThrow("source");
  expect(fixture.requests).toHaveLength(1);
});

it("isolates Telegram users and chats and restores affinity through a fresh runtime", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  runtime = await EventRuntime.open({ workspace });
  const first = await runtime.submit({ source: "platform-telegram:1:-10", content: "Alice" });
  const otherUser = await runtime.submit({ source: "platform-telegram:2:-10", content: "Bob" });
  const otherChat = await runtime.submit({ source: "platform-telegram:1:20", content: "Private" });
  expect(new Set([first.session_id, otherUser.session_id, otherChat.session_id]).size).toBe(3);
  expect(fixture.requests[1].messages.map((message) => message.content)).toEqual([
    "Give concise answers.",
    "Bob",
  ]);
  expect(await runtime.getPendingReplies(otherUser.session_id)).toEqual([
    expect.objectContaining({ destination: "platform-telegram:2:-10" }),
  ]);
  await runtime.stop();
  runtime = await EventRuntime.open({ workspace });
  const continued = await runtime.submit({ source: "platform-telegram:1:-10", content: "Who?" });
  expect(continued.session_id).toBe(first.session_id);
  expect(fixture.requests[3].messages.map((message) => message.content)).toEqual([
    "Give concise answers.",
    "Alice",
    "Hello!",
    "Who?",
  ]);
});

it("honors new WebSocket Agent selection and rejects existing ownership conflicts", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  await otherAgent(workspace);
  runtime = await EventRuntime.open({ workspace });
  const chosen = await runtime.submit({
    source: "platform-ws:chosen",
    content: "Hi",
    agent_id: "other",
  });
  expect(chosen).toMatchObject({ source: "agent:other", error: null });
  expect(fixture.requests[0].messages[0].content).toBe("Other instructions.");
  await expect(
    runtime.submit({ source: "platform-ws:chosen", content: "Switch", agent_id: "helper" }),
  ).rejects.toThrow("Agent");
  const same = await runtime.submit({
    source: "platform-ws:chosen",
    content: "Continue",
    agent_id: "other",
  });
  expect(same.session_id).toBe(chosen.session_id);
  const defaultSession = await runtime.submit({ source: "platform-ws:default", content: "Hi" });
  expect(defaultSession).toMatchObject({ source: "agent:helper" });
  await runtime.stop();
  runtime = await EventRuntime.open({ workspace });
  await expect(
    runtime.submit({ source: "platform-ws:chosen", content: "Switch", agent_id: "helper" }),
  ).rejects.toThrow("Agent");
  const resumed = await runtime.submit({ source: "platform-ws:chosen", content: "Again" });
  expect(resumed).toMatchObject({ session_id: chosen.session_id, source: "agent:other" });
});

async function otherAgent(workspace: string) {
  await mkdir(join(workspace, ".agents/bots/other"));
  await writeFile(
    join(workspace, ".agents/bots/other/AGENT.md"),
    "---\nname: Other\n---\nOther instructions.\n",
  );
}

it("applies default Agent changes only to new sources", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  await otherAgent(workspace);
  runtime = await EventRuntime.open({ workspace });
  const original = await runtime.submit({ source: "platform-ws:old", content: "First" });
  await writeFile(
    join(workspace, "config.runtime.yaml"),
    `default_agent: other\nsources:\n  platform-ws:old:\n    session_id: ${original.session_id}\n`,
  );
  const existing = await runtime.submit({ source: "platform-ws:old", content: "Next" });
  const fresh = await runtime.submit({ source: "platform-ws:new", content: "New" });
  expect(existing).toMatchObject({ session_id: original.session_id, source: "agent:helper" });
  expect(fresh).toMatchObject({ source: "agent:other" });
});

it("keeps queued input in its accepted session when a legacy binding changes", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  runtime = await EventRuntime.open({ workspace });
  const history = await ConversationHistory.open(join(workspace, ".history"));
  await history.createSession("helper", "old");
  await history.createSession("helper", "new");
  const oldSession = await runtime.openSession({ sessionId: "old" });
  const newSession = await runtime.openSession({ sessionId: "new" });
  await writeFile(
    join(workspace, "config.runtime.yaml"),
    `sources:\n  platform-ws:alice:\n    session_id: ${oldSession.session_id}\n`,
  );
  const held = Promise.withResolvers<unknown>();
  const started = Promise.withResolvers<void>();
  fixture.server.once("request", () => started.resolve());
  fixture.responses.push({ status: 200, body: held.promise });
  const first = runtime.submit({ source: "platform-ws:alice", content: "First" });
  await started.promise;
  const queued = Promise.withResolvers<void>();
  runtime.subscribe(async (event) => {
    if (event.type === "InboundEvent" && event.content === "Queued") queued.resolve();
  });
  const second = runtime.submit({ source: "platform-ws:alice", content: "Queued" });
  try {
    await queued.promise;
    await writeFile(
      join(workspace, "config.runtime.yaml"),
      `sources:\n  platform-ws:alice:\n    session_id: ${newSession.session_id}\n`,
    );
    const later = await runtime.submit({ source: "platform-ws:alice", content: "Later" });
    expect(later.session_id).toBe(newSession.session_id);
  } finally {
    held.resolve({ choices: [{ message: { role: "assistant", content: "First answer" } }] });
    await first;
  }
  expect((await second).session_id).toBe(oldSession.session_id);
  expect(fixture.requests[2].messages.map((message) => message.content)).toEqual([
    "Give concise answers.",
    "First",
    "First answer",
    "Queued",
  ]);
  expect(
    (await runtime.getPendingReplies(oldSession.session_id)).map((reply) => reply.destination),
  ).toEqual(["platform-ws:alice", "platform-ws:alice"]);
});

it.each([
  { source: "platform-telegram:bad:10", content: "Hi" },
  { source: "platform-ws:", content: "Hi" },
  { source: "platform-ws:   ", content: "Hi" },
  { source: "agent:helper", content: "Hi" },
  { source: "platform-cli:cli-user", content: "Hi" },
  { source: "platform-ws:alice", content: 42 },
  { source: "platform-ws:alice", content: "Hi", agent_id: 42 },
  { source: "platform-telegram:1:10", content: "Hi", agent_id: "helper" },
])("rejects malformed source input without creating history: %j", async (input) => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  runtime = await EventRuntime.open({ workspace });
  await expect(runtime.submit(input)).rejects.toThrow();
  expect(fixture.requests).toHaveLength(0);
  await expect(readFile(join(workspace, ".history/index.jsonl"), "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("preserves unusable bindings and does not create a replacement session", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  runtime = await EventRuntime.open({ workspace });
  await expect(
    runtime.submit({ source: "platform-ws:unknown", content: "Hi", agent_id: "missing" }),
  ).rejects.toThrow();
  await expect(readFile(join(workspace, "config.runtime.yaml"), "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
  await writeFile(
    join(workspace, "config.runtime.yaml"),
    "sources:\n  platform-ws:missing:\n    session_id: no-session\n",
  );
  await expect(runtime.submit({ source: "platform-ws:missing", content: "Hi" })).rejects.toThrow(
    "Session not found",
  );
  const valid = await runtime.submit({ source: "platform-ws:valid", content: "Hi" });
  await runtime.stop();
  const log = join(workspace, ".history/sessions", `${valid.session_id}.jsonl`);
  await writeFile(log, "preserve these invalid bytes\n");
  runtime = await EventRuntime.open({ workspace });
  await expect(runtime.submit({ source: "platform-ws:valid", content: "Again" })).rejects.toThrow(
    "Unrecognizable session",
  );
  expect(await readFile(log, "utf8")).toBe("preserve these invalid bytes\n");
  expect(parse(await readFile(join(workspace, "config.runtime.yaml"), "utf8")).sources).toEqual({
    "platform-ws:missing": { session_id: "no-session" },
    "platform-ws:valid": { session_id: valid.session_id },
  });
  expect(fixture.requests).toHaveLength(1);
});

it("drains accepted source input when shutdown starts during routing", async () => {
  fixture = await chatFixture();
  runtime = await EventRuntime.open({ workspace: await fixture.workspace() });
  const accepted = runtime.submit({ source: "platform-ws:alice", content: "Accepted" });
  const stopped = runtime.stop();
  await expect(accepted).resolves.toMatchObject({ content: "Hello!", error: null });
  await stopped;
  expect(fixture.requests).toHaveLength(1);
});

it("recovers a saved summary and unfinished tools without model or tool replay", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  runtime = await EventRuntime.open({ workspace });
  const first = await runtime.submit({ source: "platform-ws:alice", content: "Old conversation" });
  await runtime.stop();
  const history = await ConversationHistory.open(join(workspace, ".history"));
  await history.saveCompaction(first.session_id, "Exact saved summary.\n", undefined);
  await history.saveMessage(first.session_id, { role: "user", content: "Unfinished work" });
  await history.saveMessage(first.session_id, {
    role: "assistant",
    content: "",
    reasoning_content: "Original tool reasoning.",
    tool_calls: [
      {
        id: "unfinished",
        type: "function",
        function: { name: "bash", arguments: JSON.stringify({ command: "touch replayed" }) },
      },
    ],
  });
  runtime = await EventRuntime.open({ workspace });
  expect(fixture.requests).toHaveLength(1);
  const next = await runtime.submit({ source: "platform-ws:alice", content: "Continue" });
  expect(next.session_id).toBe(first.session_id);
  expect(fixture.requests).toHaveLength(2);
  expect(fixture.requests[1].messages).toEqual([
    { role: "system", content: "Give concise answers." },
    {
      role: "user",
      content:
        "The conversation history before this point was compacted into the following summary:\n\n<summary>\nExact saved summary.\n\n</summary>",
    },
    { role: "user", content: "Unfinished work" },
    expect.objectContaining({
      role: "assistant",
      reasoning_content: "Original tool reasoning.",
      tool_calls: [expect.objectContaining({ id: "unfinished" })],
    }),
    expect.objectContaining({
      role: "tool",
      tool_call_id: "unfinished",
      content: expect.stringContaining("unknown"),
    }),
    { role: "user", content: "Continue" },
  ]);
  await expect(access(join(workspace, "replayed"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await runtime.getPendingReplies(first.session_id)).toHaveLength(2);
});

it("routes a legacy history without source metadata and never invents old deliveries", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  const history = await ConversationHistory.open(join(workspace, ".history"));
  await history.createSession("helper", "legacy");
  await history.saveMessage("legacy", { role: "user", content: "Remember Alice" });
  await history.saveMessage("legacy", { role: "assistant", content: "Remembered" });
  const before = await readFile(join(workspace, ".history/sessions/legacy.jsonl"), "utf8");
  await writeFile(
    join(workspace, "config.runtime.yaml"),
    "sources:\n  platform-ws:alice:\n    session_id: legacy\n",
  );
  runtime = await EventRuntime.open({ workspace });
  await runtime.openSession({ sessionId: "legacy" });
  expect(await runtime.getPendingReplies("legacy")).toEqual([]);
  expect(await readFile(join(workspace, ".history/sessions/legacy.jsonl"), "utf8")).toBe(before);
  const next = await runtime.submit({ source: "platform-ws:alice", content: "Who?" });
  expect(next.session_id).toBe("legacy");
  expect(fixture.requests[0].messages.map((message) => message.content)).toEqual([
    "Give concise answers.",
    "Remember Alice",
    "Remembered",
    "Who?",
  ]);
  expect(await runtime.getPendingReplies("legacy")).toEqual([
    expect.objectContaining({ destination: "platform-ws:alice", payload: "Hello!" }),
  ]);
});

it("records the CLI destination for fresh explicit sessions and rejects other sources", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  runtime = await EventRuntime.open({ workspace });
  const session = await runtime.openSession();
  await expect(
    runtime.submit({
      type: "InboundEvent",
      session_id: session.session_id,
      source: "platform-ws:intruder",
      content: "Wrong destination",
      timestamp: 1,
      retry_count: 0,
    }),
  ).rejects.toThrow("source");
  expect(fixture.requests).toHaveLength(0);
  expect(
    JSON.parse((await readFile(join(workspace, ".history/index.jsonl"), "utf8")).trim()),
  ).toMatchObject({ source: "platform-cli:cli-user" });
});

it("rejects a reloaded binding to another source's session without rerouting replies", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  runtime = await EventRuntime.open({ workspace });
  const alice = await runtime.submit({ source: "platform-ws:alice", content: "Alice" });
  const bob = await runtime.submit({ source: "platform-ws:bob", content: "Bob" });
  await writeFile(
    join(workspace, "config.runtime.yaml"),
    `sources:\n  platform-ws:alice:\n    session_id: ${bob.session_id}\n  platform-ws:bob:\n    session_id: ${bob.session_id}\n`,
  );
  await expect(runtime.submit({ source: "platform-ws:alice", content: "Intrude" })).rejects.toThrow(
    "source",
  );
  expect(fixture.requests).toHaveLength(2);
  expect(await runtime.getPendingReplies(alice.session_id)).toEqual([
    expect.objectContaining({ destination: "platform-ws:alice" }),
  ]);
  expect(await runtime.getPendingReplies(bob.session_id)).toEqual([
    expect.objectContaining({ destination: "platform-ws:bob" }),
  ]);
});

it("requires a matching external binding for explicit events into legacy sessions", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  const history = await ConversationHistory.open(join(workspace, ".history"));
  await history.createSession("helper", "legacy");
  runtime = await EventRuntime.open({ workspace });
  await runtime.openSession({ sessionId: "legacy" });
  for (const source of ["platform-ws:intruder", "platform-telegram:1:10"]) {
    await expect(
      runtime.submit({
        type: "InboundEvent",
        session_id: "legacy",
        source,
        content: "Intrude",
        timestamp: 1,
        retry_count: 0,
      }),
    ).rejects.toThrow("binding");
  }
  expect(fixture.requests).toHaveLength(0);
  const cli = await runtime.submit({
    type: "InboundEvent",
    session_id: "legacy",
    source: "platform-cli:cli-user",
    content: "CLI",
    timestamp: 1,
    retry_count: 0,
  });
  expect(cli).toMatchObject({ error: null });
  await writeFile(
    join(workspace, "config.runtime.yaml"),
    "sources:\n  platform-ws:alice:\n    session_id: legacy\n",
  );
  const routed = await runtime.submit({ source: "platform-ws:alice", content: "Bind" });
  const explicit = await runtime.submit({
    type: "InboundEvent",
    session_id: "legacy",
    source: "platform-ws:alice",
    content: "Continue",
    timestamp: 1,
    retry_count: 0,
  });
  expect([routed, explicit]).toEqual([
    expect.objectContaining({ session_id: "legacy", error: null }),
    expect.objectContaining({ session_id: "legacy", error: null }),
  ]);
});
