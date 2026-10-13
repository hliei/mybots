import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "../src/core/events.ts";
import { EventRuntime } from "../src/core/runtime.ts";
import { chatFixture, toolReply, unavailableResponses } from "./chat-fixture.ts";

let fixture: Awaited<ReturnType<typeof chatFixture>> | undefined;
let runtime: EventRuntime | undefined;
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await runtime?.stop();
  runtime = undefined;
  await fixture?.close();
  fixture = undefined;
});

it("runs another session while execution and a subscriber wait on the first session", async () => {
  fixture = await chatFixture();
  runtime = await EventRuntime.open({ workspace: await fixture.workspace() });
  const firstSession = await runtime.openSession();
  const otherSession = await runtime.openSession();
  const requestStarted = Promise.withResolvers<void>();
  const heldReply = Promise.withResolvers<unknown>();
  const subscriberStarted = Promise.withResolvers<void>();
  const heldSubscriber = Promise.withResolvers<void>();
  const observedOtherReply = Promise.withResolvers<void>();
  fixture.server.once("request", () => requestStarted.resolve());
  fixture.responses.push({ status: 200, body: heldReply.promise });
  runtime.subscribe(async (event) => {
    if (event.session_id === firstSession.session_id) {
      subscriberStarted.resolve();
      await heldSubscriber.promise;
    } else if (event.type === "OutboundEvent") {
      observedOtherReply.resolve();
    }
  });
  const first = runtime.submit(input(firstSession.session_id, "Hold"));
  try {
    await Promise.all([requestStarted.promise, subscriberStarted.promise]);
    expect(await runtime.submit(input(otherSession.session_id, "Independent"))).toMatchObject({
      content: "Hello!",
    });
    await observedOtherReply.promise;
    expect(fixture.requests[1].messages).toEqual([
      { role: "system", content: "Give concise answers." },
      { role: "user", content: "Independent" },
    ]);
  } finally {
    heldReply.resolve(answer("First answer"));
    heldSubscriber.resolve();
    await first;
  }
});

it("records subscriber failure without preventing another observer or follow-up", async () => {
  fixture = await chatFixture();
  runtime = await EventRuntime.open({ workspace: await fixture.workspace() });
  const { session_id } = await runtime.openSession();
  const observed: RuntimeEvent[] = [];
  runtime.subscribe(async () => {
    throw new Error("Sink unavailable");
  });
  runtime.subscribe(async (event) => {
    observed.push(event);
  });
  await runtime.submit(input(session_id, "First"));
  await runtime.submit(input(session_id, "Second"));
  await runtime.stop();
  expect(observed.filter((event) => event.type === "OutboundEvent")).toHaveLength(2);
  expect(runtime.subscriberFailures).toHaveLength(4);
  expect(runtime.subscriberFailures[0]).toMatchObject({ error: new Error("Sink unavailable") });
  expect(await runtime.getPendingReplies(session_id)).toHaveLength(2);
});

it("stops new input immediately while draining accepted turns", async () => {
  fixture = await chatFixture();
  runtime = await EventRuntime.open({ workspace: await fixture.workspace() });
  const { session_id } = await runtime.openSession();
  const started = Promise.withResolvers<void>();
  const held = Promise.withResolvers<unknown>();
  fixture.server.once("request", () => started.resolve());
  fixture.responses.push({ status: 200, body: held.promise });
  const first = runtime.submit(input(session_id, "Accepted"));
  await started.promise;
  const stopped = runtime.stop();
  const late = runtime.submit(input(session_id, "Too late"));
  const rejected = expect(late).rejects.toThrow("stopping");
  held.resolve(answer("Accepted answer"));
  await Promise.all([first, stopped, rejected]);
  expect(fixture.requests).toHaveLength(1);
});

it("cancels active work and drops waiting input when the grace period expires", async () => {
  fixture = await chatFixture();
  runtime = await EventRuntime.open({ workspace: await fixture.workspace() });
  const { session_id } = await runtime.openSession();
  const started = Promise.withResolvers<void>();
  const held = Promise.withResolvers<unknown>();
  const requestClosed = Promise.withResolvers<void>();
  fixture.server.once("request", (_request, response) => {
    response.once("close", () => requestClosed.resolve());
    started.resolve();
  });
  fixture.responses.push({ status: 200, body: held.promise });
  const first = runtime.submit(input(session_id, "Active"));
  await started.promise;
  const second = runtime.submit(input(session_id, "Waiting"));
  const stopped = runtime.stop({ graceMs: 0 });
  // A late service reply must not turn the cancelled work into successful output.
  held.resolve(answer("Late reply"));
  await stopped;
  expect(await Promise.all([first, second])).toEqual([
    { type: "CancelledTurn", session_id, content: "" },
    { type: "CancelledTurn", session_id, content: "" },
  ]);
  await requestClosed.promise;
  expect(fixture.requests).toHaveLength(1);
  expect(await runtime.getPendingReplies(session_id)).toEqual([]);
});

