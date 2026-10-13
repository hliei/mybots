import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ConversationHistory } from "../src/core/history.ts";
import type { RuntimeEvent } from "../src/core/runtime.ts";
import { EventRuntime } from "../src/core/runtime.ts";
import { chatFixture, toolReply } from "./chat-fixture.ts";

let fixture: Awaited<ReturnType<typeof chatFixture>> | undefined;
let runtime: EventRuntime | undefined;
afterEach(async () => {
  await runtime?.close(0);
  runtime = undefined;
  await fixture?.close();
  fixture = undefined;
});

it("allows another source to finish while one source is waiting for its model", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  runtime = new EventRuntime({ workspace });
  const blocked = Promise.withResolvers<unknown>();
  fixture.responses.push({ status: 200, body: blocked.promise });
  const first = runtime.submit("platform-ws:alice", "Alice's private message");
  try {
    await expect.poll(() => fixture?.requests.length).toBe(1);
    const second = await runtime.submit("platform-ws:bob", "Bob's private message");
    expect(second.error).toBeNull();
    expect(fixture.requests[1].messages.map((message) => message.content)).toEqual([
      "Give concise answers.",
      "Bob's private message",
    ]);
  } finally {
    blocked.resolve({ choices: [{ message: { role: "assistant", content: "Alice reply" } }] });
    await first;
  }
  const history = await ConversationHistory.open(join(workspace, ".history"));
  expect((await history.listSessions()).map((session) => session.message_count)).toEqual([2, 2]);
});

it("retains every source's history metadata when their turns overlap", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  runtime = new EventRuntime({ workspace });
  const results = await Promise.all([
    runtime.submit("platform-ws:alice", "Alice"),
    runtime.submit("platform-ws:bob", "Bob"),
    runtime.submit("platform-ws:carol", "Carol"),
  ]);
  expect(results.map((result) => result.error)).toEqual([null, null, null]);
  const history = await ConversationHistory.open(join(workspace, ".history"));
  expect(
    (await history.listSessions()).map((session) => [session.title, session.message_count]).sort(),
  ).toEqual([
    ["Alice", 2],
    ["Bob", 2],
    ["Carol", 2],
  ]);
});

it("clears source affinity before queued chat while preserving old history and Agent selection", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  runtime = new EventRuntime({ workspace, agent: "helper" });
  const [before, clear, after] = await Promise.all([
    runtime.submit("platform-cli:cli-user", "Old conversation"),
    runtime.submit("platform-cli:cli-user", "/CLEAR"),
    runtime.submit("platform-cli:cli-user", "Fresh conversation"),
  ]);
  expect(clear.content).toBe("Conversation cleared. Next message starts fresh.");
  expect(clear.session_id).toBe(before.session_id);
  expect(after.session_id).not.toBe(before.session_id);
  expect(after.source).toBe("agent:helper");
  expect(fixture.requests[1].messages).toEqual([
    { role: "system", content: "Give concise answers." },
    { role: "user", content: "Fresh conversation" },
  ]);
  const history = await ConversationHistory.open(join(workspace, ".history"));
  expect((await history.listSessions()).map((session) => session.title).sort()).toEqual([
    "Fresh conversation",
    "Old conversation",
  ]);
  expect((await history.getMessages(before.session_id)).map((message) => message.content)).toEqual([
    "Old conversation",
    "Hello!",
  ]);
});

it("executes overlapping messages and inspections in source arrival order", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  runtime = new EventRuntime({ workspace });
  const events: RuntimeEvent[] = [];
  runtime.subscribe((event) => events.push(event));
  const [first, inspection, second] = await Promise.all([
    runtime.submit("platform-cli:cli-user", "Remember Alice"),
    runtime.submit("platform-cli:cli-user", "/SESSION"),
    runtime.submit("platform-cli:cli-user", "Who?"),
  ]);
  expect(inspection.content).toContain("**Messages:** 2");
  expect(second.error).toBeNull();
  expect(second.session_id).toBe(first.session_id);
  expect(fixture.requests[1].messages.map((message) => message.content)).toEqual([
    "Give concise answers.",
    "Remember Alice",
    "Hello!",
    "Who?",
  ]);
  expect(events.map((event) => event.type)).toEqual([
    "InboundEvent",
    "OutboundEvent",
    "InboundEvent",
    "OutboundEvent",
    "InboundEvent",
    "OutboundEvent",
  ]);
  expect(events[0]).toEqual({
    type: "InboundEvent",
    source: "platform-cli:cli-user",
    session_id: first.session_id,
    content: "Remember Alice",
    timestamp: expect.any(Number),
    retry_count: 0,
  });
  expect(first).toEqual({
    type: "OutboundEvent",
    source: "agent:helper",
    session_id: first.session_id,
    content: "Hello!",
    timestamp: expect.any(Number),
    error: null,
  });
  const history = await ConversationHistory.open(join(workspace, ".history"));
  expect((await history.getMessages(first.session_id)).map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "user",
    "assistant",
  ]);
});

