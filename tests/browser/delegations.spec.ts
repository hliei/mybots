import { type ChildProcess, fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RunnerMailbox } from "@mybots/mailbox/node";
import { expect, test } from "@playwright/test";
import { showFeature } from "./navigation.ts";

for (const action of ["allow", "approve", "deny", "expire"] as const) {
  test(`shows ${action} delegation after reload and Host restart`, async ({ page }) => {
    const root = await mkdtemp(join(tmpdir(), "mybots-delegation-browser-"));
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
      const created = await page.request.post(`${ready.url}/api/bots`, {
        headers: {
          Authorization: `Bearer ${ready.credential}`,
          "Content-Type": "application/json",
        },
        data: {
          requestId: "browser-writer",
          name: "Writer",
          instructions: "Write the supplied text.",
          model: { provider: "deepseek", id: "deepseek-chat" },
          tools: ["read"],
        },
      });
      expect(created.status()).toBe(201);
      const writerId = ((await created.json()) as { bot: { id: string } }).bot.id;
      await page.goto(ready.url);
      await page.getByLabel("Connection credential").fill(ready.credential);
      await page.getByRole("button", { name: "Pair with Host" }).click();
      await showFeature(page, "chat");
      await page.getByRole("button", { name: "Select Personal" }).click();
      await expect(page.getByLabel("Target Bot")).toContainText("deny");
      await showFeature(page, "Collaboration");
      await page.getByLabel("Target Bot").selectOption(writerId);
      await showFeature(page, "Collaboration");
      await page
        .getByLabel("Permission")
        .selectOption(action === "allow" ? "allow" : "ask-each-time");
      await showFeature(page, "Collaboration");
      await page.getByRole("button", { name: "Save delegation permission" }).click();
      await expect(page.locator("#collaboration-notice")).toContainText(
        `Delegation from this Bot to ${writerId} is ${action === "allow" ? "allow" : "ask-each-time"}.`,
      );
      const mailbox = new RunnerMailbox(
        join(root, "data", "sessions", "personal", ready.sessionId),
      );
      mailbox.requestHistory({
        id: "browser-child",
        operation: "delegate",
        incarnation: mailbox.executionIncarnation(),
        input: {
          requestId: "browser-child",
          targetBotId: writerId,
          text: "Selected browser text",
          ...(action === "expire" ? { deadline: new Date(Date.now() + 60_000).toISOString() } : {}),
        },
      });
      await expect
        .poll(() => mailbox.historyResponse("browser-child"))
        .toMatchObject({ result: { state: "pending" } });
      mailbox.requestDurableWait("delegation");
      await expect(page.locator("#chat-works")).toContainText("Execution: waiting");
      await expect(page.locator("#chat-works")).toContainText("Selected browser text");
      await expect(page.locator("#chat-works")).toContainText(writerId);
      await page.reload();
      await showFeature(page, "chat");
      await page.getByRole("button", { name: "Select Personal" }).click();
      await expect(page.locator("#chat-works")).toContainText("Delegation browser-child");
      if (action === "allow") {
        await showFeature(page, "chat");
        await page.getByRole("button", { name: "Select Writer" }).click();
        await expect(page.locator("#chat-works")).toContainText("Origin: delegation");
      } else {
        const card = page.locator('#work-cards [data-approval-id="browser-child"]');
        await expect(card).toContainText("Operation: delegate");
        await expect(card).toContainText("Target Bot: Writer");
        await expect(card).not.toContainText(writerId);
        await expect(card).toContainText("Inputs: Selected browser text");
        await showFeature(page, "tasks");
        await expect(card.getByRole("button", { name: "Approve action" })).toBeVisible();
      }
      await stop();
      await start(Number(new URL(ready.url).port));
      await page.reload();
      await showFeature(page, "chat");
      await page.getByRole("button", { name: "Select Personal" }).click();
      if (action !== "allow") {
        const card = page.locator('#work-cards [data-approval-id="browser-child"]');
        await expect(card).toContainText("pending");
        if (action === "expire") {
          child?.send("exhaust-budget");
          await expect(card).toContainText("Approval expired without executing");
          await expect(card.getByRole("button", { name: "Approve action" })).toHaveCount(0);
        } else {
          if (action === "approve") {
            // The decision applies, but the browser loses the reply and retries after reload.
            await page.route(
              "**/approvals/browser-child/decision",
              async (route) => {
                await route.fetch();
                await route.abort("failed");
              },
              { times: 1 },
            );
          }
          await showFeature(page, "tasks");
          await card
            .getByRole("button", { name: action === "approve" ? "Approve action" : "Deny action" })
            .click();
          if (action === "approve") {
            await expect(page.locator("#chat-message")).toContainText("unconfirmed");
            await page.reload();
            await showFeature(page, "chat");
            await page.getByRole("button", { name: "Select Personal" }).click();
            await showFeature(page, "chat");
            await page.getByRole("button", { name: "Retry chat request" }).click();
          }
          await expect(card).toContainText(`Owner decision: ${action}`);
          await expect(card).toContainText(action === "approve" ? "executed" : "denied");
        }
      }
      await showFeature(page, "chat");
      await page.getByRole("button", { name: "Select Writer" }).click();
      if (action === "allow" || action === "approve") {
        await expect(page.locator("#chat-works")).toContainText("Origin: delegation");
        await expect(page.locator("#chat-works")).toContainText("Child Task");
        await expect(page.locator('[data-delegation-id="browser-child"]')).toHaveCount(1);
        const card = page.locator("#work-cards article").first();
        await expect(card).toContainText("Delegation");
        if (action === "approve") {
          await card.getByRole("button", { name: "Add instructions", exact: true }).click();
          const taskId = await page.getByLabel("Input target").inputValue();
          await page.getByLabel("Message", { exact: true }).fill("Only this delegated Task");
          const admitted = page.waitForResponse((response) =>
            response.url().endsWith(`/tasks/${taskId}/inputs`),
          );
          await page.getByRole("button", { name: "Send message", exact: true }).click();
          expect(await (await admitted).json()).toMatchObject({ taskId });
          await expect(page.locator("#chat-works")).toContainText("Only this delegated Task");
        }
      } else {
        await expect(page.locator("#chat-works")).not.toContainText("Origin: delegation");
      }
      expect(errors).toEqual([]);
    } finally {
      if (child) await stop();
      await rm(root, { recursive: true, force: true });
    }
  });
}
