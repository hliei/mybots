import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { ConversationHistory } from "../src/core/history.ts";
import { chatFixture, toolReply, unavailableResponses } from "./chat-fixture.ts";
import { pageFixture } from "./page-fixture.ts";
import { searchFixture } from "./search-fixture.ts";

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

it("uses the default workspace and Agent and exits on EOF while ignoring blank input", async () => {
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
  fixture.responses.push(...unavailableResponses());
  const result = await run(["-w", await fixture.workspace()], "Fail\nRecover\nquit\n");
  expect(result.status).toBe(0);
  expect(result.stderr).toContain("DeepSeek request failed (HTTP 503)");
  expect(result.stdout).toContain("helper: Hello!");
  expect(fixture.requests).toHaveLength(4);
  expect(fixture.requests[3].messages).toHaveLength(2);
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

it.each(["websearch: null\n", "webread: {}\nfetch_content: {}\n"])(
  "reports web configuration migration instructions at CLI startup: %s",
  async (settings) => {
    fixture = await chatFixture();
    const result = await run(["-w", await fixture.workspace(undefined, settings)]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Migrate websearch to web_search");
    expect(result.stderr).toContain("replace webread with fetch_content: {}");
    expect(fixture.requests).toHaveLength(0);
  },
);

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
      completion: {
        turnId: expect.any(String),
        replyId: expect.any(String),
        payload: "Hello!",
        destination: "platform-cli:cli-user",
      },
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

it("discovers and loads a Skill through the CLI and prints the final reply", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace(fixture.root, "", "allow_skills: true\n");
  await fixture.writeSkill(
    "weather",
    "---\nname: Weather\ndescription: Look up the weather\n---\n\nAlways mention the temperature unit.\n",
    workspace,
  );
  fixture.responses.push({
    status: 200,
    body: toolReply(
      [{ name: "skill", id: "cli-skill", args: { skill_name: "weather" } }],
      "Load the CLI skill.",
    ),
  });
  const result = await run(["-w", workspace], "Check the weather\nquit\n");
  expect(result).toMatchObject({ status: 0, stderr: "" });
  expect(result.stdout.match(/helper: Hello!/g)).toHaveLength(1);
  expect(fixture.requests[0].tools.map((tool) => tool.function.name)).toContain("skill");
  expect(fixture.requests[1].messages.at(-1)).toEqual({
    role: "tool",
    tool_call_id: "cli-skill",
    content: "Always mention the temperature unit.",
  });
});

it("serves inspection commands without contacting the model or recording messages", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace(fixture.root, "", "allow_skills: true\n");
  await fixture.writeSkill(
    "weather",
    "---\nname: Weather\ndescription: Look up the weather\n---\n\nAlways mention the temperature unit.\n",
    workspace,
  );
  const result = await run(
    ["-w", workspace],
    "/help\n/session\n/skills\n/skills weather\n/skills missing\nquit\n",
  );
  expect(result).toMatchObject({ status: 0, stderr: "" });
  expect(result.stdout).toContain("**Available Commands:**");
  expect(result.stdout).toContain("/session - Show current session details");
  expect(result.stdout).toContain("- `weather`: Look up the weather");
  expect(result.stdout).toContain("**Name:** Weather");
  expect(result.stdout).toContain("Always mention the temperature unit.");
  expect(result.stdout).toContain("✗ Skill `missing` not found.");
  expect(fixture.requests).toHaveLength(0);

  const history = await ConversationHistory.open(join(workspace, ".history"));
  const sessions = await history.listSessions();
  expect(sessions).toHaveLength(1);
  expect(sessions[0]).toMatchObject({ agent_id: "helper", message_count: 0 });
  expect(await history.getMessages(sessions[0].id)).toEqual([]);
});

it("falls back to ordinary chat for unknown and lone slash input", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  const result = await run(["-w", workspace], "/unknown command\n/\nquit\n");
  expect(result).toMatchObject({ status: 0, stderr: "" });
  expect(result.stdout.match(/helper: Hello!/g)).toHaveLength(2);
  expect(fixture.requests[0].messages.at(-1)).toEqual({
    role: "user",
    content: "/unknown command",
  });
  expect(fixture.requests[1].messages.at(-1)).toEqual({ role: "user", content: "/" });
});

