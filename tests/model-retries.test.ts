import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Agent } from "../src/core/agent.ts";
import { ConversationHistory } from "../src/core/history.ts";
import { chatFixture, type ModelRequest, toolReply, unavailableResponses } from "./chat-fixture.ts";

let fixture: Awaited<ReturnType<typeof chatFixture>> | undefined;
afterEach(async () => {
  const current = fixture;
  fixture = undefined;
  vi.useRealTimers();
  await current?.close();
});

it("recovers after a write without executing the completed write again", async () => {
  fixture = await chatFixture();
  const agent = await Agent.open({ workspace: await fixture.workspace() });
  const path = join(fixture.root, "written.txt");
  const failure = Promise.withResolvers<unknown>();
  const continuation = Promise.withResolvers<void>();
  let received = 0;
  fixture.server.on("request", () => {
    if (++received === 2) continuation.resolve();
  });
  fixture.responses.push(
    {
      status: 200,
      body: toolReply([{ name: "write", id: "write-once", args: { path, content: "Original" } }]),
    },
    { status: 503, body: failure.promise, headers: { "retry-after-ms": "1" } },
  );
  const running = agent.chat("Write a note");
  try {
    await continuation.promise;
    expect(await readFile(path, "utf8")).toBe("Original");
    await writeFile(path, "Changed after the completed write");
  } finally {
    failure.resolve({ error: { message: "Unavailable" } });
    await running;
  }
  expect(await readFile(path, "utf8")).toBe("Changed after the completed write");
  expect(fixture.requests).toHaveLength(3);
  expect(fixture.requests[2]).toEqual(fixture.requests[1]);
  expect(fixture.requests[2].messages.slice(-2)).toEqual([
    {
      role: "assistant",
      content: "",
      reasoning_content: "Tool reasoning.",
      tool_calls: [
        {
          id: "write-once",
          type: "function",
          function: { name: "write", arguments: JSON.stringify({ path, content: "Original" }) },
        },
      ],
    },
    { role: "tool", tool_call_id: "write-once", content: `Successfully wrote to: ${path}` },
  ]);
  const history = await ConversationHistory.open(agent.config.history_path);
  expect((await history.getMessages(agent.sessionId)).map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "tool",
    "assistant",
  ]);
});

it("exhausts two retries while retaining the saved input and completed tool results", async () => {
  fixture = await chatFixture();
  const agent = await Agent.open({ workspace: await fixture.workspace() });
  const path = join(fixture.root, "written.txt");
  fixture.responses.push({
    status: 200,
    body: toolReply([{ name: "write", id: "saved-write", args: { path, content: "Saved" } }]),
  });
  fixture.responses.push(...unavailableResponses());
  await expect(agent.chat("Write before failure")).rejects.toThrow("HTTP 503");
  expect(fixture.requests).toHaveLength(4);
  expect(fixture.requests[2]).toEqual(fixture.requests[1]);
  expect(fixture.requests[3]).toEqual(fixture.requests[1]);
  expect(await readFile(path, "utf8")).toBe("Saved");
  const history = await ConversationHistory.open(agent.config.history_path);
  expect(await history.getMessages(agent.sessionId)).toMatchObject([
    { role: "user", content: "Write before failure" },
    { role: "assistant", reasoning_content: "Tool reasoning." },
    { role: "tool", tool_call_id: "saved-write", content: `Successfully wrote to: ${path}` },
  ]);
  expect(await agent.chat("Continue")).toBe("Hello!");
  expect(fixture.requests.at(-1)?.messages.slice(1, -1)).toEqual(
    fixture.requests[1].messages.slice(1),
  );
});

it("recovers a transient model failure with the same context, tools, reasoning, and settings", async () => {
  fixture = await chatFixture();
  const agent = await Agent.open({ workspace: await fixture.workspace() });
  await agent.chat("Remember Alice");
  fixture.responses.push({ status: 503, body: { error: { message: "Unavailable" } } });
  expect(await agent.chat("Who did I mention?")).toBe("Hello!");
  expect(fixture.requests).toHaveLength(3);
  expect(fixture.requests[2]).toEqual(fixture.requests[1]);
  expect(fixture.requests[2].messages).toEqual([
    { role: "system", content: "Give concise answers." },
    { role: "user", content: "Remember Alice" },
    { role: "assistant", content: "Hello!", reasoning_content: "Full reasoning." },
    { role: "user", content: "Who did I mention?" },
  ]);
});

