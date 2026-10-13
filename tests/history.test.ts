import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { Agent } from "../src/core/agent.ts";
import { ConversationHistory } from "../src/core/history.ts";
import { chatFixture, toolReply, unavailableResponses } from "./chat-fixture.ts";

let fixture: Awaited<ReturnType<typeof chatFixture>> | undefined;
afterEach(async () => {
  const current = fixture;
  fixture = undefined;
  await current?.close();
});

const contractFixtures = fileURLToPath(new URL("./fixtures/contracts", import.meta.url));

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mybots-history-"));
}

function fixedClock(times: Date[]): () => Date {
  let next = 0;
  return () => times[next++];
}

it("saves a completed turn that a new reader instance can read", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  const agent = await Agent.open({ workspace });
  await agent.chat("Remember Alice");

  const history = await ConversationHistory.open(join(workspace, ".history"));
  expect(await history.listSessions()).toEqual([
    {
      id: agent.sessionId,
      agent_id: "helper",
      title: "Remember Alice",
      message_count: 2,
      created_at: expect.any(String),
      updated_at: expect.any(String),
    },
  ]);
  expect(await history.getMessages(agent.sessionId)).toEqual([
    {
      timestamp: expect.any(String),
      role: "user",
      content: "Remember Alice",
      tool_calls: null,
      tool_call_id: null,
    },
    {
      timestamp: expect.any(String),
      role: "assistant",
      content: "Hello!",
      reasoning_content: "Full reasoning.",
      tool_calls: null,
      tool_call_id: null,
    },
  ]);
});

it("records tool-call rounds and results in order with reasoning", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  const note = join(workspace, "note.txt");
  fixture.responses.push(
    {
      status: 200,
      body: toolReply(
        [{ name: "write", id: "call-1", args: { path: note, content: "Artifact" } }],
        "Plan the write.",
      ),
    },
    {
      status: 200,
      body: {
        choices: [
          {
            message: {
              role: "assistant",
              content: "Done.",
              reasoning_content: "Confirm the write.",
            },
          },
        ],
      },
    },
  );
  const agent = await Agent.open({ workspace });
  expect(await agent.chat("Save a note")).toBe("Done.");

  const history = await ConversationHistory.open(join(workspace, ".history"));
  expect(await history.getMessages(agent.sessionId)).toEqual([
    {
      timestamp: expect.any(String),
      role: "user",
      content: "Save a note",
      tool_calls: null,
      tool_call_id: null,
    },
    {
      timestamp: expect.any(String),
      role: "assistant",
      content: "",
      reasoning_content: "Plan the write.",
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: {
            name: "write",
            arguments: JSON.stringify({ path: note, content: "Artifact" }),
          },
        },
      ],
      tool_call_id: null,
    },
    {
      timestamp: expect.any(String),
      role: "tool",
      content: `Successfully wrote to: ${note}`,
      tool_calls: null,
      tool_call_id: "call-1",
    },
    {
      timestamp: expect.any(String),
      role: "assistant",
      content: "Done.",
      reasoning_content: "Confirm the write.",
      tool_calls: null,
      tool_call_id: null,
    },
  ]);
  expect((await history.getSession(agent.sessionId))?.message_count).toBe(4);
});