it("reports and manually compacts context from the CLI, then continues with the summary", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  fixture.responses.push(
    {
      status: 200,
      body: { choices: [{ message: { role: "assistant", content: "Older answer" } }] },
    },
    {
      status: 200,
      body: {
        choices: [
          {
            message: {
              role: "assistant",
              content: "Recent answer",
              reasoning_content: "Recent thinking",
            },
          },
        ],
      },
    },
    {
      status: 200,
      body: {
        choices: [
          { finish_reason: "stop", message: { role: "assistant", content: "Remember Alice." } },
        ],
      },
    },
  );
  const result = await run(
    ["-w", workspace],
    `/help\n/context\nOlder ${"o".repeat(90000)}\nRecent ${"r".repeat(90000)}\n/compact\n/context\nContinue\nquit\n`,
  );
  expect(result).toMatchObject({ status: 0, stderr: "" });
  expect(result.stdout).toContain("/context - Show active context and token budget");
  expect(result.stdout).toContain("/compact - Summarize older active context");
  expect(result.stdout).toContain("**Active messages:** 0");
  expect(result.stdout).toContain("**Compaction threshold:** 983616");
  expect(result.stdout).toContain("Compacted 2 older messages; 3 active messages remain.");
  expect(result.stdout).toContain("**Active messages:** 3");
  expect(fixture.requests[2].tools).toBeUndefined();
  expect(fixture.requests[3].messages).toEqual([
    { role: "system", content: "Give concise answers." },
    { role: "user", content: expect.stringContaining("Remember Alice.") },
    { role: "user", content: `Recent ${"r".repeat(90000)}` },
    { role: "assistant", content: "Recent answer", reasoning_content: "Recent thinking" },
    { role: "user", content: "Continue" },
  ]);
  const history = await ConversationHistory.open(join(workspace, ".history"));
  const [session] = await history.listSessions();
  expect(await history.getMessages(session.id)).toHaveLength(6);
});

it("reports insufficient context and a summary failure in the CLI while allowing continued chat", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  fixture.responses.push(
    {
      status: 200,
      body: { choices: [{ message: { role: "assistant", content: "Older answer" } }] },
    },
    {
      status: 200,
      body: { choices: [{ message: { role: "assistant", content: "Recent answer" } }] },
    },
    ...unavailableResponses(),
  );
  const result = await run(
    ["-w", workspace],
    `/compact\nOlder ${"o".repeat(90000)}\nRecent ${"r".repeat(90000)}\n/compact\nContinue\nquit\n`,
  );
  expect(result).toMatchObject({ status: 0, stderr: "" });
  expect(result.stdout).toContain("Not enough compactable context");
  expect(result.stdout).toContain("Compaction failed; active context unchanged");
  expect(result.stdout).toContain("helper: Hello!");
  expect(fixture.requests).toHaveLength(6);
  expect(fixture.requests[5].messages).toHaveLength(6);
});

