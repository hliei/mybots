import { type ChildProcess, fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { sendNewTask, showFeature } from "./navigation.ts";

interface Ready {
  url: string;
  credential: string;
}

test("reset chat background while a Run continues, then select an earlier message", async ({
  page,
}) => {
  const root = await mkdtemp(join(tmpdir(), "mybots-browser-reset-"));
  let child: ChildProcess | undefined;
  let exited: Promise<number | null> | undefined;
  async function start(port = 0): Promise<Ready> {
    const hostProcess = fork(
      fileURLToPath(new URL("../../scripts/client-browser-host.mjs", import.meta.url)),
      [root, String(port)],
      { silent: true },
    );
    child = hostProcess;
    let stderr = "";
    hostProcess.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    exited = new Promise((resolve, reject) => {
      hostProcess.once("exit", resolve);
      hostProcess.once("error", reject);
    });
    return Promise.race([
      new Promise<Ready>((resolve) =>
        hostProcess.once("message", (message) => resolve(message as Ready)),
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
    await page.goto(ready.url);
    await page.getByLabel("Connection credential").fill(ready.credential);
    await page.getByRole("button", { name: "Pair with Host" }).click();
    await expect(page.getByRole("heading", { name: "Personal", exact: true })).toBeVisible();
    await showFeature(page, "chat");
    await page.getByRole("button", { name: "Select Personal", exact: true }).click();
    child?.send("complete");
    await showFeature(page, "chat");
    await page.getByRole("button", { name: "Refresh status" }).click();
    await expect(page.locator("#host-execution")).toContainText("1 acknowledged");
    await showFeature(page, "chat");
    await page.getByLabel("Message", { exact: true }).fill("Hold chat");
    await showFeature(page, "chat");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.locator("#chat-works")).toContainText("Execution: active");
    await expect(page.locator("#chat-works")).toContainText("Captured background boundary: 0");
    await page.evaluate(async () => {
      for (let index = 1; index <= 7; index++) {
        const response = await fetch("/api/bots/personal/thread/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId: `earlier-${index}`, text: `Earlier input ${index}` }),
        });
        if (response.status !== 202) throw new Error("Could not queue earlier work");
      }
    });
    await page.getByRole("button", { name: "Bot menu", exact: true }).click();
    await page.getByRole("button", { name: "Reset chat background", exact: true }).click();
    const confirmation = page.getByRole("dialog", { name: "Reset chat background?" });
    await expect(confirmation).toContainText("future conversational Runs");
    await page.screenshot({ path: "/tmp/mybots-reset-confirmation.png" });
    await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.locator("#selected-chat")).toContainText("Chat background boundary: 0");
    await page.getByRole("button", { name: "Bot menu", exact: true }).click();
    await page.getByRole("button", { name: "Reset chat background", exact: true }).click();
    await confirmation.getByRole("button", { name: "Reset background", exact: true }).click();
    await expect(page.locator("#chat-message")).toContainText("Chat background reset.");
    await expect(page.locator("#selected-chat")).not.toContainText("Chat background boundary: 0");
    await expect(page.locator("#thread-messages")).toContainText("Hold chat");
    await expect(
      page.getByRole("separator", { name: "Current chat background starts here" }),
    ).toBeVisible();
    await expect(page.locator("#chat-works")).toContainText("Execution: active");
    await expect(page.locator("#chat-works")).toContainText("Captured background boundary: 0");
    await page.getByRole("button", { name: "Older originals", exact: true }).click();
    await showFeature(page, "search");
    await page.getByLabel("Search original history").fill("Hold chat");
    await page.getByRole("button", { name: "Search history", exact: true }).click();
    const results = page.getByRole("region", { name: "Conversation search results" });
    await expect(results).toContainText("Hold chat");
    await results.getByRole("button", { name: "Read surrounding originals" }).click();
    await expect(
      page.getByRole("checkbox", { name: "Use in next Run background: Hold chat" }),
    ).not.toBeChecked();
    await page.getByRole("button", { name: "Return to reading position" }).click();
    for (let index = 1; index <= 7; index++) {
      await page
        .getByRole("checkbox", {
          name: `Use in next Run background: Earlier input ${index}`,
          exact: true,
        })
        .check();
    }
    await expect(page.locator("#background-selection")).toContainText("7 of 7");
    await expect(page.locator("#composer-target-label")).toHaveText("New independent task");
    for (const viewport of [
      { width: 1280, height: 900 },
      { width: 1440, height: 900 },
      { width: 1920, height: 1080 },
    ]) {
      await page.setViewportSize(viewport);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: `/tmp/mybots-background-selection-${viewport.width}.png` });
    }

    await expect(
      page.getByRole("checkbox", { name: "Use in next Run background: Hold chat" }),
    ).toBeDisabled();
    for (let index = 1; index <= 7; index++) {
      await page
        .getByRole("checkbox", {
          name: `Use in next Run background: Earlier input ${index}`,
          exact: true,
        })
        .uncheck();
    }
    await page.getByRole("checkbox", { name: "Use in next Run background: Hold chat" }).check();
    await page.getByLabel("Message", { exact: true }).fill("Selected topic");
    await page.getByRole("button", { name: "Return to Thread", exact: true }).click();
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
    await showFeature(page, "chat");
    await page.getByLabel("Message", { exact: true }).fill("Selected topic");
    await showFeature(page, "chat");
    await sendNewTask(page);
    await expect(page.locator("#chat-works")).toContainText("Execution: queued");
    await expect(page.locator("#chat-works")).toContainText("Run background: Hold chat");
    await showFeature(page, "chat");
    await page.getByLabel("Message", { exact: true }).fill("Unselected topic");
    await showFeature(page, "chat");
    await sendNewTask(page);
    const unselected = page.locator("#chat-works article").filter({ hasText: "Unselected topic" });
    await expect(unselected).toContainText("Run background: Selected topic");
    await expect(unselected).not.toContainText("Hold chat");
    await expect(unselected).not.toContainText("Captured background boundary: 0");
    await stop();
    await start(Number(new URL(ready.url).port));
    await page.reload();
    await expect(
      page.getByRole("separator", { name: "Current chat background starts here" }),
    ).toBeVisible();
    await expect(page.locator("#selected-chat")).toContainText("Chat background boundary:");
    await expect(page.locator("#chat-works")).toContainText("Captured background boundary: 0");
    await showFeature(page, "create");
    await page.getByLabel("Bot name").fill("Writer");
    await page.getByLabel("Role instructions").fill("Write reports.");
    await page.getByLabel("Model", { exact: true }).selectOption("deepseek/deepseek-chat");
    await page.getByRole("button", { name: "Create Bot", exact: true }).click();
    await expect(page.locator("#selected-bot")).toContainText("Writer");
    await showFeature(page, "search");
    await page.getByLabel("Search original history").fill("Hold chat");
    await page.getByRole("button", { name: "Search history", exact: true }).click();
    await expect(page.getByRole("region", { name: "Conversation search results" })).toHaveText(
      "No matching originals.",
    );
    await showFeature(page, "chat");
    await page.getByRole("button", { name: "Select Personal", exact: true }).click();
    await showFeature(page, "search");
    await page.getByLabel("Search original history").fill("Hold chat");
    await page.getByRole("button", { name: "Search history", exact: true }).click();
    await page
      .locator("#search-results article")
      .filter({ has: page.getByText("Hold chat", { exact: true }) })
      .getByRole("button", { name: "Read surrounding originals" })
      .click();
    await page
      .getByRole("checkbox", { name: "Use in next Run background: Hold chat", exact: true })
      .check();
    await page.route("**/api/bots/*/thread", (route) => route.abort());
    await showFeature(page, "chat");
    await page.getByRole("button", { name: "Select Writer", exact: true }).click();
    await showFeature(page, "chat");
    await page.getByLabel("Message", { exact: true }).fill("Independent writing");
    const admission = page.waitForResponse((response) => response.url().endsWith("/thread/tasks"));
    await showFeature(page, "chat");
    await sendNewTask(page);
    expect((await admission).status()).toBe(202);
    expect(errors).toEqual([]);
  } finally {
    await stop();
    await rm(root, { recursive: true, force: true });
  }
});
