import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Bot, ChatView } from "@mybots/contracts";
import { ProductDatabase } from "@mybots/db";
import { DockerSandbox } from "@mybots/sandbox";
import { expect as browserExpect, chromium } from "@playwright/test";
import { expect, test } from "vitest";
import { type ModelReply, type ModelRequest, startDurableModel } from "../durable-model-fixture.ts";
import { fixtureEnvironment } from "../provider-fixture.ts";

const exec = promisify(execFile);

test("documented startup joins setup, retained preview, steering, Stop and crash recovery across Bots", async () => {
  const root = await mkdtemp(join(tmpdir(), "mybots-runtime-chain-"));
  const replies: (ModelReply | ((request: ModelRequest) => ModelReply))[] = [];
  let release: () => void = () => {};
  let barrier: Promise<void> | undefined;
  let recoveredProcess = "";
  let botId = "";
  let recovering = false;
  const service = await startDurableModel(async (request) => {
    if (barrier) await barrier;
    if (recovering) {
      recoveredProcess = (
        await provider.execute(
          computer,
          'python3 -c \'from pathlib import Path; print(Path("/proc", Path("crash-pid").read_text().strip()).exists())\'',
          `bots/${botId}`,
        )
      ).stdout;
      recovering = false;
    }
    const reply = replies.shift();
    if (!reply) throw new Error("Unexpected model request");
    return typeof reply === "function" ? reply(request) : reply;
  });
  async function start() {
    const environment = fixtureEnvironment(service, true);
    const child = spawn("npm", ["start", "--", "--root", root, "--port", "0"], {
      cwd: new URL("../../", import.meta.url),
      env: {
        ...environment,
        NODE_OPTIONS: `${environment.NODE_OPTIONS?.replaceAll("--conditions=mybots-source", "")} --no-strip-types`,
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let errors = "";
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("close", resolve);
      child.once("error", reject);
    });
    if (child.pid === undefined) throw new Error("Application process did not start");
    const pid = child.pid;
    async function shutdown() {
      if (child.exitCode === null && child.signalCode === null) process.kill(-pid, "SIGTERM");
      const deadline = setTimeout(() => process.kill(-pid, "SIGKILL"), 10000);
      try {
        expect(await exited).toBe(0);
        expect(errors).toBe("");
        expect(() => process.kill(-pid, 0)).toThrow();
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
          throw new Error(`Compiled startup failed: ${errors}`);
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
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const database = new ProductDatabase(join(root, "product.sqlite"));
  const computer = database.computer();
  database.close();
  const provider = new DockerSandbox(computer, join(root, "computer", "workspace"));
  try {
    app = await start();
    const credential = (await readFile(join(root, "client-credential"), "utf8")).trim();
    async function request(path: string, body?: unknown, method = body ? "POST" : "GET") {
      const response = await fetch(new URL(`api/${path}`, app?.url), {
        method,
        headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const value = await response.json();
      expect(response.status, `${path}: ${JSON.stringify(value)}`).toBeLessThan(300);
      return value;
    }
    const chat = (bot: Bot): Promise<ChatView> => request(`bots/${bot.id}/chat`);
    const idle = async (bot: Bot) => {
      await expect.poll(async () => (await chat(bot)).busy, { timeout: 30000 }).toBe(false);
    };
    const send = (bot: Bot, text: string) =>
      request(`bots/${bot.id}/send`, { text, requestId: randomUUID() });
    const file = (bot: Bot, name: string) =>
      provider.readFile(computer, `bots/${bot.id}/${name}`).catch(() => "");
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(app.url);
    await browserExpect(page).toHaveTitle("Mybots");
    await page.getByLabel("Connection credential").fill(credential);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await browserExpect(page.locator("#workspace")).toBeVisible();
    await page.getByRole("button", { name: "Provider settings", exact: true }).click();
    for (const name of ["DeepSeek", "OpenCode Go"]) {
      await page
        .getByLabel(`${name} API key`, { exact: true })
        .fill(`integrated-secret-${name.replaceAll(" ", "")}`);
      await page.getByRole("button", { name: `Save ${name} key`, exact: true }).click();
      await browserExpect(page.getByLabel(`${name} API key`, { exact: true })).toHaveValue("");
      await browserExpect(
        page.locator(name === "DeepSeek" ? "#deepseek-status" : "#opencode-go-status"),
      ).toContainText("Saved locally");
    }
    await page.getByRole("button", { name: "Close providers", exact: true }).click();
    expect(service.requests).toHaveLength(0);
    const alpha: Bot = await request("bots", {
      name: "Builder",
      instructions: "BUILDER_ROLE",
      model: "deepseek/deepseek-flash",
    });
    const beta: Bot = await request("bots", {
      name: "Reader",
      instructions: "READER_ROLE",
      model: "opencode-go/glm-5.3",
    });
    botId = alpha.id;
    await request(
      "skills/preview",
      { description: "Build a shared preview", content: "FULL_PREVIEW_SKILL" },
      "PUT",
    );
    await request("memory/owner", { content: "OWNER_SHARED" }, "PUT");
    await request(`bots/${alpha.id}/memory`, { content: "BUILDER_PRIVATE" }, "PUT");
    await request(`bots/${beta.id}/memory`, { content: "READER_PRIVATE" }, "PUT");
    await page.reload();
    await page.getByRole("button", { name: "Select Builder", exact: true }).click();
    barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    replies.push(
      { tool: "skill_read", arguments: { name: "preview" }, text: "Building the preview." },
      {
        tool: "write_file",
        arguments: {
          path: "shared/index.html",
          content: "<!doctype html><title>Combined preview</title><h1>Shared working file</h1>",
        },
      },
      { tool: "shell", arguments: { cwd: "/shared", command: "cat index.html" } },
      {
        tool: "start_service",
        arguments: { cwd: "/shared", command: "python3 -u -m http.server 8130 --bind 0.0.0.0" },
      },
      (request) => ({
        tool: "preview_service",
        arguments: {
          commandId: JSON.parse(String(request.messages.at(-1)?.content)).commandId,
          port: 8130,
        },
      }),
      (request) => ({
        text: `Shared preview is ready. [Open preview](${String(request.messages.at(-1)?.content)})`,
      }),
    );
    await page.getByLabel("Message", { exact: true }).fill("Build the shared preview");
    await page.getByRole("button", { name: "Send message" }).click();
    await service.waitForRequest();
    await request("providers/deepseek", { apiKey: "integrated-secret-replaced" }, "PUT");
    expect(service.wire[0]?.headers.authorization).toBe("Bearer integrated-secret-DeepSeek");
    barrier = undefined;
    release();
    await expect
      .poll(
        async () =>
          (await provider.listCommands(computer)).find((command) => command.service)?.commandId,
        { timeout: 30000 },
      )
      .toBeTruthy();
    const retained = (await provider.listCommands(computer)).find((command) => command.service);
    if (!retained) throw new Error("Preview service did not start");
    await idle(alpha);
    expect((await chat(alpha)).messages.at(-1)?.text).toContain("Shared preview is ready.");
    const previewUrl = String(service.requests.at(-1)?.messages.at(-1)?.content);
    expect(previewUrl).toMatch(/^http:\/\/[a-f0-9-]+\.localhost:\d+\/$/);
    await browserExpect(
      page.getByRole("link", { name: "Open preview", exact: true }),
    ).toHaveAttribute("href", previewUrl);
    expect(
      service.wire
        .slice(1)
        .every((call) => call.headers.authorization === "Bearer integrated-secret-replaced"),
    ).toBe(true);
    const initialContext = JSON.stringify(service.requests[0]);
    expect(initialContext).toContain("BUILDER_ROLE");
    expect(initialContext).toContain("BUILDER_PRIVATE");
    expect(initialContext).toContain("OWNER_SHARED");
    expect(initialContext).not.toContain("READER_PRIVATE");
    expect(JSON.stringify(service.requests)).toContain("FULL_PREVIEW_SKILL");
    const preview = await page.context().newPage();
    await preview.goto(previewUrl);
    await browserExpect(preview.locator("h1")).toHaveText("Shared working file");
    expect(await preview.evaluate(() => document.cookie)).not.toContain("mybots_connection");
    expect(await preview.locator("body").textContent()).not.toMatch(
      /integrated-secret|mybots_connection/,
    );
    replies.push(
      {
        tool: "shell",
        arguments: {
          command:
            "echo $$ > steer-pid; until [ -f release ]; do sleep 0.05; done; echo once >> effects",
        },
      },
      { tool: "shell", arguments: { command: "echo $$ > stop-pid; while :; do sleep 1; done" } },
    );
    await send(alpha, "Continue the build");
    await expect.poll(() => file(alpha, "steer-pid"), { timeout: 15000 }).not.toBe("");
    await send(alpha, "Steer the current build");
    await provider.writeFile(computer, `bots/${alpha.id}/release`, "go");
    await expect.poll(() => file(alpha, "stop-pid"), { timeout: 15000 }).not.toBe("");
    expect(JSON.stringify(service.requests.at(-1))).toContain("Steer the current build");
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await idle(alpha);
    expect(
      (await provider.execute(computer, "test ! -d /proc/$(cat stop-pid)", `bots/${alpha.id}`))
        .exitCode,
    ).toBe(0);
    await preview.reload();
    await browserExpect(preview.locator("h1")).toHaveText("Shared working file");
    replies.push({
      tool: "shell",
      arguments: {
        command: "echo once >> crash-effects; echo $$ > crash-pid; while :; do sleep 1; done",
      },
    });
    const crashInput = { text: "Crash this work once", requestId: "crash-once" };
    const admitted = await request(`bots/${alpha.id}/send`, crashInput);
    await expect.poll(() => file(alpha, "crash-pid"), { timeout: 15000 }).not.toBe("");
    await writeFile(join(root, "worker-fault"), "hold");
    const worker = Number(
      (await readFile(join(root, "worker-spawns"), "utf8")).trim().split(/\s+/).at(-1),
    );
    process.kill(worker, "SIGKILL");
    await browserExpect(page.locator("#connection")).toContainText("Worker recovering");
    await page.reload();
    await browserExpect(page.locator("#connection")).toContainText("Worker recovering");
    recovering = true;
    replies.push({ text: "Recovered safely; the preview remains available." });
    await writeFile(join(root, "worker-fault"), "");
    await browserExpect(page.locator("#connection")).toHaveText("Worker recovered", {
      timeout: 20000,
    });
    await idle(alpha);
    expect(recoveredProcess).toBe("False\n");
    expect(await file(alpha, "crash-effects")).toBe("once\n");
    expect(await request(`bots/${alpha.id}/send`, crashInput)).toEqual(admitted);
    await page.reload();
    await browserExpect(page.locator("article.assistant").last()).toContainText("Recovered safely");
    expect(
      (await chat(alpha)).messages.filter(
        (message) => message.role === "user" && message.text === "Crash this work once",
      ),
    ).toHaveLength(1);
    replies.push(
      { tool: "read_file", arguments: { path: "shared/index.html" } },
      { text: "Reader used the shared file." },
    );
    await send(beta, "Read the shared preview source");
    await idle(beta);
    expect((await chat(beta)).messages.at(-1)?.text).toBe("Reader used the shared file.");
    const betaContext = JSON.stringify(service.requests.at(-1));
    expect(betaContext).toContain("READER_PRIVATE");
    expect(betaContext).not.toContain("BUILDER_PRIVATE");
    replies.push({
      tool: "shell",
      arguments: {
        command:
          "echo ready > removal-ready; until [ -f removal-release ]; do sleep 0.05; done; echo completed > removal-result",
      },
    });
    await send(alpha, "Finish the command while removing its provider key");
    await expect.poll(() => file(alpha, "removal-ready"), { timeout: 15000 }).toBe("ready\n");
    const callsBeforeRemoval = service.requests.length;
    await request("providers/deepseek", undefined, "DELETE");
    await provider.writeFile(computer, `bots/${alpha.id}/removal-release`, "go");
    await idle(alpha);
    expect(await file(alpha, "removal-result")).toBe("completed\n");
    expect(
      (await chat(alpha)).inputs.some((input) => input.detail?.includes("Provider settings")),
    ).toBe(true);
    expect(service.requests).toHaveLength(callsBeforeRemoval);
    await request("providers/deepseek", { apiKey: "integrated-secret-replaced" }, "PUT");
    replies.push({ status: 401, error: "Rejected integrated-secret-replaced" });
    await send(alpha, "Report authentication failure honestly");
    await idle(alpha);
    expect(
      (await chat(alpha)).inputs.some((input) => input.detail?.includes("authentication")),
    ).toBe(true);
    expect(service.requests).toHaveLength(callsBeforeRemoval + 1);
    expect(JSON.stringify(await chat(alpha))).not.toContain("integrated-secret");
    expect(
      await page.evaluate(() =>
        JSON.stringify({
          local: { ...localStorage },
          session: { ...sessionStorage },
          text: document.body.innerText,
        }),
      ),
    ).not.toContain("integrated-secret");
    await page.screenshot({ path: "/tmp/mybots-runtime-chain-desktop.png", fullPage: true });
    expect(errors).toEqual([]);
    await app.shutdown();
    app = undefined;
    await preview.reload();
    await browserExpect(preview.locator("h1")).toHaveText("Shared working file");
    app = await start();
    expect((await request("bots")).bots).toEqual([alpha, beta]);
    expect(
      (await chat(alpha)).messages.some((message) => message.text.includes("Recovered safely")),
    ).toBe(true);
    expect(JSON.stringify(await chat(alpha))).not.toContain("integrated-secret");
    expect(await request("memory/owner")).toMatchObject({ content: "OWNER_SHARED" });
    expect(await provider.readFile(computer, "shared/index.html")).toContain("Shared working file");
    await provider.cancelCommand(computer, retained.commandId, alpha.id);
    await expect(
      provider.previewService(computer, retained.commandId, 8130, alpha.id),
    ).rejects.toThrow("not running");
  } finally {
    release();
    try {
      await browser?.close();
    } finally {
      try {
        await app?.shutdown();
      } finally {
        try {
          await service.close();
        } finally {
          await exec("docker", ["rm", "-f", computer.id]).catch((error) => {
            if (!String(error).includes("No such container")) throw error;
          });
          await rm(root, { recursive: true, force: true });
        }
      }
    }
  }
});