it.each([false, true])(
  "continues CLI chat after automatic compaction (first request exhausts retries: %s)",
  async (fails) => {
    fixture = await chatFixture();
    const workspace = await fixture.workspace(fixture.root, "  context_window: 100000\n");
    fixture.responses.push(
      {
        status: 200,
        body: { choices: [{ message: { role: "assistant", content: "Older answer" } }] },
      },
      {
        status: 200,
        body: {
          choices: [
            {
              message: {
                role: "assistant",
                content: "Recent answer",
                reasoning_content: "Keep thinking",
              },
            },
          ],
          usage: { prompt_tokens: 89000, completion_tokens: 1000, total_tokens: 90000 },
        },
      },
    );
    if (fails) fixture.responses.push(...unavailableResponses());
    fixture.responses.push({
      status: 200,
      body: {
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: "Remember the older objective." },
          },
        ],
      },
    });
    const result = await run(
      ["-w", workspace],
      `Older ${"o".repeat(90000)}\nRecent ${"r".repeat(90000)}\nNext\n${fails ? "Recover\n" : ""}/context\nquit\n`,
    );
    expect(result.status).toBe(0);
    if (fails) expect(result.stderr).toContain("Automatic compaction: Compaction failed");
    else expect(result.stderr).toBe("");
    expect(result.stdout).toContain("helper: Hello!");
    expect(result.stdout).toContain("**Active messages:** 5");
    const next = fixture.requests.at(-1)?.messages;
    expect(next?.[1].content).toContain("Remember the older objective.");
    expect(next?.[3].reasoning_content).toBe("Keep thinking");
    expect(next?.at(-1)?.content).toBe(fails ? "Recover" : "Next");
    const history = await ConversationHistory.open(join(workspace, ".history"));
    const [session] = await history.listSessions();
    const raw = await history.getMessages(session.id);
    expect(raw).toHaveLength(fails ? 7 : 6);
    expect(raw.some((message) => message.content === "Remember the older objective.")).toBe(false);
  },
);

it("cancels an in-flight CLI compaction with Ctrl+C and leaves the original history intact", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  let release = (_value: unknown) => {};
  fixture.responses.push(
    {
      status: 200,
      body: { choices: [{ message: { role: "assistant", content: "Older answer" } }] },
    },
    {
      status: 200,
      body: { choices: [{ message: { role: "assistant", content: "Recent answer" } }] },
    },
    {
      status: 200,
      body: new Promise((resolve) => {
        release = resolve;
      }),
    },
  );
  const child = spawn(process.execPath, [entry, "-w", workspace], { stdio: "pipe" });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text) => {
    stdout += text;
  });
  child.stderr.setEncoding("utf8").on("data", (text) => {
    stderr += text;
  });
  let requests = 0;
  const interruptSummary = () => {
    requests++;
    if (requests === 3) child.kill("SIGINT");
  };
  fixture.server.on("request", interruptSummary);
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once("close", resolve);
      child.once("error", reject);
    });
    child.stdin.end(`Older ${"o".repeat(90000)}\nRecent ${"r".repeat(90000)}\n/compact\n`);
    expect(await closed).toBe(130);
    expect(stdout).toContain("Goodbye!");
    expect(stderr).toBe("");
    const history = await ConversationHistory.open(join(workspace, ".history"));
    const [session] = await history.listSessions();
    expect(await history.getMessages(session.id)).toHaveLength(4);
    expect(fixture.requests).toHaveLength(3);
  } finally {
    clearTimeout(timeout);
    fixture.server.removeListener("request", interruptSummary);
    release({
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Late summary" } }],
    });
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

it("answers through the CLI after a real local Brave search exchange", async () => {
  fixture = await chatFixture();
  const search = await searchFixture();
  try {
    fixture.responses.push({
      status: 200,
      body: toolReply([{ name: "web_search", id: "cli-search", args: { query: "Brave docs" } }]),
    });
    const result = await run(
      ["-w", await fixture.workspace(undefined, search.settings)],
      "Find Brave docs\nquit\n",
    );
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toContain("helper: Hello!");
    expect(search.requests).toHaveLength(1);
    expect(fixture.requests[1].messages.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "cli-search",
      content: JSON.stringify({
        queries: [
          {
            query: "Brave docs",
            provider: "brave",
            results: [
              {
                title: "Brave docs",
                url: "https://example.test/docs",
                snippet: "Search documentation.",
              },
              { title: "Release", url: "https://example.test/news", snippet: "New release." },
            ],
            error: null,
          },
        ],
      }),
    });
  } finally {
    await search.close();
  }
});

