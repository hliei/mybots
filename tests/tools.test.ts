import { watch } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Agent } from "../src/core/agent.ts";
import { chatFixture, toolReply } from "./chat-fixture.ts";

let fixture: Awaited<ReturnType<typeof chatFixture>> | undefined;
afterEach(async () => {
  const current = fixture;
  fixture = undefined;
  await current?.close();
});

it("reads full local text and continues with the matching tool result and reasoning", async () => {
  fixture = await chatFixture();
  const agent = await Agent.open({ workspace: await fixture.workspace() });
  const path = join(fixture.root, "note.txt");
  await writeFile(path, "First line\nSecond line\n");
  fixture.responses.push({
    status: 200,
    body: {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            reasoning_content: "Read the complete file.",
            tool_calls: [
              {
                id: "read-1",
                type: "function",
                function: { name: "read", arguments: JSON.stringify({ path }) },
              },
            ],
          },
        },
      ],
    },
  });
  expect(await agent.chat("Read the note")).toBe("Hello!");
  expect(fixture.requests[1].messages).toEqual([
    { role: "system", content: "Give concise answers." },
    { role: "user", content: "Read the note" },
    {
      role: "assistant",
      content: "",
      reasoning_content: "Read the complete file.",
      tool_calls: [
        {
          id: "read-1",
          type: "function",
          function: { name: "read", arguments: JSON.stringify({ path }) },
        },
      ],
    },
    { role: "tool", tool_call_id: "read-1", content: "First line\nSecond line\n" },
  ]);
});

it("writes a file and supplies its acknowledgement to the model", async () => {
  fixture = await chatFixture();
  const agent = await Agent.open({ workspace: await fixture.workspace() });
  const path = join(fixture.root, "written.txt");
  fixture.responses.push({
    status: 200,
    body: toolReply([{ name: "write", id: "write-1", args: { path, content: "A new file" } }]),
  });
  await agent.chat("Write a note");
  expect(await readFile(path, "utf8")).toBe("A new file");
  expect(fixture.requests[1].messages.at(-1)).toEqual({
    role: "tool",
    tool_call_id: "write-1",
    content: `Successfully wrote to: ${path}`,
  });
});

it("edits every match and returns a matching result before the final reply", async () => {
  fixture = await chatFixture();
  const agent = await Agent.open({ workspace: await fixture.workspace() });
  const path = join(fixture.root, "edit.txt");
  await writeFile(path, "red blue red");
  fixture.responses.push({
    status: 200,
    body: toolReply([
      { name: "edit", id: "edit-1", args: { path, old_text: "red", new_text: "green" } },
    ]),
  });
  await agent.chat("Replace red");
  expect(await readFile(path, "utf8")).toBe("green blue green");
  expect(fixture.requests[1].messages.at(-1)).toMatchObject({
    tool_call_id: "edit-1",
    content: `Successfully edited ${path}`,
  });
});

it("uses literal replacement text, including empty old_text boundaries", async () => {
  fixture = await chatFixture();
  const agent = await Agent.open({ workspace: await fixture.workspace() });
  const path = join(fixture.root, "literal.txt");
  await writeFile(path, "a😀");
  fixture.responses.push({
    status: 200,
    body: toolReply([
      { name: "edit", id: "literal-1", args: { path, old_text: "", new_text: "$&" } },
    ]),
  });
  await agent.chat("Insert literal text");
  expect(await readFile(path, "utf8")).toBe("$&a$&😀$&");
});

it("runs a shell command and separates stdout and stderr with an extra newline", async () => {
  fixture = await chatFixture();
  const agent = await Agent.open({ workspace: await fixture.workspace() });
  fixture.responses.push({
    status: 200,
    body: toolReply([
      { name: "bash", id: "bash-1", args: { command: "printf 'out'; printf 'err' >&2" } },
    ]),
  });
  await agent.chat("Run a command");
  expect(fixture.requests[1].messages.at(-1)).toEqual({
    role: "tool",
    tool_call_id: "bash-1",
    content: "out\nerr",
  });
});

it.each([
  ["printf 'ok'", "ok"],
  ["printf 'bad' >&2; exit 7", "bad"],
  ["true", "Command completed with no output"],
])("reports shell output and empty results: %s", async (command, expected) => {
  fixture = await chatFixture();
  const agent = await Agent.open({ workspace: await fixture.workspace() });
  fixture.responses.push({
    status: 200,
    body: toolReply([{ name: "bash", id: "shell-result", args: { command } }]),
  });
  await agent.chat("Run");
  expect(fixture.requests[1].messages.at(-1)?.content).toBe(expected);
});

