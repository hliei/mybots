import { type ChildProcess, fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HostMailbox, RunnerMailbox } from "@mybots/mailbox/node";
import { expect, test } from "@playwright/test";

for (const outcome of ["cancel", "uncertain"] as const) {
  test(`shows two delegation levels after restart and handles ${outcome} work`, async ({
    page,
  }) => {
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
      const reviewerResponse = await page.request.post(`${ready.url}/api/bots`, {
        headers: {
          Authorization: `Bearer ${ready.credential}`,
          "Content-Type": "application/json",
        },
        data: {
          requestId: "browser-reviewer",
          name: "Reviewer",
          instructions: "Review selected text.",
          model: { provider: "deepseek", id: "deepseek-chat" },
          tools: ["read"],
        },
      });
      expect(reviewerResponse.status()).toBe(201);
      const reviewerId = (await reviewerResponse.json()).bot.id as string;
      await page.goto(ready.url);
      await page.getByLabel("Connection credential").fill(ready.credential);
      await page.getByRole("button", { name: "Pair with Host" }).click();
      await page.getByRole("button", { name: "Select Personal" }).click();
      await expect(page.getByLabel("Target Bot")).toContainText("deny");
      await page.getByLabel("Target Bot").selectOption(writerId);
      await page.getByLabel("Permission").selectOption("allow");
      await page.getByRole("button", { name: "Save delegation permission" }).click();
      await expect(page.locator("#collaboration-notice")).toContainText(
        `Delegation from this Bot to ${writerId} is allow.`,
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
        },
      });
      await expect
        .poll(() => mailbox.historyResponse("browser-child"))
        .toMatchObject({ result: { state: "pending" } });
      const delegation = mailbox.historyResponse("browser-child")?.result as { childRunId: string };
      mailbox.requestDurableWait("delegation");
      await expect(page.locator("#chat-works")).toContainText("Execution: waiting");
      await expect(page.locator("#chat-works")).toContainText("Selected browser text");
      await expect(page.locator("#chat-works")).toContainText(writerId);
      await page.reload();
      await page.getByRole("button", { name: "Select Personal" }).click();
      await expect(page.locator("#chat-works")).toContainText("Delegation browser-child");
      await page.getByRole("button", { name: "Select Writer" }).click();
      await expect(page.locator("#chat-works")).toContainText("Origin: delegation");
      await expect(page.locator("#chat-works")).toContainText("Selected browser text");
      await page.getByLabel("Target Bot").selectOption(reviewerId);
      await page.getByLabel("Permission").selectOption("allow");
      await page.getByRole("button", { name: "Save delegation permission" }).click();
      await expect(page.locator("#collaboration-notice")).toContainText(
        `Delegation from this Bot to ${reviewerId} is allow.`,
      );
      const childMailbox = new RunnerMailbox(
        join(root, "data", "sessions", writerId, delegation.childRunId),
      );
      await expect.poll(() => childMailbox.executionIncarnation()).toBeGreaterThan(0);
      childMailbox.requestHistory({
        id: "browser-review",
        operation: "delegate",
        incarnation: childMailbox.executionIncarnation(),
        input: {
          requestId: "browser-review",
          targetBotId: reviewerId,
          text: "Hold slot",
        },
      });
      await expect
        .poll(() => childMailbox.historyResponse("browser-review"))
        .toMatchObject({ result: { state: "pending", originatingRunId: ready.sessionId } });
      const review = childMailbox.historyResponse("browser-review")?.result as {
        childRunId: string;
      };
      childMailbox.requestDurableWait("delegation");
      await expect(page.locator("#chat-works")).toContainText("Execution: waiting");
      await expect(page.locator('[data-delegation-id="browser-review"]')).toContainText(
        `Originating Run ${ready.sessionId}`,
      );
      await page.getByRole("button", { name: "Select Reviewer" }).click();
      await expect(page.locator("#chat-works")).toContainText("Hold slot");
      await stop();
      await start(Number(new URL(ready.url).port));
      await page.reload();
      await page.getByRole("button", { name: "Select Writer" }).click();
      await expect(page.locator("#chat-works")).toContainText("Execution: waiting");
      await expect(page.locator("#chat-works")).toContainText("Delegation browser-review");
      await page.locator("#chat-works").screenshot({
        path: join(tmpdir(), "mybots-nested-delegation.png"),
      });
      await expect(page.locator("#chat-works")).toContainText("Origin: delegation");
      if (outcome === "cancel") {
        await page.getByRole("button", { name: "Select Personal" }).click();
        await page.getByRole("button", { name: "Stop run", exact: true }).click();
        await expect(page.locator("#chat-works")).toContainText("Execution: closed");
        await page.getByRole("button", { name: "Select Writer" }).click();
        await expect(page.locator("#chat-works")).toContainText("Execution: closed");
        await expect(page.locator('[data-delegation-id="browser-review"]')).toContainText(
          "cancelled",
        );
        await page.getByRole("button", { name: "Select Reviewer" }).click();
        await expect(page.locator("#chat-works")).toContainText("Execution: closed");
        await expect(page.locator("#chat-works")).toContainText("Hold slot");
      } else {
        await page.getByRole("button", { name: "Select Reviewer" }).click();
        await expect(page.locator("#chat-works")).toContainText("Hold slot");
        const directory = join(root, "data", "sessions", reviewerId, review.childRunId);
        const input = new HostMailbox(directory).inputs()[0];
        if (!input) throw new Error("Reviewer input is missing");
        new RunnerMailbox(directory).acknowledge(input.id, "completed");
        await page.getByRole("button", { name: "Stop run", exact: true }).click();
        await expect(page.locator("#chat-works")).toContainText("Execution: uncertain");
        await page.getByRole("button", { name: "Select Personal" }).click();
        await expect(page.locator("#chat-works")).toContainText("Owned child outcome is uncertain");
        await expect(page.locator("#chat-works")).toContainText("Execution: waiting");
        await page.locator("#chat-works").screenshot({
          path: join(tmpdir(), "mybots-nested-uncertainty.png"),
        });
        await page.getByRole("button", { name: "Select Writer" }).click();
        await expect(page.locator("#chat-works")).toContainText("Owned child outcome is uncertain");
        await page.getByRole("button", { name: "Select Reviewer" }).click();
        await page.getByRole("button", { name: "Close uncertain run", exact: true }).click();
        await expect(page.locator("#chat-works")).toContainText("Execution: closed");
        child?.send("complete");
        await page.getByRole("button", { name: "Select Personal" }).click();
        await expect(page.locator("#chat-works")).toContainText("Execution: succeeded");
        await expect(page.locator("#chat-works")).not.toContainText(
          "Owned child outcome is uncertain",
        );
      }
      expect(errors).toEqual([]);
    } finally {
      if (child) await stop();
      await rm(root, { recursive: true, force: true });
    }
  });
}