it("observes the unchanged inbound event and only exposes a reply after its durable commit", async () => {
  fixture = await chatFixture();
  runtime = await EventRuntime.open({ workspace: await fixture.workspace() });
  const { session_id } = await runtime.openSession();
  const events: RuntimeEvent[] = [];
  const pendingAtObservation: unknown[] = [];
  const currentRuntime = runtime;
  runtime.subscribe(async (event) => {
    events.push(event);
    if (event.type === "OutboundEvent") {
      pendingAtObservation.push(...(await currentRuntime.getPendingReplies(session_id)));
    }
  });
  const inbound = input(session_id, "Hello");
  await runtime.submit(inbound);
  await runtime.stop();
  expect(events).toEqual([
    inbound,
    {
      type: "OutboundEvent",
      session_id,
      source: "agent:helper",
      content: "Hello!",
      timestamp: expect.any(Number),
      error: null,
      reply_id: expect.any(String),
    },
  ]);
  expect(events[1].timestamp).toBeGreaterThan(1_700_000_000);
  expect(events[1].timestamp).toBeLessThan(10_000_000_000);
  expect(pendingAtObservation).toEqual([
    expect.objectContaining({
      replyId: events[1].type === "OutboundEvent" ? events[1].reply_id : undefined,
      payload: "Hello!",
      destination: "platform-cli:cli-user",
    }),
  ]);
  expect(runtime.subscriberFailures).toEqual([]);
});

it("cancels an unsubscribed running observer at the deadline and awaits its cleanup", async () => {
  fixture = await chatFixture();
  runtime = await EventRuntime.open({ workspace: await fixture.workspace() });
  const { session_id } = await runtime.openSession();
  const started = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const cleanup = Promise.withResolvers<void>();
  let cleaned = false;
  const unsubscribe = runtime.subscribe(async (_event, signal) => {
    signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    started.resolve();
    await aborted.promise;
    await cleanup.promise;
    cleaned = true;
  });
  await runtime.submit(input(session_id, "Hello"));
  await started.promise;
  unsubscribe();
  vi.useFakeTimers();
  const stopped = runtime.stop({ graceMs: 50 });
  let stopFinished = false;
  void stopped.then(() => {
    stopFinished = true;
  });
  try {
    await vi.advanceTimersByTimeAsync(49);
    expect(cleaned).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await aborted.promise;
    expect(stopFinished).toBe(false);
  } finally {
    cleanup.resolve();
    await stopped;
    expect(cleaned).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  }
});

it("keeps completed tools through request retries and reports exhaustion before a follow-up", async () => {
  fixture = await chatFixture();
  runtime = await EventRuntime.open({ workspace: await fixture.workspace() });
  const { session_id } = await runtime.openSession();
  fixture.responses.push(
    {
      status: 200,
      body: toolReply([{ name: "bash", id: "once", args: { command: "printf 'done'" } }]),
    },
    ...unavailableResponses(),
  );
  const failed = await runtime.submit(input(session_id, "Do the work"));
  expect(failed).toMatchObject({
    type: "OutboundEvent",
    error: expect.stringContaining("HTTP 503"),
    content: "",
  });
  expect(failed).not.toHaveProperty("reply_id");
  expect(fixture.requests.slice(1).map((request) => request.messages)).toEqual([
    fixture.requests[1].messages,
    fixture.requests[1].messages,
    fixture.requests[1].messages,
  ]);
  expect(fixture.requests[1].messages.at(-1)).toMatchObject({ role: "tool", content: "done" });
  expect(await runtime.submit(input(session_id, "Continue"))).toMatchObject({ error: null });
  expect(fixture.requests).toHaveLength(5);
  expect(fixture.requests[4].messages.filter((message) => message.role === "tool")).toHaveLength(1);
});

it("refreshes queued turn settings after the current turn while preserving context", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  runtime = await EventRuntime.open({ workspace });
  const { session_id } = await runtime.openSession();
  const held = Promise.withResolvers<unknown>();
  const received = Promise.withResolvers<void>();
  fixture.responses.push({ status: 200, body: held.promise });
  fixture.server.once("request", () => received.resolve());
  const first = runtime.submit(input(session_id, "First"));
  await received.promise;
  const next = runtime.submit(input(session_id, "Next"));
  await fixture.workspace(workspace, "  model: next-model\nfetch_content: {}\n");
  held.resolve(answer("First answer"));
  await Promise.all([first, next]);
  expect(fixture.requests.map((request) => request.model)).toEqual([
    "deepseek-flash",
    "next-model",
  ]);
  expect(fixture.requests[0].tools.map((tool) => tool.function.name)).not.toContain(
    "fetch_content",
  );
  expect(fixture.requests[1].tools.map((tool) => tool.function.name)).toContain("fetch_content");
  expect(fixture.requests[1].messages).toContainEqual({
    role: "assistant",
    content: "First answer",
  });
});

