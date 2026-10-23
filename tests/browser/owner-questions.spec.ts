import { type ChildProcess, fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RunnerMailbox } from "@mybots/mailbox/node";
import { expect, test } from "@playwright/test";
import { showFeature } from "./navigation.ts";

test("answers persistent questions independently from conversation cards across restart", async ({
  page,
}, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), "mybots-question-browser-"));
  let child: ChildProcess | undefined;
  let exited: Promise<number | null> | undefined;
  async function start(port = 0) {
    const process = fork(
      fileURLToPath(new URL("../../scripts/client-browser-host.mjs", import.meta.url)),
      [root, String(port)],
      { silent: true },
    );
    child = process;
    let stderr = "";
    process.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    exited = new Promise<number | null>((resolve, reject) => {
      process.once("exit", resolve);
      process.once("error", reject);
    });
    return Promise.race([
      new Promise<{ url: string; credential: string; sessionId: string }>((resolve) =>
        process.once("message", (message) =>
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
    mailbox.requestHistory({
      id: "browser-style",
      operation: "ask_question",
      incarnation: mailbox.executionIncarnation(),
      input: { requestId: "browser-style", text: "Which style?" },
    });
    await expect
      .poll(() => mailbox.historyResponse("browser-style"))
      .toMatchObject({ result: { state: "pending" } });
    mailbox.requestDurableWait("owner-question");
    await page.goto(ready.url);
    await page.getByLabel("Connection credential").fill(ready.credential);
    await page.getByRole("button", { name: "Pair with Host" }).click();
    await showFeature(page, "chat");
    await page.getByRole("button", { name: "Select Personal" }).click();
    await expect(page.locator("#bots")).toContainText("Needs attention");
    await expect(page.locator("#chat-works")).toContainText("Execution: waiting");
    const cards = page.locator("#work-cards");
    await expect(cards.getByLabel("Answer to Which city?")).toBeVisible();
    await expect(cards.getByLabel("Answer to Which style?")).toBeVisible();
    for (const [width, height] of [
      [1280, 900],
      [1440, 900],
      [1920, 1080],
    ] as const) {
      await page.setViewportSize({ width, height });
      await expect(cards.getByLabel("Answer to Which city?")).toBeVisible();
      await expect(cards.getByLabel("Answer to Which style?")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: testInfo.outputPath(`questions-${width}.png`) });
    }
    await showFeature(page, "tasks");
    await page
      .locator("#chat-works")
      .getByLabel("Answer to Which city?")
      .fill("Draft from Task details");
    await page.getByRole("button", { name: "Close details", exact: true }).click();
    await expect(cards.getByLabel("Answer to Which city?")).toHaveValue("Draft from Task details");
    await cards.getByLabel("Answer to Which city?").fill("Conversation draft");
    await expect(page.locator("#chat-works").getByLabel("Answer to Which city?")).toHaveValue(
      "Conversation draft",
    );
    await expect(cards.getByLabel("Answer to Which style?")).toHaveValue("");
    await cards.getByLabel("Answer to Which style?").fill("Concise");
    await cards
      .locator('[data-question-id="browser-style"]')
      .getByRole("button", { name: "Answer question" })
      .click();
    await expect(cards.locator('[data-question-id="browser-style"]')).toContainText(
      "Owner answer: Concise",
    );
    await expect(cards.getByLabel("Answer to Which city?")).toHaveValue("Conversation draft");
    await page.reload();
    await showFeature(page, "chat");
    await page.getByRole("button", { name: "Select Personal" }).click();
    await expect(cards.getByLabel("Answer to Which city?")).toBeVisible();
    await stop();
    await start(Number(new URL(ready.url).port));
    await page.reload();
    await showFeature(page, "chat");
    await page.getByRole("button", { name: "Select Personal" }).click();
    let dropped = false;
    await page.route("**/questions/browser-city/answer", async (route) => {
      if (dropped) {
        await route.continue();
        return;
      }
      dropped = true;
      const response = await route.fetch();
      expect(response.status()).toBe(202);
      await route.abort("failed");
    });
    await cards.getByLabel("Answer to Which city?").fill("Hangzhou");
    await cards.getByRole("button", { name: "Answer question", exact: true }).click();
    await expect(page.locator("#chat-message")).toContainText("response unconfirmed");
    await page.reload();
    await showFeature(page, "chat");
    await page.getByRole("button", { name: "Select Personal" }).click();
    await showFeature(page, "chat");
    await page.getByRole("button", { name: "Retry chat request", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Retry chat request", exact: true }),
    ).toBeHidden();
    await expect(page.locator("#chat-works")).toContainText("Owner answer: Hangzhou");
    await expect(cards).toContainText("Owner answer: Hangzhou");
    await expect(cards).toContainText("Owner answer: Concise");
    await expect(cards.getByRole("button", { name: "Answer question" })).toHaveCount(0);
    child?.send("complete");
    await expect(page.locator("#chat-works")).toContainText("Execution: succeeded");
    await expect(page.locator("#chat-works")).toContainText(`Run ID: ${ready.sessionId}`);
    expect(errors).toEqual([]);
  } finally {
    if (child) await stop();
    await rm(root, { recursive: true, force: true });
  }
});