it.each([408, 409, 429, 500, 503])("recovers SDK-retryable HTTP %s responses", async (status) => {
  fixture = await chatFixture();
  const agent = await Agent.open({ workspace: await fixture.workspace() });
  fixture.responses.push({
    status,
    body: { error: { message: "Transient failure" } },
    headers: { "retry-after-ms": "1" },
  });
  expect(await agent.chat("Recover")).toBe("Hello!");
  expect(fixture.requests).toHaveLength(2);
  expect(fixture.requests[1]).toEqual(fixture.requests[0]);
});

it.each([400, 401, 403, 404, 422])(
  "ends a turn on permanent HTTP %s without retrying",
  async (status) => {
    fixture = await chatFixture();
    const agent = await Agent.open({ workspace: await fixture.workspace() });
    fixture.responses.push({ status, body: { error: { message: "Permanent failure" } } });
    await expect(agent.chat("Fail")).rejects.toThrow(`HTTP ${status}`);
    expect(fixture.requests).toHaveLength(1);
    const history = await ConversationHistory.open(agent.config.history_path);
    expect(await history.getMessages(agent.sessionId)).toMatchObject([
      { role: "user", content: "Fail" },
    ]);
  },
);

it.each([
  [400, "true", true],
  [503, "false", false],
])("honors server retry overrides for HTTP %s", async (status, hint, recovers) => {
  fixture = await chatFixture();
  const agent = await Agent.open({ workspace: await fixture.workspace() });
  fixture.responses.push({
    status,
    body: { error: { message: "Server-directed retry policy" } },
    headers: { "x-should-retry": hint, "retry-after-ms": "1" },
  });
  if (recovers) {
    expect(await agent.chat("Follow retry hint")).toBe("Hello!");
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.requests[1]).toEqual(fixture.requests[0]);
  } else {
    await expect(agent.chat("Follow retry hint")).rejects.toThrow(`HTTP ${status}`);
    expect(fixture.requests).toHaveLength(1);
  }
});

it("recovers a connection failure through the SDK without restarting the turn", async () => {
  fixture = await chatFixture();
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValueOnce(new TypeError("Connection reset"));
  const agent = await Agent.open({ workspace: await fixture.workspace() });
  expect(await agent.chat("Recover the connection")).toBe("Hello!");
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[1][1]?.body).toBe(fetch.mock.calls[0][1]?.body);
  const history = await ConversationHistory.open(agent.config.history_path);
  expect((await history.getMessages(agent.sessionId)).map((message) => message.role)).toEqual([
    "user",
    "assistant",
  ]);
});

it("gives each retry its own 60-second timeout", async () => {
  fixture = await chatFixture();
  const started = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
  const requests: ModelRequest[] = [];
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const attempt = requests.length;
    requests.push(JSON.parse(init?.body as string));
    started[attempt].resolve();
    if (attempt === 2) {
      return Response.json({ choices: [{ message: { role: "assistant", content: "Recovered" } }] });
    }
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("Timed out", "AbortError")),
        { once: true },
      );
    });
  });
  const agent = await Agent.open({ workspace: await fixture.workspace() });
  const running = agent.chat("Wait for recovery");
  await started[0].promise;
  await vi.advanceTimersByTimeAsync(59_999);
  expect(requests).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(501);
  await started[1].promise;
  await vi.advanceTimersByTimeAsync(59_999);
  expect(requests).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1_001);
  await started[2].promise;
  expect(await running).toBe("Recovered");
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[2]).toEqual(requests[0]);
});

it("cancels an active model request without starting a retry", async () => {
  fixture = await chatFixture();
  const agent = await Agent.open({ workspace: await fixture.workspace() });
  const response = Promise.withResolvers<unknown>();
  fixture.responses.push({ status: 200, body: response.promise });
  const controller = new AbortController();
  const running = agent.chat("Cancel active request", controller.signal);
  const cancelled = expect(running).rejects.toThrow("DeepSeek request cancelled");
  try {
    await vi.waitFor(() => expect(fixture?.requests).toHaveLength(1));
    controller.abort();
    await cancelled;
    expect(fixture.requests).toHaveLength(1);
  } finally {
    controller.abort();
    response.resolve({ choices: [] });
    await cancelled;
  }
});