it("writes JSONL records with a controlled clock", async () => {
  const root = await temporaryDirectory();
  try {
    const history = await ConversationHistory.open(root, {
      now: fixedClock([
        new Date(2026, 9, 1, 9, 15, 0, 0),
        new Date(2026, 9, 1, 9, 15, 1, 0),
        new Date(2026, 9, 1, 9, 15, 2, 0),
        new Date(2026, 9, 1, 9, 15, 3, 0),
        new Date(2026, 9, 1, 9, 15, 4, 0),
      ]),
    });
    await history.createSession("helper", "session");
    await history.saveMessage("session", { role: "user", content: "Read the README" });
    await history.saveMessage("session", {
      role: "assistant",
      content: "",
      reasoning_content: "Check the file.",
      tool_calls: [
        {
          id: "read-call-1",
          type: "function",
          function: { name: "read", arguments: '{"path": "README.md"}' },
        },
      ],
    });

    const records = (await readFile(join(root, "sessions", "session.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records[0]).toEqual({
      type: "session",
      id: "session",
      agent_id: "helper",
      created_at: "2026-10-01T09:15:00.000000",
    });
    expect(
      records
        .slice(1)
        .map(({ id: _id, ...message }) => `${JSON.stringify(message)}\n`)
        .join(""),
    ).toBe(
      '{"timestamp":"2026-10-01T09:15:01.000000","role":"user","content":"Read the README","tool_calls":null,"tool_call_id":null}\n' +
        '{"timestamp":"2026-10-01T09:15:03.000000","role":"assistant","content":"","tool_calls":[{"id":"read-call-1","type":"function","function":{"name":"read","arguments":"{\\"path\\": \\"README.md\\"}"}}],"tool_call_id":null,"reasoning_content":"Check the file."}\n',
    );
    expect(await readFile(join(root, "index.jsonl"), "utf8")).toBe(
      '{"id":"session","agent_id":"helper","title":"Read the README","message_count":2,"created_at":"2026-10-01T09:15:00.000000","updated_at":"2026-10-01T09:15:04.000000"}\n',
    );

    const fixtureHistory = await ConversationHistory.open(contractFixtures);
    const [fixtureAssistant] = (await fixtureHistory.getMessages("tool-session")).slice(1, 2);
    expect((await history.getMessages("session"))[1].tool_calls).toEqual(
      fixtureAssistant.tool_calls,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("derives index metadata from the recorded conversation", async () => {
  const root = await temporaryDirectory();
  try {
    const history = await ConversationHistory.open(root, {
      now: fixedClock([
        new Date(2026, 9, 1, 9, 15, 0, 0),
        new Date(2026, 9, 1, 9, 15, 1, 0),
        new Date(2026, 9, 1, 9, 15, 2, 0),
        new Date(2026, 9, 1, 9, 15, 3, 0),
        new Date(2026, 9, 1, 9, 15, 4, 0),
        new Date(2026, 9, 1, 9, 15, 5, 0),
        new Date(2026, 9, 1, 9, 15, 6, 0),
        new Date(2026, 9, 1, 9, 15, 7, 0),
        new Date(2026, 9, 1, 9, 15, 8, 0),
        new Date(2026, 9, 1, 9, 15, 9, 0),
      ]),
    });
    await history.createSession("helper", "first");
    await history.saveMessage("first", {
      role: "user",
      content: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    });
    await history.saveMessage("first", { role: "assistant", content: "ok" });
    await history.saveMessage("first", { role: "user", content: "Second question" });
    await history.createSession("helper", "second");

    expect(await history.getSession("first")).toEqual({
      id: "first",
      agent_id: "helper",
      title: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWX...",
      message_count: 3,
      created_at: "2026-10-01T09:15:00.000000",
      updated_at: "2026-10-01T09:15:06.000000",
    });
    expect((await history.listSessions()).map((session) => session.id)).toEqual([
      "second",
      "first",
    ]);
    await expect(
      history.saveMessage("missing", { role: "user", content: "Hello" }),
    ).rejects.toThrow("Session not found: missing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("reads literal JSONL records without fabricating reasoning", async () => {
  const history = await ConversationHistory.open(contractFixtures);
  expect(await history.listSessions()).toEqual([
    {
      id: "tool-session",
      agent_id: "helper",
      title: "Read the README",
      message_count: 4,
      created_at: "2026-10-01T09:15:00.123456",
      updated_at: "2026-10-01T09:16:10.000000",
    },
    {
      id: "legacy-session",
      agent_id: "helper",
      title: null,
      message_count: 1,
      created_at: "2026-09-30T08:00:00",
      updated_at: "2026-09-30T08:00:00",
    },
  ]);
  expect(await history.getMessages("tool-session")).toEqual([
    {
      timestamp: "2026-10-01T09:15:00.123456",
      role: "user",
      content: "Read the README",
      tool_calls: null,
      tool_call_id: null,
    },
    {
      timestamp: "2026-10-01T09:15:05.000000",
      role: "assistant",
      content: "",
      writer_extension: { streamed: false },
      tool_calls: [
        {
          id: "read-call-1",
          type: "function",
          function: { name: "read", arguments: '{"path": "README.md"}' },
        },
      ],
      tool_call_id: null,
    },
    {
      timestamp: "2026-10-01T09:15:06.000000",
      role: "tool",
      content: "# Mybots",
      tool_calls: null,
      tool_call_id: "read-call-1",
    },
    {
      timestamp: "2026-10-01T09:16:10.000000",
      role: "assistant",
      content: "The README describes Mybots.",
      tool_calls: null,
      tool_call_id: null,
    },
  ]);
  expect(await history.getMessages("legacy-session")).toEqual([
    {
      timestamp: "2026-09-30T08:00:00",
      role: "user",
      content: "Hello",
      tool_calls: null,
      tool_call_id: null,
    },
  ]);
});

it("skips unreadable records instead of failing the conversation", async () => {
  const root = await temporaryDirectory();
  try {
    await mkdir(join(root, "sessions"), { recursive: true });
    await writeFile(
      join(root, "index.jsonl"),
      'not json\n{"id":"s","agent_id":"helper","message_count":1,"created_at":"t","updated_at":"t"}\n',
    );
    await writeFile(
      join(root, "sessions", "s.jsonl"),
      'not json\n{"timestamp":"t","role":"wizard","content":"?"}\n{"timestamp":"t","role":"user","content":"Hi"}\n{"timestamp":"t","role":"assistant","content":null,"tool_calls":null,"tool_call_id":null}\n',
    );
    const history = await ConversationHistory.open(root);
    expect(await history.listSessions()).toEqual([
      {
        id: "s",
        agent_id: "helper",
        title: null,
        message_count: 1,
        created_at: "t",
        updated_at: "t",
      },
    ]);
    expect(await history.getMessages("s")).toEqual([
      { timestamp: "t", role: "user", content: "Hi", tool_calls: null, tool_call_id: null },
      { timestamp: "t", role: "assistant", content: "", tool_calls: null, tool_call_id: null },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps unknown index fields from another writer when recording a message", async () => {
  const root = await temporaryDirectory();
  try {
    const fixtures = join(root, "contracts");
    await cp(contractFixtures, fixtures, { recursive: true });
    const history = await ConversationHistory.open(fixtures, {
      now: fixedClock([new Date(2026, 9, 1, 10, 0, 0, 0), new Date(2026, 9, 1, 10, 0, 1, 0)]),
    });
    await history.saveMessage("tool-session", { role: "user", content: "More" });

    const [updated] = (await readFile(join(fixtures, "index.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(updated).toMatchObject({
      id: "tool-session",
      message_count: 5,
      updated_at: "2026-10-01T10:00:01.000000",
      writer_extension: { source: "external-writer" },
    });
    expect(await history.getMessages("tool-session")).toHaveLength(5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("records user input even when the first model request fails", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  fixture.responses.push(...unavailableResponses());
  const agent = await Agent.open({ workspace });
  await expect(agent.chat("Keep this failed turn")).rejects.toThrow("HTTP 503");
  expect(fixture.requests).toHaveLength(3);
  const reader = await ConversationHistory.open(join(workspace, ".history"));
  expect(await reader.getMessages(agent.sessionId)).toEqual([
    expect.objectContaining({ role: "user", content: "Keep this failed turn" }),
  ]);
  expect(await reader.getSession(agent.sessionId)).toMatchObject({
    title: "Keep this failed turn",
    message_count: 1,
  });
});

it("counts Unicode code points when deriving the session title", async () => {
  const root = await temporaryDirectory();
  try {
    const history = await ConversationHistory.open(root);
    for (const [id, content, title] of [
      ["short", "😀".repeat(26), "😀".repeat(26)],
      ["long", `${"a".repeat(49)}😀x`, `${"a".repeat(49)}😀...`],
    ]) {
      await history.createSession("helper", id);
      await history.saveMessage(id, { role: "user", content });
      expect((await history.getSession(id))?.title).toBe(title);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("persists Skill loading and continuation from the .agents workspace layout", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace(fixture.root, "", "allow_skills: true\n");
  await fixture.writeSkill(
    "summary",
    "---\nname: Summary\ndescription: Summarize text\n---\nKeep it brief.",
  );
  fixture.responses.push({
    status: 200,
    body: toolReply([{ name: "skill", id: "history-skill", args: { skill_name: "summary" } }]),
  });
  const agent = await Agent.open({ workspace });
  expect(await agent.chat("Summarize this")).toBe("Hello!");
  const reader = await ConversationHistory.open(join(workspace, ".history"));
  const messages = await reader.getMessages(agent.sessionId);
  expect(messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "tool",
    "assistant",
  ]);
  expect(messages[2]).toMatchObject({ tool_call_id: "history-skill", content: "Keep it brief." });
  expect(messages[1].reasoning_content).toBe("Tool reasoning.");
  expect((await reader.getSession(agent.sessionId))?.message_count).toBe(4);
});