it("preserves call order while creating, editing and reading a file in one response", async () => {
  fixture = await chatFixture();
  const agent = await Agent.open({ workspace: await fixture.workspace() });
  const path = join(fixture.root, "ordered.txt");
  fixture.responses.push({
    status: 200,
    body: toolReply([
      { name: "write", id: "create", args: { path, content: "red red" } },
      { name: "edit", id: "replace", args: { path, old_text: "red", new_text: "blue" } },
      { name: "read", id: "inspect", args: { path } },
    ]),
  });
  await agent.chat("Make and inspect a note");
  expect(fixture.requests[1].messages.slice(-3)).toEqual([
    { role: "tool", tool_call_id: "create", content: `Successfully wrote to: ${path}` },
    { role: "tool", tool_call_id: "replace", content: `Successfully edited ${path}` },
    { role: "tool", tool_call_id: "inspect", content: "blue blue" },
  ]);
  expect(
    fixture.requests[0].tools.map((tool) => [
      tool.function.name,
      tool.function.parameters.required,
    ]),
  ).toEqual([
    ["read", ["path"]],
    ["write", ["path", "content"]],
    ["edit", ["path", "old_text", "new_text"]],
    ["bash", ["command"]],
  ]);
});

it.each([true, false])(
  "retains all reasoning through multiple tool rounds and the next user turn (thinking %s)",
  async (thinking) => {
    fixture = await chatFixture();
    const agent = await Agent.open({
      workspace: await fixture.workspace(fixture.root, `  thinking: ${thinking}\n`),
    });
    const path = join(fixture.root, "rounds.txt");
    fixture.responses.push(
      {
        status: 200,
        body: toolReply(
          [{ name: "write", id: "round-1", args: { path, content: "saved" } }],
          "Complete first reasoning.",
        ),
      },
      {
        status: 200,
        body: toolReply(
          [{ name: "read", id: "round-2", args: { path } }],
          "Complete second reasoning.",
        ),
      },
    );
    await agent.chat("Save then inspect");
    await agent.chat("Continue");
    expect(
      fixture.requests[2].messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.reasoning_content),
    ).toEqual(["Complete first reasoning.", "Complete second reasoning."]);
    expect(
      fixture.requests[3].messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.reasoning_content),
    ).toEqual(["Complete first reasoning.", "Complete second reasoning.", "Full reasoning."]);
    expect(
      fixture.requests.every(
        (request) => request.thinking.type === (thinking ? "enabled" : "disabled"),
      ),
    ).toBe(true);
    expect(fixture.requests[2].messages.at(-1)).toMatchObject({
      tool_call_id: "round-2",
      content: "saved",
    });
  },
);

it("returns missing-file and missing-text errors without changing existing content", async () => {
  fixture = await chatFixture();
  const agent = await Agent.open({ workspace: await fixture.workspace() });
  const path = join(fixture.root, "untouched.txt");
  const missing = join(fixture.root, "missing.txt");
  await writeFile(path, "Original");
  fixture.responses.push({
    status: 200,
    body: toolReply([
      { name: "read", id: "missing", args: { path: missing } },
      { name: "edit", id: "absent", args: { path, old_text: "Absent", new_text: "Changed" } },
    ]),
  });
  await agent.chat("Try operations");
  expect(fixture.requests[1].messages.slice(-2).map((message) => message.content)).toEqual([
    `Error: File not found: ${missing}`,
    `Error: 'Absent' not found in ${path}`,
  ]);
  expect(await readFile(path, "utf8")).toBe("Original");
});