it("cancels the server-directed backoff wait without another attempt", async () => {
  fixture = await chatFixture();
  const agent = await Agent.open({ workspace: await fixture.workspace() });
  fixture.responses.push({
    status: 429,
    body: { error: { message: "Wait before retrying" } },
    headers: { "Retry-After": "30" },
  });
  const waiting = Promise.withResolvers<void>();
  const schedule = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
    const timer = schedule(callback, delay, ...args);
    if (delay === 30_000) waiting.resolve();
    return timer;
  });
  const controller = new AbortController();
  const running = agent.chat("Cancel retry wait", controller.signal);
  const cancelled = expect(running).rejects.toThrow("DeepSeek request cancelled");
  try {
    await waiting.promise;
    controller.abort();
    await cancelled;
    expect(fixture.requests).toHaveLength(1);
    expect(await agent.chat("Continue after cancellation")).toBe("Hello!");
    expect(fixture.requests[1].messages.at(-1)?.content).toBe("Continue after cancellation");
  } finally {
    controller.abort();
    await cancelled;
  }
});

it("rejects an invalid successful response without retrying it", async () => {
  fixture = await chatFixture();
  const agent = await Agent.open({ workspace: await fixture.workspace() });
  fixture.responses.push({ status: 200, body: { choices: [] } });
  await expect(agent.chat("Invalid response")).rejects.toThrow("DeepSeek returned no text reply");
  expect(fixture.requests).toHaveLength(1);
});

it("recovers a compaction request with the same transcript and no tools", async () => {
  fixture = await chatFixture();
  const agent = await Agent.open({ workspace: await fixture.workspace() });
  await agent.chat(`Older ${"o".repeat(90000)}`);
  await agent.chat(`Recent ${"r".repeat(90000)}`);
  fixture.responses.push(
    {
      status: 503,
      body: { error: { message: "Unavailable" } },
      headers: { "retry-after-ms": "1" },
    },
    {
      status: 200,
      body: {
        choices: [
          { finish_reason: "stop", message: { role: "assistant", content: "Saved objective." } },
        ],
      },
    },
  );
  expect(await agent.runCommand("/compact")).toContain("Compacted");
  expect(fixture.requests).toHaveLength(4);
  expect(fixture.requests[3]).toEqual(fixture.requests[2]);
  expect(fixture.requests[3].tools).toBeUndefined();
  expect(fixture.requests[3].messages[1].content).toContain("Older");
  await agent.chat("Continue");
  expect(fixture.requests[4].messages[1].content).toContain("Saved objective.");
  expect(fixture.requests[4].messages[2].content).toContain("Recent");
  expect(fixture.requests[4].messages[3].reasoning_content).toBe("Full reasoning.");
});

it.each(["retry exhaustion", "unusable summary"])(
  "preserves a committed summary and usage after compaction %s",
  async (failure) => {
    fixture = await chatFixture();
    const agent = await Agent.open({ workspace: await fixture.workspace() });
    await agent.chat(`Older ${"o".repeat(90000)}`);
    await agent.chat(`Recent ${"r".repeat(90000)}`);
    fixture.responses.push({
      status: 200,
      body: {
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: "Committed objective." },
          },
        ],
      },
    });
    expect(await agent.runCommand("/compact")).toContain("Compacted");
    fixture.responses.push({
      status: 200,
      body: {
        choices: [
          {
            message: {
              role: "assistant",
              content: "Latest answer",
              reasoning_content: "Latest reasoning.",
            },
          },
        ],
        usage: { prompt_tokens: 69000, completion_tokens: 1000, total_tokens: 70000 },
      },
    });
    await agent.chat(`Latest ${"l".repeat(90000)}`);
    const before = await agent.runCommand("/context");
    expect(before).toContain("**Estimated tokens:** 70000");
    const log = join(agent.config.history_path, "sessions", `${agent.sessionId}.jsonl`);
    const saved = await readFile(log, "utf8");
    if (failure === "retry exhaustion") {
      fixture.responses.push(...unavailableResponses());
    } else {
      fixture.responses.push({
        status: 200,
        body: {
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: " " } }],
        },
      });
    }
    expect(await agent.runCommand("/compact")).toContain(
      failure === "retry exhaustion" ? "Compaction failed" : "Unusable summary",
    );
    expect(fixture.requests).toHaveLength(failure === "retry exhaustion" ? 7 : 5);
    expect(await agent.runCommand("/context")).toBe(before);
    expect(await readFile(log, "utf8")).toBe(saved);
    await agent.chat("Continue");
    expect(fixture.requests.at(-1)?.messages[1].content).toContain("Committed objective.");
    expect(fixture.requests.at(-1)?.messages[2].content).toContain("Recent");
    expect(fixture.requests.at(-1)?.messages.at(-2)?.reasoning_content).toBe("Latest reasoning.");
  },
);