it("recovers saved attempted input without executing the abandoned turn or waiting follow-up", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  runtime = await EventRuntime.open({ workspace });
  const session = await runtime.openSession();
  const held = Promise.withResolvers<unknown>();
  const received = Promise.withResolvers<void>();
  fixture.responses.push({ status: 200, body: held.promise });
  fixture.server.once("request", () => received.resolve());
  const active = runtime.submit(input(session.session_id, "Attempted"));
  await received.promise;
  const waiting = runtime.submit(input(session.session_id, "Waiting"));
  await runtime.stop({ graceMs: 0 });
  await Promise.all([active, waiting]);
  held.resolve(answer("Late answer"));
  runtime = await EventRuntime.open({ workspace });
  const resumed = await runtime.openSession({ sessionId: session.session_id });
  expect(fixture.requests).toHaveLength(1);
  await runtime.submit(input(resumed.session_id, "New request"));
  expect(fixture.requests[1].messages).toEqual([
    { role: "system", content: "Give concise answers." },
    { role: "user", content: "Attempted" },
    { role: "user", content: "New request" },
  ]);
  expect(resumed.session_id).toBe(session.session_id);
});

it("reuses the running session when it is opened again without replacing its active context", async () => {
  fixture = await chatFixture();
  runtime = await EventRuntime.open({ workspace: await fixture.workspace() });
  const session = await runtime.openSession();
  const held = Promise.withResolvers<unknown>();
  const received = Promise.withResolvers<void>();
  fixture.responses.push({ status: 200, body: held.promise });
  fixture.server.once("request", () => received.resolve());
  const first = runtime.submit(input(session.session_id, "First"));
  await received.promise;
  await Promise.all([
    runtime.openSession({ sessionId: session.session_id }),
    runtime.openSession({ sessionId: session.session_id }),
  ]);
  const next = runtime.submit(input(session.session_id, "Next"));
  held.resolve(answer("First answer"));
  await Promise.all([first, next]);
  expect(fixture.requests[1].messages).toEqual([
    { role: "system", content: "Give concise answers." },
    { role: "user", content: "First" },
    { role: "assistant", content: "First answer" },
    { role: "user", content: "Next" },
  ]);
  await expect(
    runtime.openSession({ sessionId: session.session_id, agent: "other" }),
  ).rejects.toThrow("does not match");
});

it("reports a pending projection failure without successful output and recovers its committed reply", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  runtime = await EventRuntime.open({ workspace });
  const { session_id } = await runtime.openSession();
  const path = join(workspace, "written.txt");
  fixture.responses.push({
    status: 200,
    body: toolReply([{ name: "write", id: "saved-write", args: { path, content: "Saved" } }]),
  });
  await mkdir(join(workspace, ".event"));
  await writeFile(join(workspace, ".event", "pending"), "Blocked directory");
  const observed: RuntimeEvent[] = [];
  runtime.subscribe(async (event) => {
    observed.push(event);
  });
  expect(await runtime.submit(input(session_id, "Write"))).toMatchObject({
    type: "OutboundEvent",
    error: expect.any(String),
    content: "",
  });
  await runtime.stop();
  expect(observed.filter((event) => event.type === "OutboundEvent")).toEqual([
    expect.objectContaining({ error: expect.any(String), content: "" }),
  ]);
  expect(await readFile(path, "utf8")).toBe("Saved");
  await writeFile(path, "Changed after the tool");
  await rm(join(workspace, ".event", "pending"));
  runtime = await EventRuntime.open({ workspace });
  await runtime.openSession({ sessionId: session_id });
  expect(await runtime.getPendingReplies(session_id)).toEqual([
    expect.objectContaining({ payload: "Hello!", destination: "platform-cli:cli-user" }),
  ]);
  expect(fixture.requests).toHaveLength(2);
  expect(await readFile(path, "utf8")).toBe("Changed after the tool");
});

it.each(["platform-cli:cli-user", "platform-telegram:123:-456", "platform-ws:user:one"])(
  "preserves the inbound source and committed destination for %s",
  async (source) => {
    fixture = await chatFixture();
    runtime = await EventRuntime.open({ workspace: await fixture.workspace() });
    const observed: RuntimeEvent[] = [];
    runtime.subscribe(async (event) => {
      observed.push(event);
    });
    const event =
      source === "platform-cli:cli-user"
        ? { ...input((await runtime.openSession()).session_id, "Hello"), source, retry_count: 2 }
        : { source, content: "Hello" };
    const result = await runtime.submit(event);
    await runtime.stop();
    expect(observed[0]).toMatchObject(event);
    expect(await runtime.getPendingReplies(result.session_id)).toEqual([
      expect.objectContaining({ destination: source }),
    ]);
    expect(fixture.requests).toHaveLength(1);
  },
);

