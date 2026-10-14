import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { PiProvider } from "../container/agent-runner/src/providers/pi.ts";
import type { ProviderEvent } from "../container/agent-runner/src/providers/types.ts";
import { startPiService } from "./pi-fixture.ts";

test("Pi executes a workspace tool and emits one final exchange reply", async () => {
  const root = await mkdtemp(join(tmpdir(), "mybots-pi-"));
  const service = await startPiService((request) =>
    request.messages.some((m) => m.role === "tool")
      ? { text: "Saved the note." }
      : {
          tool: "write",
          arguments: { path: "note.txt", content: "Agent workspace note\n" },
          text: "Saving a note.",
        },
  );
  const provider = new PiProvider({ modelRuntime: service.runtime, model: service.model });
  const query = provider.query({ prompt: "Save a note", cwd: root, sessionDir: join(root, "pi") });
  try {
    const events: ProviderEvent[] = [];
    for await (const event of query.events) events.push(event);
    expect(events.filter((event) => event.type === "result")).toEqual([
      { type: "result", text: "Saved the note." },
    ]);
    expect(await readFile(join(root, "note.txt"), "utf8")).toBe("Agent workspace note\n");
    expect(events).toContainEqual({ type: "text", text: "Saving a note." });
    expect(events).toContainEqual({ type: "progress", message: "write" });
    expect(events.some((event) => event.type === "activity")).toBe(true);
    expect(events[0]).toMatchObject({ type: "init", continuation: expect.stringMatching(/^pi:/) });
    expect(service.requests).toHaveLength(2);
  } finally {
    await query.abort();
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test("a new Pi query explicitly reopens the selected conversation and its tool results", async () => {
  const root = await mkdtemp(join(tmpdir(), "mybots-pi-reopen-"));
  const service = await startPiService((request) => {
    const latest = request.messages.findLast((message) => message.role === "user");
    if (JSON.stringify(latest?.content).includes("Save the original note")) {
      return request.messages.some((message) => message.role === "tool")
        ? { text: "Original note saved." }
        : {
            tool: "write",
            arguments: { path: "original.txt", content: "Original conversation\n" },
          };
    }
    return {
      text: JSON.stringify(latest?.content).includes("Unrelated conversation")
        ? "Unrelated reply."
        : "Reopened original.",
    };
  });
  const input = { cwd: root, sessionDir: join(root, "pi") };
  const queries = [];
  try {
    const first = new PiProvider({ modelRuntime: service.runtime, model: service.model }).query({
      ...input,
      prompt: "Save the original note",
    });
    queries.push(first);
    let continuation = "";
    for await (const event of first.events) {
      if (event.type === "init") continuation = event.continuation;
    }
    const unrelated = new PiProvider({ modelRuntime: service.runtime, model: service.model }).query(
      {
        ...input,
        prompt: "Unrelated conversation",
      },
    );
    queries.push(unrelated);
    for await (const _event of unrelated.events) {
      /* Complete the newer conversation. */
    }
    const reopened = new PiProvider({ modelRuntime: service.runtime, model: service.model }).query({
      ...input,
      prompt: "Continue original",
      continuation,
    });
    queries.push(reopened);
    const events: ProviderEvent[] = [];
    for await (const event of reopened.events) events.push(event);
    expect(events[0]).toEqual({ type: "init", continuation });
    expect(events.at(-1)).toEqual({ type: "result", text: "Reopened original." });
    const messages = service.requests.at(-1)?.messages;
    expect(messages).toContainEqual(
      expect.objectContaining({
        role: "user",
        content: [{ type: "text", text: "Save the original note" }],
      }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({ role: "assistant", content: "Original note saved." }),
    );
    expect(messages?.some((message) => message.role === "tool")).toBe(true);
    expect(JSON.stringify(messages)).toContain("original.txt");
    expect(JSON.stringify(messages)).not.toContain("Unrelated conversation");
  } finally {
    for (const query of queries) await query.abort();
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test("Pi runs read, edit and bash with model/tool continuation in the Agent workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "mybots-pi-tools-"));
  const replies = [
    { tool: "write", arguments: { path: "note.txt", content: "before\n" } },
    { tool: "read", arguments: { path: "note.txt" } },
    {
      tool: "edit",
      arguments: { path: "note.txt", edits: [{ oldText: "before", newText: "after" }] },
    },
    { tool: "bash", arguments: { command: "cat note.txt > copy.txt" } },
    { text: "Edited and copied." },
  ];
  const service = await startPiService(() => {
    const reply = replies.shift();
    if (!reply) throw new Error("Unexpected model request");
    return reply;
  });
  const query = new PiProvider({ modelRuntime: service.runtime, model: service.model }).query({
    prompt: "Edit and copy the note",
    cwd: root,
    sessionDir: join(root, "pi"),
  });
  try {
    const events: ProviderEvent[] = [];
    for await (const event of query.events) events.push(event);
    expect(events.filter((event) => event.type === "result")).toEqual([
      { type: "result", text: "Edited and copied." },
    ]);
    expect(await readFile(join(root, "copy.txt"), "utf8")).toBe("after\n");
    expect(
      events.filter((event) => event.type === "progress").map((event) => event.message),
    ).toEqual(["write", "read", "edit", "bash"]);
    expect(
      service.requests.at(-1)?.messages.filter((message) => message.role === "tool"),
    ).toHaveLength(4);
    expect(JSON.stringify(service.requests[2]?.messages)).toContain("before");
  } finally {
    await query.abort();
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test("abort stops a waiting SDK request and disposal permits reopening", async () => {
  const root = await mkdtemp(join(tmpdir(), "mybots-pi-abort-"));
  let holding = true;
  const service = await startPiService(() => (holding ? { hold: true } : { text: "After abort." }));
  const provider = new PiProvider({ modelRuntime: service.runtime, model: service.model });
  const input = { cwd: root, sessionDir: join(root, "pi") };
  const query = provider.query({ ...input, prompt: "Waiting request" });
  try {
    const events: ProviderEvent[] = [];
    const collected = (async () => {
      for await (const event of query.events) events.push(event);
    })();
    await service.waitForRequest();
    await query.abort();
    await collected;
    expect(events.at(-1)).toEqual({
      type: "result",
      text: null,
      isError: true,
      error: "Agent query aborted.",
    });
    const init = events.find((event) => event.type === "init");
    if (init?.type !== "init") throw new Error("Missing continuation");
    holding = false;
    const reopened = provider.query({
      ...input,
      prompt: "Continue",
      continuation: init.continuation,
    });
    const next = [];
    for await (const event of reopened.events) next.push(event);
    expect(next.at(-1)).toEqual({ type: "result", text: "After abort." });
  } finally {
    await query.abort();
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
}, 10000);

test("provider failure returns one failed result without repeating the exchange", async () => {
  const root = await mkdtemp(join(tmpdir(), "mybots-pi-error-"));
  const service = await startPiService(() => ({ status: 400 }));
  const query = new PiProvider({ modelRuntime: service.runtime, model: service.model }).query({
    prompt: "Fail the model request",
    cwd: root,
    sessionDir: join(root, "pi"),
  });
  try {
    const events: ProviderEvent[] = [];
    for await (const event of query.events) events.push(event);
    expect(events.filter((event) => event.type === "result")).toEqual([
      { type: "result", text: null, isError: true, error: "Agent model request failed." },
    ]);
    expect(service.requests).toHaveLength(1);
  } finally {
    await query.abort();
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
}, 10000);

test("missing or foreign continuation fails without starting another conversation", async () => {
  const root = await mkdtemp(join(tmpdir(), "mybots-pi-invalid-"));
  const service = await startPiService(() => ({ text: "Must not run" }));
  const provider = new PiProvider({ modelRuntime: service.runtime, model: service.model });
  try {
    for (const continuation of [
      `pi:${join(root, "pi", "sessions", "missing.jsonl")}`,
      `pi:${join(root, "other.jsonl")}`,
      "other:session",
    ]) {
      const query = provider.query({
        prompt: "Continue",
        cwd: root,
        sessionDir: join(root, "pi"),
        continuation,
      });
      const events: ProviderEvent[] = [];
      for await (const event of query.events) events.push(event);
      expect(events).toEqual([
        { type: "result", text: null, isError: true, error: "Agent query failed." },
      ]);
    }
    expect(service.requests).toHaveLength(0);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
}, 10000);

test("an empty saved continuation fails without replacing its conversation", async () => {
  const root = await mkdtemp(join(tmpdir(), "mybots-pi-empty-"));
  const history = join(root, "pi", "sessions");
  await mkdir(history, { recursive: true });
  const file = join(history, "empty.jsonl");
  await writeFile(file, "");
  const service = await startPiService(() => ({ text: "Must not run" }));
  const query = new PiProvider({ modelRuntime: service.runtime, model: service.model }).query({
    prompt: "Continue",
    cwd: root,
    sessionDir: join(root, "pi"),
    continuation: `pi:${file}`,
  });
  try {
    const events: ProviderEvent[] = [];
    for await (const event of query.events) events.push(event);
    expect(events).toEqual([
      { type: "result", text: null, isError: true, error: "Agent query failed." },
    ]);
    expect(await readFile(file, "utf8")).toBe("");
    expect(service.requests).toHaveLength(0);
  } finally {
    await query.abort();
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
}, 10000);