it("does not create parent directories when writing fails", async () => {
  fixture = await chatFixture();
  const agent = await Agent.open({ workspace: await fixture.workspace() });
  const path = join(fixture.root, "absent", "file.txt");
  fixture.responses.push({
    status: 200,
    body: toolReply([{ name: "write", id: "no-parent", args: { path, content: "Text" } }]),
  });
  await agent.chat("Write with absent parent");
  expect(fixture.requests[1].messages.at(-1)?.content).toContain("Error writing file:");
  await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

it("retains completed tool exchanges when the continuation request fails", async () => {
  fixture = await chatFixture();
  const agent = await Agent.open({ workspace: await fixture.workspace() });
  const path = join(fixture.root, "completed.txt");
  fixture.responses.push(
    {
      status: 200,
      body: toolReply([{ name: "write", id: "completed", args: { path, content: "Done" } }]),
    },
    { status: 503, body: { error: { message: "Unavailable" } } },
  );
  await expect(agent.chat("Write")).rejects.toThrow("HTTP 503");
  await agent.chat("Continue without repeating");
  expect(fixture.requests[2].messages.map((message) => message.role)).toEqual([
    "system",
    "user",
    "assistant",
    "tool",
    "user",
  ]);
  expect(fixture.requests[2].messages[3]).toMatchObject({
    tool_call_id: "completed",
    content: `Successfully wrote to: ${path}`,
  });
  expect(await readFile(path, "utf8")).toBe("Done");
});

it("returns malformed arguments and unknown tools as observable tool results", async () => {
  fixture = await chatFixture();
  const agent = await Agent.open({ workspace: await fixture.workspace() });
  fixture.responses.push({
    status: 200,
    body: {
      choices: [
        {
          message: {
            role: "assistant",
            content: "",
            reasoning_content: "Try these calls.",
            tool_calls: [
              { id: "invalid", type: "function", function: { name: "read", arguments: "{" } },
              {
                id: "wrong-type",
                type: "function",
                function: { name: "write", arguments: '{"path":3,"content":"x"}' },
              },
              { id: "unknown", type: "function", function: { name: "unknown", arguments: "{}" } },
            ],
          },
        },
      ],
    },
  });
  await agent.chat("Try calls");
  const results = fixture.requests[1].messages.slice(-3);
  expect(results.map((message) => message.tool_call_id)).toEqual([
    "invalid",
    "wrong-type",
    "unknown",
  ]);
  expect(results.every((message) => message.content.startsWith("Error executing tool:"))).toBe(
    true,
  );
});

it("overwrites an existing file and reports directory reads as tool errors", async () => {
  fixture = await chatFixture();
  const agent = await Agent.open({ workspace: await fixture.workspace() });
  const path = join(fixture.root, "existing.txt");
  await writeFile(path, "Old");
  fixture.responses.push({
    status: 200,
    body: toolReply([
      { name: "write", id: "overwrite", args: { path, content: "New" } },
      { name: "read", id: "directory", args: { path: fixture.root } },
    ]),
  });
  await agent.chat("Overwrite and inspect");
  expect(await readFile(path, "utf8")).toBe("New");
  expect(fixture.requests[1].messages.at(-1)?.content).toBe(
    `Error: Path is a directory, not a file: ${fixture.root}`,
  );
});

it("cancels a running shell, awaits termination, and preserves its error result", async () => {
  fixture = await chatFixture();
  const agent = await Agent.open({ workspace: await fixture.workspace() });
  const marker = join(fixture.root, "started");
  const markerQuoted = `'${marker.replaceAll("'", "'\\''")}'`;
  const controller = new AbortController();
  const watcher = watch(fixture.root);
  let markerTimeout: ReturnType<typeof setTimeout> | undefined;
  const started = new Promise<void>((resolve, reject) => {
    markerTimeout = setTimeout(() => reject(new Error("Shell did not start.")), 3000);
    watcher.on("change", (_event, filename) => {
      if (filename === "started") {
        clearTimeout(markerTimeout);
        resolve();
      }
    });
  });
  fixture.responses.push({
    status: 200,
    body: toolReply([
      {
        name: "bash",
        id: "cancel-shell",
        args: {
          command: `trap '' TERM; echo $$ > ${markerQuoted}; sleep 600`,
        },
      },
    ]),
  });
  const running = agent.chat("Run until cancelled", controller.signal);
  const rejected = expect(running).rejects.toThrow("DeepSeek request cancelled");
  try {
    await started;
    controller.abort();
    await rejected;
    const pid = Number((await readFile(marker, "utf8")).trim());
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
    await agent.chat("Continue after cancellation");
    expect(fixture.requests[1].messages[3]).toEqual({
      role: "tool",
      tool_call_id: "cancel-shell",
      content: "Error executing command: cancelled.",
    });
  } finally {
    controller.abort();
    clearTimeout(markerTimeout);
    watcher.close();
    await running.catch(() => {});
  }
});