it("cancels the model retry wait and releases its timer without another request", async () => {
  fixture = await chatFixture();
  runtime = await EventRuntime.open({ workspace: await fixture.workspace() });
  const { session_id } = await runtime.openSession();
  fixture.responses.push({
    status: 429,
    body: { error: { message: "Wait before retrying" } },
    headers: { "Retry-After": "30" },
  });
  const waiting = Promise.withResolvers<ReturnType<typeof setTimeout>>();
  const schedule = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
    const timer = schedule(callback, delay, ...args);
    if (delay === 30_000) waiting.resolve(timer);
    return timer;
  });
  const clear = vi.spyOn(globalThis, "clearTimeout");
  const result = runtime.submit(input(session_id, "Wait"));
  const timer = await waiting.promise;
  await runtime.stop({ graceMs: 0 });
  expect(await result).toEqual({ type: "CancelledTurn", session_id, content: "" });
  expect(fixture.requests).toHaveLength(1);
  expect(clear).toHaveBeenCalledWith(timer);
});

it("preserves colon-bearing Agent identities in complete outbound observations", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  await rename(
    join(workspace, ".agents", "bots", "helper"),
    join(workspace, ".agents", "bots", "helper:one"),
  );
  await writeFile(
    join(workspace, "config.user.yaml"),
    `default_agent: helper:one\nllm:\n  api_key: offline-test-key\n  api_base: ${fixture.endpoint}\n`,
  );
  runtime = await EventRuntime.open({ workspace, agent: "helper:one" });
  const { session_id } = await runtime.openSession({ agent: "helper:one" });
  const events: RuntimeEvent[] = [];
  runtime.subscribe(async (event) => {
    events.push(event);
  });
  expect(await runtime.submit(input(session_id, "Hello"))).toMatchObject({
    type: "OutboundEvent",
    source: "agent:helper:one",
    content: "Hello!",
    error: null,
  });
  await runtime.stop();
  expect(events[1]).toMatchObject({ source: "agent:helper:one", content: "Hello!" });
});

function input(session_id: string, content: string) {
  return {
    type: "InboundEvent" as const,
    session_id,
    source: "platform-cli:cli-user",
    content,
    timestamp: 1_792_000_000.25,
    retry_count: 0,
  };
}

function answer(content: string) {
  return { choices: [{ message: { role: "assistant", content } }] };
}

it("queues a follow-up behind a held turn and includes the preceding committed answer", async () => {
  fixture = await chatFixture();
  runtime = await EventRuntime.open({ workspace: await fixture.workspace() });
  const { session_id } = await runtime.openSession();
  const received = Promise.withResolvers<void>();
  const held = Promise.withResolvers<unknown>();
  fixture.server.once("request", () => received.resolve());
  fixture.responses.push({ status: 200, body: held.promise });
  const first = runtime.submit(input(session_id, "Remember Alice"));
  await received.promise;
  const second = runtime.submit(input(session_id, "Who?"));
  // Collect both immediately so even a rejected follow-up is observed.
  const results = Promise.allSettled([first, second]);
  held.resolve(answer("Alice remembered"));
  expect(await results).toEqual([
    { status: "fulfilled", value: expect.objectContaining({ content: "Alice remembered" }) },
    { status: "fulfilled", value: expect.objectContaining({ content: "Hello!" }) },
  ]);
  expect(fixture.requests[1].messages).toEqual([
    { role: "system", content: "Give concise answers." },
    { role: "user", content: "Remember Alice" },
    { role: "assistant", content: "Alice remembered" },
    { role: "user", content: "Who?" },
  ]);
});

it.each([
  { type: "OtherEvent" },
  { session_id: "" },
  { source: "platform-cli:other" },
  { source: "platform-telegram:one:two" },
  { source: "platform-ws:" },
  { source: "agent:helper" },
  { content: 42 },
  { timestamp: Number.NaN },
  { retry_count: -1 },
  { retry_count: 1.5 },
])("rejects invalid external input before execution: %j", async (patch) => {
  fixture = await chatFixture();
  runtime = await EventRuntime.open({ workspace: await fixture.workspace() });
  const { session_id } = await runtime.openSession();
  await expect(runtime.submit({ ...input(session_id, "Hello"), ...patch })).rejects.toThrow(
    "Invalid",
  );
  expect(fixture.requests).toHaveLength(0);
});
