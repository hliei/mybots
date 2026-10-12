import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { ConversationHistory } from "../src/core/history.ts";
import { chatFixture, toolReply } from "./chat-fixture.ts";

const entry = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
let fixture: Awaited<ReturnType<typeof chatFixture>> | undefined;
afterEach(async () => {
  const current = fixture;
  fixture = undefined;
  await current?.close();
});

async function run(args: string[], input = "", cwd?: string) {
  const child = spawn(process.execPath, [entry, ...args], { cwd, stdio: "pipe" });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text) => {
    stdout += text;
  });
  child.stderr.setEncoding("utf8").on("data", (text) => {
    stderr += text;
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const result = new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("close", (status) => resolve({ status, stdout, stderr }));
      },
    );
    child.stdin.end(input);
    return await result;
  } finally {
    clearTimeout(timeout);
  }
}

it("prints complete replies for two CLI turns and forwards the previous context", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  const result = await run(
    ["-w", workspace, "chat", "-a", "helper"],
    "Remember Alice\nWho?\nquit\n",
  );
  expect(result).toMatchObject({ status: 0, stderr: "" });
  expect(result.stdout.match(/helper: Hello!/g)).toHaveLength(2);
  expect(fixture.requests[1].messages).toEqual([
    { role: "system", content: "Give concise answers." },
    { role: "user", content: "Remember Alice" },
    { role: "assistant", content: "Hello!", reasoning_content: "Full reasoning." },
    { role: "user", content: "Who?" },
  ]);
});

it("accepts long options and starts each CLI launch with fresh context", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  for (const input of ["First\nexit\n", "Second\nq\n"]) {
    expect((await run(["--workspace", workspace, "--agent", "helper"], input)).status).toBe(0);
  }
  expect(
    fixture.requests.map((request) => request.messages.map((message) => message.content)),
  ).toEqual([
    ["Give concise answers.", "First"],
    ["Give concise answers.", "Second"],
  ]);
});

it("uses reference defaults and exits on EOF while ignoring blank input", async () => {
  fixture = await chatFixture();
  await fixture.workspace(join(fixture.root, "default_workspace"));
  const cwd = join(fixture.root, "app");
  await mkdir(cwd);
  const result = await run([], "\nHello\n", cwd);
  expect(result).toMatchObject({ status: 0, stderr: "" });
  expect(result.stdout).toContain("helper: Hello!");
  expect(result.stdout).toContain("Goodbye!");
  expect(fixture.requests).toHaveLength(1);
});

it("reports a provider error and lets the CLI user continue", async () => {
  fixture = await chatFixture();
  fixture.responses.push({ status: 503, body: { error: { message: "Unavailable" } } });
  const result = await run(["-w", await fixture.workspace()], "Fail\nRecover\nquit\n");
  expect(result.status).toBe(0);
  expect(result.stderr).toContain("DeepSeek request failed (HTTP 503)");
  expect(result.stdout).toContain("helper: Hello!");
  expect(fixture.requests[1].messages).toHaveLength(2);
});

it("prints help without configuration or a service connection", async () => {
  fixture = await chatFixture();
  const result = await run(["--workspace", join(fixture.root, "missing"), "--help"]);
  expect(result).toMatchObject({ status: 0, stderr: "" });
  expect(result.stdout).toContain("Usage: npm run start:cli");
  expect(result.stdout).toContain("--workspace");
  expect(fixture.requests).toHaveLength(0);
});

it.each([["--unknown"], ["-w"], ["unexpected"]])(
  "rejects invalid CLI arguments %s",
  async (...args) => {
    const result = await run(args);
    expect(result.status).toBe(1);
    expect(result.stderr).not.toBe("");
  },
);

it("reports missing Workspace configuration", async () => {
  fixture = await chatFixture();
  const result = await run(["-w", fixture.root]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("config.user.yaml");
  expect(fixture.requests).toHaveLength(0);
});

it("saves each CLI launch as a separate session a reader can open", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  expect((await run(["-w", workspace], "Remember Alice\nquit\n")).status).toBe(0);
  expect((await run(["-w", workspace], "Second launch\nexit\n")).status).toBe(0);

  const history = await ConversationHistory.open(join(workspace, ".history"));
  const sessions = await history.listSessions();
  expect(sessions.map((session) => session.title)).toEqual(["Second launch", "Remember Alice"]);
  expect(sessions[0].id).not.toBe(sessions[1].id);
  expect(sessions).toContainEqual(
    expect.objectContaining({ agent_id: "helper", message_count: 2 }),
  );
  expect(await history.getMessages(sessions[1].id)).toEqual([
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

it("executes multiple tool rounds from the CLI using relative paths from process cwd", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  fixture.responses.push(
    {
      status: 200,
      body: toolReply(
        [{ name: "write", id: "cli-write", args: { path: "note.txt", content: "CLI artifact" } }],
        "Save the note.",
      ),
    },
    {
      status: 200,
      body: toolReply(
        [{ name: "read", id: "cli-read", args: { path: "note.txt" } }],
        "Inspect the note.",
      ),
    },
  );
  const result = await run(["-w", workspace], "Save and inspect\nquit\n", fixture.root);
  expect(result).toMatchObject({ status: 0, stderr: "" });
  expect(result.stdout.match(/helper: Hello!/g)).toHaveLength(1);
  expect(await readFile(join(fixture.root, "note.txt"), "utf8")).toBe("CLI artifact");
  expect(fixture.requests[1].messages.at(-1)).toEqual({
    role: "tool",
    tool_call_id: "cli-write",
    content: "Successfully wrote to: note.txt",
  });
  expect(fixture.requests[2].messages.at(-1)).toEqual({
    role: "tool",
    tool_call_id: "cli-read",
    content: "CLI artifact",
  });
  expect(
    fixture.requests[2].messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.reasoning_content),
  ).toEqual(["Save the note.", "Inspect the note."]);
});
