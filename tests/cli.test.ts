import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { chatFixture } from "./chat-fixture.ts";

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