it("reports execution failure once and retains complete tool groups with original reasoning", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  runtime = new EventRuntime({ workspace });
  fixture.responses.push(
    {
      status: 200,
      body: toolReply(
        [
          {
            name: "write",
            id: "save-note",
            args: { path: join(workspace, "note.txt"), content: "Saved" },
          },
        ],
        "Original tool reasoning.",
      ),
    },
    { status: 503, body: { error: { message: "Unavailable" } } },
  );
  const events: RuntimeEvent[] = [];
  runtime.subscribe((event) => events.push(event));
  const failure = await runtime.submit("platform-cli:cli-user", "Save a note");
  expect(failure).toMatchObject({
    error: "DeepSeek request failed (HTTP 503).",
    content: "Error: DeepSeek request failed (HTTP 503).",
  });
  const next = await runtime.submit("platform-cli:cli-user", "/unknown follow-up");
  expect(next.error).toBeNull();
  expect(fixture.requests).toHaveLength(3);
  expect(fixture.requests[2].messages).toEqual([
    { role: "system", content: "Give concise answers." },
    { role: "user", content: "Save a note" },
    {
      role: "assistant",
      content: "",
      reasoning_content: "Original tool reasoning.",
      tool_calls: [
        {
          id: "save-note",
          type: "function",
          function: {
            name: "write",
            arguments: JSON.stringify({ path: join(workspace, "note.txt"), content: "Saved" }),
          },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "save-note",
      content: `Successfully wrote to: ${join(workspace, "note.txt")}`,
    },
    { role: "user", content: "/unknown follow-up" },
  ]);
  expect(events.filter((event) => event.type === "OutboundEvent")).toEqual([failure, next]);
  const history = await ConversationHistory.open(join(workspace, ".history"));
  expect((await history.getMessages(next.session_id))[1]).toMatchObject({
    reasoning_content: "Original tool reasoning.",
    tool_calls: [{ id: "save-note" }],
  });
});

it("cancels overdue execution on shutdown, rejects queued work and awaits model cleanup", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  runtime = new EventRuntime({ workspace });
  const blocked = Promise.withResolvers<unknown>();
  fixture.responses.push({ status: 200, body: blocked.promise });
  const running = runtime.submit("platform-cli:cli-user", "Waiting");
  await expect.poll(() => fixture?.requests.length).toBe(1);
  const queued = runtime.submit("platform-cli:cli-user", "Must not run");
  const rejected = expect(queued).rejects.toThrow("Runtime closed before execution.");
  try {
    await runtime.close(0);
    await rejected;
    expect(await running).toMatchObject({ error: "DeepSeek request cancelled." });
    expect(fixture.requests).toHaveLength(1);
    await expect(runtime.submit("platform-ws:other", "Too late")).rejects.toThrow(
      "Runtime is closed.",
    );
    await runtime.close(0);
  } finally {
    blocked.resolve({});
  }
});

it("lets a running turn finish within the shutdown grace period", async () => {
  fixture = await chatFixture();
  runtime = new EventRuntime({ workspace: await fixture.workspace() });
  const blocked = Promise.withResolvers<unknown>();
  fixture.responses.push({ status: 200, body: blocked.promise });
  const running = runtime.submit("platform-cli:cli-user", "Finish");
  await expect.poll(() => fixture?.requests.length).toBe(1);
  const closing = runtime.close(1000);
  blocked.resolve({ choices: [{ message: { role: "assistant", content: "Finished" } }] });
  await closing;
  expect(await running).toMatchObject({ content: "Finished", error: null });
});

it("inspects a fresh source without model requests or chat history writes", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  await fixture.writeSkill(
    "brief",
    "---\nname: Brief\ndescription: Keep replies brief\n---\nUse one sentence.",
  );
  runtime = new EventRuntime({ workspace });
  const session = await runtime.openSource("platform-cli:cli-user");
  const history = await ConversationHistory.open(join(workspace, ".history"));
  const indexBefore = await readFile(join(workspace, ".history", "index.jsonl"), "utf8");
  for (const command of [
    "/HELP",
    "/?",
    "/session",
    "/skills",
    "/skills brief",
    "/context",
    "/compact",
  ]) {
    const reply = await runtime.submit("platform-cli:cli-user", command);
    expect(reply.error).toBeNull();
    expect(reply.session_id).toBe(session.sessionId);
    expect(reply.content).not.toBe("");
  }
  expect(fixture.requests).toHaveLength(0);
  expect(await history.getMessages(session.sessionId)).toEqual([]);
  expect(await readFile(join(workspace, ".history", "index.jsonl"), "utf8")).toBe(indexBefore);
});

it("awaits shell termination and records the complete cancelled tool group on close", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  runtime = new EventRuntime({ workspace });
  const marker = join(workspace, "shell-pid");
  const quoted = `'${marker.replaceAll("'", "'\\''")}'`;
  fixture.responses.push({
    status: 200,
    body: toolReply([
      {
        name: "bash",
        id: "cancel-shell",
        args: { command: `trap '' TERM; echo $$ > ${quoted}; sleep 600` },
      },
    ]),
  });
  const running = runtime.submit("platform-cli:cli-user", "Run until cancelled");
  let pid = 0;
  try {
    await expect
      .poll(async () => {
        try {
          pid = Number((await readFile(marker, "utf8")).trim());
          return pid;
        } catch {
          return 0;
        }
      })
      .toBeGreaterThan(0);
    await runtime.close(0);
    const reply = await running;
    expect(reply.error).toBe("DeepSeek request cancelled.");
    expect(() => process.kill(pid, 0)).toThrow();
    const history = await ConversationHistory.open(join(workspace, ".history"));
    expect((await history.getMessages(reply.session_id)).map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
    expect((await history.getMessages(reply.session_id))[2]).toMatchObject({
      tool_call_id: "cancel-shell",
      content: "Error executing command: cancelled.",
    });
  } finally {
    await runtime.close(0);
  }
});
