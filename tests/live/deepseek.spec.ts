import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Bot, ChatView } from "@mybots/contracts";
import { ProductDatabase } from "@mybots/db";
import { DockerSandbox } from "@mybots/sandbox";
import { expect, test } from "@playwright/test";

const exec = promisify(execFile);

test("DeepSeek streams, uses tools and retains a preview through Stop and reopen", async ({
  page,
  context,
}, testInfo) => {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("Set DEEPSEEK_API_KEY for explicitly authorized live acceptance");
  if (process.env.MYBOTS_PROVIDER_FIXTURE || process.env.NODE_OPTIONS)
    throw new Error("Run live acceptance without provider fixtures or NODE_OPTIONS");
  const root = await mkdtemp(join(tmpdir(), "mybots-live-deepseek-"));
  const observations = join(root, "observations.jsonl");
  const database = new ProductDatabase(join(root, "product.sqlite"));
  const computer = database.computer();
  database.close();
  const provider = new DockerSandbox(computer, join(root, "computer", "workspace"));
  const environment = { ...process.env };
  delete environment.DEEPSEEK_API_KEY;
  delete environment.OPENCODE_API_KEY;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  async function start() {
    const child = spawn("npm", ["start", "--", "--root", root, "--port", "0"], {
      cwd: new URL("../../", import.meta.url),
      detached: true,
      env: {
        ...environment,
        NODE_OPTIONS: `--import=${fileURLToPath(new URL("deepseek-observer.mjs", import.meta.url))}`,
        MYBOTS_LIVE_OBSERVATIONS: observations,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("close", resolve);
      child.once("error", reject);
    });
    if (child.pid === undefined) throw new Error("Application did not start");
    const pid = child.pid;
    child.stderr.resume();
    async function shutdown() {
      if (child.exitCode === null && child.signalCode === null) process.kill(-pid, "SIGTERM");
      const deadline = setTimeout(() => process.kill(-pid, "SIGKILL"), 10000);
      try {
        expect(await exited).toBe(0);
      } finally {
        clearTimeout(deadline);
      }
    }
    const deadline = setTimeout(() => process.kill(-pid, "SIGKILL"), 15000);
    try {
      const url = await Promise.race([
        new Promise<string>((resolve) => {
          let output = "";
          child.stdout.on("data", (chunk) => {
            output += chunk;
            const match = output.match(/Local chat on (http:\/\/\S+)/u);
            if (match) resolve(match[1]);
          });
        }),
        exited.then(() => {
          throw new Error("Compiled startup failed");
        }),
      ]);
      return { url, shutdown };
    } catch (error) {
      await shutdown();
      throw error;
    } finally {
      clearTimeout(deadline);
    }
  }
  let app: Awaited<ReturnType<typeof start>> | undefined;
  try {
    app = await start();
    const credential = (await readFile(join(root, "client-credential"), "utf8")).trim();
    async function request<T>(path: string): Promise<T> {
      const response = await fetch(new URL(`api/${path}`, app?.url), {
        headers: { Authorization: `Bearer ${credential}` },
        signal: AbortSignal.timeout(10000),
      });
      expect(response.ok).toBe(true);
      return response.json();
    }
    await page.goto(app.url);
    await page.getByLabel("Connection credential").fill(credential);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("button", { name: "Provider settings", exact: true }).click();
    await page.getByLabel("DeepSeek API key", { exact: true }).fill(key);
    await page.getByRole("button", { name: "Save DeepSeek key", exact: true }).click();
    await expect(page.locator("#deepseek-status")).toContainText("Saved locally");
    expect((await page.getByLabel("DeepSeek API key", { exact: true }).inputValue()).length).toBe(
      0,
    );
    expect(await readFile(observations, "utf8").catch(() => "")).toBe("");
    await page.getByRole("button", { name: "Close providers", exact: true }).click();
    await page.getByRole("button", { name: "Create Bot", exact: true }).click();
    await page.getByLabel("Bot name", { exact: true }).fill("DeepSeek acceptance");
    await expect(page.getByLabel("Model", { exact: true })).toHaveValue("deepseek/deepseek-flash");
    await page.getByRole("button", { name: "Save Bot", exact: true }).click();
    const bot = (await request<{ bots: Bot[] }>("bots")).bots[0];
    const chat = () => request<ChatView>(`bots/${bot.id}/chat`);
    async function send(text: string) {
      await page.getByLabel("Message", { exact: true }).fill(text);
      await page.getByRole("button", { name: "Send message" }).click();
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
    }
    async function idle() {
      await expect.poll(async () => (await chat()).busy, { timeout: 120000 }).toBe(false);
    }
    await send(
      "Without tools, explain in about 150 words why 42 times 17 is 714. Start with STREAM_OK and end with CHAT_DONE.",
    );
    await expect(page.locator('[data-message-id="partial"]')).toContainText("STREAM_OK", {
      timeout: 90000,
    });
    await idle();
    await expect(page.locator("article.assistant").last()).toContainText("CHAT_DONE");
    await send(
      "Build a tiny local preview using only Computer tools. First narrate your plan. " +
        "Use the exact tool paths below: tool cwd is workspace-relative, so never prefix it with /workspace. " +
        "Use write_file to create shared/live-preview/index.html with title Live acceptance and h1 DeepSeek acceptance 714. " +
        "Use shell to read that file and independently calculate 42*17 in Python. " +
        "Use start_service with cwd /shared/live-preview to run python3 -u -m http.server 8137 --bind 0.0.0.0. " +
        "Call preview_service with its commandId and port 8137. Leave this service running. " +
        "The checked preview URL is for the host browser; do not curl it from the Computer or add unrelated checks. " +
        "Finish with PREVIEW_DONE and a Markdown link named Open live preview using exactly the checked URL.",
    );
    await expect
      .poll(async () => (await chat()).messages.some((m) => m.tools.length > 0), {
        timeout: 90000,
      })
      .toBe(true);
    await idle();
    const built = await chat();
    const tools = built.messages.flatMap((message) => message.tools);
    for (const name of ["write_file", "shell", "start_service", "preview_service"])
      expect(tools).toContain(name);
    await expect(page.locator("article.assistant").last()).toContainText("PREVIEW_DONE");
    expect(await provider.readFile(computer, "shared/live-preview/index.html")).toContain(
      "DeepSeek acceptance 714",
    );
    const retained = (await provider.listCommands(computer)).find((command) => command.service);
    if (!retained) throw new Error("Model did not start the preview service");
    expect(retained.running).toBe(true);
    const link = page.getByRole("link", { name: "Open live preview", exact: true });
    const previewUrl = await link.getAttribute("href");
    expect(previewUrl).toMatch(/^http:\/\/[a-f0-9-]+\.localhost:\d+\/$/);
    const preview = await context.newPage();
    await preview.goto(previewUrl as string);
    await expect(preview.locator("h1")).toHaveText("DeepSeek acceptance 714");
    expect(await preview.evaluate(() => document.cookie)).not.toContain("mybots_connection");
    await send(
      "Use shell exactly once to run: echo $$ > live-stop-pid; echo LIVE_WORK_STARTED; sleep 120; echo UNEXPECTED_FINISH. " +
        "Do not stop the existing preview service. I will press Stop while this command runs.",
    );
    await expect
      .poll(() => provider.readFile(computer, `bots/${bot.id}/live-stop-pid`).catch(() => ""), {
        timeout: 90000,
      })
      .not.toBe("");
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await idle();
    expect(
      (await provider.execute(computer, "test ! -d /proc/$(cat live-stop-pid)", `bots/${bot.id}`))
        .exitCode,
    ).toBe(0);
    await preview.reload();
    await expect(preview.locator("h1")).toHaveText("DeepSeek acceptance 714");
    await app.shutdown();
    app = undefined;
    await preview.reload();
    await expect(preview.locator("h1")).toHaveText("DeepSeek acceptance 714");
    app = await start();
    await page.goto(app.url);
    await expect(page.locator("article.assistant")).toContainText(["CHAT_DONE", "PREVIEW_DONE"]);
    expect((await request<{ bots: Bot[] }>("bots")).bots[0]).toEqual(bot);
    const reopened = await chat();
    expect(reopened.messages.filter((message) => message.role === "user")).toHaveLength(3);
    const storage = await page.evaluate(() =>
      JSON.stringify({
        local: { ...localStorage },
        session: { ...sessionStorage },
        text: document.body.innerText,
      }),
    );
    expect(storage.includes(key)).toBe(false);
    expect(JSON.stringify(reopened).includes(key)).toBe(false);
    await preview.reload();
    await expect(preview.locator("h1")).toHaveText("DeepSeek acceptance 714");
    const wire = (await readFile(observations, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const requests = wire.filter((entry) => entry.event === "request");
    expect(requests.length).toBeLessThanOrEqual(16);
    expect(requests.every((entry) => entry.model === "deepseek-flash" && entry.stream)).toBe(true);
    expect(requests[0].thinking).toEqual({ type: "enabled" });
    expect(requests.some((entry) => entry.toolResults > 0 && entry.previousReasoning)).toBe(true);
    expect(
      wire.some((entry) => entry.event === "delta" && entry.field === "reasoning_content"),
    ).toBe(true);
    expect(wire.some((entry) => entry.event === "delta" && entry.field === "tool_calls")).toBe(
      true,
    );
    expect(
      wire.filter((entry) => entry.event === "response").every((entry) => entry.status === 200),
    ).toBe(true);
    expect(errors).toEqual([]);
    await provider.cancelCommand(computer, retained.commandId, bot.id);
    await expect(
      provider.previewService(computer, retained.commandId, 8137, bot.id),
    ).rejects.toThrow("not running");
    const evidence = {
      revision: (await exec("git", ["rev-parse", "HEAD"])).stdout.trim(),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      provider: "deepseek",
      model: "deepseek-flash",
      protocol: "openai-completions",
      requests: requests.length,
      thinking: requests[0].thinking,
      reasoningEffort: requests[0].reasoningEffort,
      checks: [
        "Web setup",
        "visible streaming",
        "reasoning with tools",
        "file effects",
        "host preview",
        "Stop",
        "app exit/reopen",
        "history",
        "stale preview",
      ],
      unperformed: ["OpenCode Go", "other DeepSeek models", "live worker SIGKILL"],
    };
    await testInfo.attach("sanitized-evidence", {
      body: JSON.stringify(evidence, null, 2),
      contentType: "application/json",
    });
    console.info(JSON.stringify(evidence));
  } finally {
    try {
      await app?.shutdown();
    } finally {
      try {
        await exec("docker", ["rm", "-f", computer.id]).catch((error) => {
          if (!String(error).includes("No such container")) throw error;
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
});
