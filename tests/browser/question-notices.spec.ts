import { type ChildProcess, fork } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RunnerMailbox } from "@mybots/mailbox/node";
import { expect, test } from "@playwright/test";
import { showFeature } from "./navigation.ts";

test("repairs a Bot topic and resends the question notice without changing the Run", async ({
  page,
}) => {
  const root = await mkdtemp(join(tmpdir(), "mybots-notice-browser-"));
  let child: ChildProcess | undefined;
  let exited: Promise<number | null> | undefined;
  async function start(port = 0) {
    const childProcess = fork(
      fileURLToPath(new URL("../../scripts/client-browser-host.mjs", import.meta.url)),
      [root, String(port)],
      { silent: true, env: { ...process.env, MYBOTS_TELEGRAM_FIXTURE: "1" } },
    );
    child = childProcess;
    let stderr = "";
    childProcess.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    exited = new Promise<number | null>((resolve, reject) => {
      childProcess.once("exit", resolve);
      childProcess.once("error", reject);
    });
    return Promise.race([
      new Promise<{ url: string; credential: string; sessionId: string }>((resolve) =>
        childProcess.once("message", (message) =>
          resolve(message as { url: string; credential: string; sessionId: string }),
        ),
      ),
      exited.then(() => {
        throw new Error(`Browser Host stopped before ready: ${stderr}`);
      }),
    ]);
  }
  async function stop() {
    child?.kill("SIGTERM");
    expect(await exited).toBe(0);
    child = undefined;
  }
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const ready = await start();
    const mailbox = new RunnerMailbox(join(root, "data", "sessions", "personal", ready.sessionId));
    mailbox.requestHistory({
      id: "browser-city",
      operation: "ask_question",
      incarnation: mailbox.executionIncarnation(),
      input: { requestId: "browser-city", text: "Which city?" },
    });
    await expect
      .poll(() => mailbox.historyResponse("browser-city"))
      .toMatchObject({ result: { state: "pending" } });
    mailbox.requestDurableWait("owner-question");
    await page.goto(ready.url);
    await page.getByLabel("Connection credential").fill(ready.credential);
    await page.getByRole("button", { name: "Pair with Host" }).click();
    await showFeature(page, "chat");
    await page.getByRole("button", { name: "Select Personal" }).click();
    const works = page.locator("#chat-works");
    await expect(works).toContainText("Execution: waiting");
    await expect(works).toContainText("Telegram topic: repairable");
    await expect(works).toContainText("Private topic mode is unavailable.");
    await expect(works).toContainText("Telegram notice: failed · 0 of 3 attempts");
    await expect(works).toContainText(
      `Local client: /?bot=personal&run=${ready.sessionId}#question-browser-city`,
    );
    child?.send("telegram-mode:ready");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Connection", exact: true }).click();
    await page.getByRole("button", { name: "Open notification details", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeHidden();
    await page.getByRole("button", { name: "Repair Telegram topic" }).click();
    await expect(works).toContainText("Telegram topic: mapped · 71");
    await expect(works).toContainText("Telegram topic: mapped");
    await showFeature(page, "tasks");
    await page.getByRole("button", { name: "Resend Telegram notice" }).click();
    await expect(works).toContainText("Telegram notice: delivered · 1 of 3 attempts");
    await expect(works).toContainText("This is not a read receipt");
    await expect(works).toContainText("Bot: personal · Task:");
    await expect(works).toContainText(`Run: ${ready.sessionId} · Request: browser-city`);
    await expect(works).toContainText("Execution: waiting");
    const sent = JSON.parse(await readFile(join(root, "data", "telegram-sends.json"), "utf8")) as {
      method: string;
      text?: string;
      topicId?: string;
    }[];
    const notice = sent.find((entry) => entry.method === "sendMessage");
    expect(notice?.topicId).toBe("71");
    expect(notice?.text).toContain("Bot: Personal (personal)");
    expect(notice?.text).toContain(`Run: ${ready.sessionId}`);
    expect(notice?.text).toContain("Request: browser-city");
    expect(notice?.text).toContain("Which city?");
    const locator = notice?.text?.match(/Local client: (.+)/)?.[1];
    expect(locator).toBeTruthy();
    await page.evaluate(() => localStorage.removeItem("mybots.selected-bot"));
    await page.goto(new URL(locator as string, ready.url).href);
    await expect(page.locator('#chat-works [data-question-id="browser-city"]')).toBeFocused();
    await expect(works).toContainText("Question: Which city?");
    const beforeRestart = sent.length;
    await stop();
    await start(Number(new URL(ready.url).port));
    await page.reload();
    await showFeature(page, "chat");
    await page.getByRole("button", { name: "Select Personal" }).click();
    await expect(works).toContainText("Telegram notice: delivered · 1 of 3 attempts");
    await expect(works).toContainText("Execution: waiting");
    expect(
      JSON.parse(await readFile(join(root, "data", "telegram-sends.json"), "utf8")),
    ).toHaveLength(beforeRestart);
    expect(errors).toEqual([]);
  } finally {
    if (child) await stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("inspects and resends a Routine outcome notice and follows its work locator", async ({
  page,
}) => {
  const root = await mkdtemp(join(tmpdir(), "mybots-outcome-browser-"));
  const child = fork(
    fileURLToPath(new URL("../../scripts/client-browser-host.mjs", import.meta.url)),
    [root, "0"],
    {
      silent: true,
      env: { ...process.env, MYBOTS_TELEGRAM_FIXTURE: "1" },
    },
  );
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  const ready = await Promise.race([
    new Promise<{ url: string; credential: string }>((resolve) =>
      child.once("message", (message) => resolve(message as { url: string; credential: string })),
    ),
    exited.then(() => {
      throw new Error("Browser Host stopped before ready");
    }),
  ]);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const response = await page.request.post(`${ready.url}/api/bots/personal/routines`, {
      headers: { Authorization: `Bearer ${ready.credential}` },
      data: {
        requestId: "browser-routine",
        text: "Check archive",
        runAt: new Date().toISOString(),
        timezone: "UTC",
      },
    });
    expect(response.status()).toBe(201);
    const routine = await response.json();
    child.send("complete");
    await page.goto(ready.url);
    await page.getByLabel("Connection credential").fill(ready.credential);
    await page.getByRole("button", { name: "Pair with Host" }).click();
    await showFeature(page, "chat");
    await page.getByRole("button", { name: "Select Personal" }).click();
    const works = page.locator("#chat-works");
    await expect(works).toContainText(`Routine: ${routine.id}`);
    await expect(works).toContainText("Work succeeded.");
    await expect(works).toContainText("Telegram notice: failed");
    child.send("telegram-mode:ready");
    await showFeature(page, "tasks");
    await page.getByRole("button", { name: "Repair Telegram topic" }).click();
    await expect(works).toContainText("Telegram topic: mapped");
    await showFeature(page, "tasks");
    await page.getByRole("button", { name: "Resend Telegram notice" }).click();
    await expect(works).toContainText("Telegram notice: delivered · 1 of 3 attempts");
    await expect(works).toContainText("This is not a read receipt");
    const sent = JSON.parse(await readFile(join(root, "data", "telegram-sends.json"), "utf8")) as {
      method: string;
      text?: string;
    }[];
    const text = sent.find((row) => row.method === "sendMessage")?.text;
    const locator = text?.match(/Local client: (.+)/)?.[1];
    expect(locator).toBeTruthy();
    await page.goto(new URL(locator as string, ready.url).href);
    await expect(
      page.locator("#chat-works [data-task-id]").filter({ hasText: `Routine: ${routine.id}` }),
    ).toBeFocused();
    const headers = { Authorization: `Bearer ${ready.credential}` };
    async function post(path: string, data: unknown) {
      const response = await page.request.post(`${ready.url}${path}`, { headers, data });
      expect(response.ok()).toBe(true);
      return response.json();
    }
    const specialist = (
      await post("/api/bots", {
        requestId: "specialist",
        name: "Specialist",
        instructions: "Analyze",
        model: { provider: "deepseek", id: "deepseek-chat" },
        tools: ["read"],
      })
    ).bot.id;
    const reviewer = (
      await post("/api/bots", {
        requestId: "reviewer",
        name: "Reviewer",
        instructions: "Review",
        model: { provider: "deepseek", id: "deepseek-chat" },
        tools: ["read"],
      })
    ).bot.id;
    await post(`/api/bots/personal/collaboration/${specialist}`, {
      requestId: "grant-specialist",
      mode: "allow",
    });
    await post(`/api/bots/${specialist}/collaboration/${reviewer}`, {
      requestId: "ask-reviewer",
      mode: "ask-each-time",
    });
    const source = await post("/api/bots/personal/thread/messages", {
      requestId: "source",
      text: "Hold slot",
    });
    const parentMailbox = new RunnerMailbox(
      join(root, "data", "sessions", "personal", source.runId),
    );
    await expect.poll(() => parentMailbox.executionIncarnation()).toBeGreaterThan(0);
    parentMailbox.requestHistory({
      id: "delegate-specialist",
      operation: "delegate",
      incarnation: parentMailbox.executionIncarnation(),
      input: { requestId: "delegate-specialist", targetBotId: specialist, text: "Hold slot" },
    });
    await expect
      .poll(() => parentMailbox.historyResponse("delegate-specialist"))
      .toMatchObject({ result: { state: "pending" } });
    const childRunId = (
      parentMailbox.historyResponse("delegate-specialist")?.result as { childRunId: string }
    )?.childRunId;
    parentMailbox.requestDurableWait("delegation");
    const worker = new RunnerMailbox(join(root, "data", "sessions", specialist, childRunId));
    await expect.poll(() => worker.executionIncarnation()).toBeGreaterThan(0);
    worker.requestHistory({
      id: "review",
      operation: "delegate",
      incarnation: worker.executionIncarnation(),
      input: { requestId: "review", targetBotId: reviewer, text: "Check analysis" },
    });
    await expect
      .poll(() => worker.historyResponse("review"))
      .toMatchObject({ result: { state: "pending", approval: { state: "pending" } } });
    worker.requestDurableWait("delegation");
    const approvalLocator = `/?bot=${specialist}&run=${childRunId}#approval-review`;
    await page.goto(new URL(approvalLocator, ready.url).href);
    const approval = page.locator('#chat-works [data-approval-id="review"]');
    await expect(approval).toBeFocused();
    await expect(works).toContainText("Notice: approval");
    await expect(works).toContainText("Telegram notice: delivered");
    await expect(works.getByRole("link", { name: /Source Bot: personal/ })).toHaveAttribute(
      "href",
      `/?bot=personal&run=${source.runId}#task-${source.taskId}`,
    );
    await showFeature(page, "tasks");
    await approval.getByRole("button", { name: "Deny action" }).click();
    await expect(works).toContainText("Owner decision: deny");
    await works.getByRole("link", { name: /Source Bot: personal/ }).click();
    await expect(page.locator(`#chat-works [data-task-id="${source.taskId}"]`)).toBeFocused();
    expect(errors).toEqual([]);
  } finally {
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
    await rm(root, { recursive: true, force: true });
  }
});