it.each(["brave", "serpapi"] as const)(
  "searches and fetches HTTP content before answering through the CLI with %s",
  async (provider) => {
    fixture = await chatFixture();
    const search = await searchFixture(provider);
    const pages = await pageFixture();
    try {
      const url = `${pages.endpoint}/source`;
      search.responses.push({
        status: 200,
        body:
          provider === "brave"
            ? {
                web: { results: [{ title: "Local source", url, description: "Read the source." }] },
              }
            : {
                organic_results: [
                  { title: "Local source", link: url, snippet: "Read the source." },
                ],
              },
      });
      pages.pages.set("/source", {
        body: '<title>Local source</title><p>Readable source content.</p><script>fetch("/data")</script>',
      });
      pages.pages.set("/data", {
        body: "Readable source content.",
        headers: { "Content-Type": "text/plain" },
      });
      fixture.responses.push(
        {
          status: 200,
          body: toolReply([
            { name: "web_search", id: "find-source", args: { query: "local source" } },
          ]),
        },
        {
          status: 200,
          body: toolReply([{ name: "fetch_content", id: "read-source", args: { url } }]),
        },
        {
          status: 200,
          body: {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "The source says: Readable source content.",
                  reasoning_content: "Read the source.",
                },
              },
            ],
          },
        },
      );
      const result = await run(
        ["-w", await fixture.workspace(undefined, `${search.settings}fetch_content: {}\n`)],
        "Find and read the source\nquit\n",
      );
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(result.stdout).toContain("helper: The source says: Readable source content.");
      expect(fixture.requests[1].messages.at(-1)).toMatchObject({
        role: "tool",
        tool_call_id: "find-source",
        content: JSON.stringify({
          queries: [
            {
              query: "local source",
              provider,
              results: [{ title: "Local source", url, snippet: "Read the source." }],
              error: null,
            },
          ],
        }),
      });
      expect(fixture.requests[2].messages.at(-1)).toMatchObject({
        role: "tool",
        tool_call_id: "read-source",
        content: JSON.stringify({
          urls: [
            {
              url,
              finalUrl: url,
              title: "Local source",
              content: "Readable source content.",
              error: null,
              totalChars: 24,
              nextOffset: null,
            },
          ],
        }),
      });
      expect(pages.requests).toEqual(["/source"]);
      expect(search.requests).toHaveLength(1);
      expect(fixture.requests).toHaveLength(3);
      expect(
        fixture.requests[2].messages
          .filter((message) => message.tool_calls)
          .map((message) => message.reasoning_content),
      ).toEqual(["Tool reasoning.", "Tool reasoning."]);
      const history = await ConversationHistory.open(join(fixture.root, ".history"));
      const [session] = await history.listSessions();
      const recorded = await history.getMessages(session.id);
      expect(recorded.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "tool",
        "assistant",
        "tool",
        "assistant",
      ]);
      expect(recorded.filter((message) => message.role === "tool")).toMatchObject(
        fixture.requests[2].messages.filter((message) => message.role === "tool"),
      );
      expect(recorded.at(-1)).toMatchObject({
        content: "The source says: Readable source content.",
        reasoning_content: "Read the source.",
      });
    } finally {
      await pages.close();
      await search.close();
    }
  },
);

it("acknowledges its printed reply and does not replay old pending CLI sessions", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  const old = await fixture.openAgent({ workspace });
  await old.chat("Old question");
  const result = await run(["-w", workspace], "New question\nquit\n");
  expect(result).toMatchObject({ status: 0, stderr: "" });
  expect(result.stdout.match(/helper: Hello!/g)).toHaveLength(1);
  const history = await ConversationHistory.open(join(workspace, ".history"));
  const sessions = await history.listSessions();
  const latest = sessions.find((session) => session.id !== old.sessionId);
  expect(latest).toBeDefined();
  expect(await history.getPendingReplies(latest?.id ?? "")).toEqual([]);
  expect(await history.getPendingReplies(old.sessionId)).toHaveLength(1);
  expect(fixture.requests).toHaveLength(2);
});
