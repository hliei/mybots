import { type ChildProcess, fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HostMailbox, RunnerMailbox } from "@mybots/mailbox/node";
import { expect, test } from "@playwright/test";
import { showFeature } from "./navigation.ts";

for (const outcome of ["cancel", "uncertain", "revoke", "revoke-uncertain"] as const) {
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
      await showFeature(page, "chat");
      await page.getByRole("button", { name: "Select Personal" }).click();
      await expect(page.getByLabel("Target Bot")).toContainText("deny");
      await showFeature(page, "Collaboration");
      await page.getByLabel("Target Bot").selectOption(writerId);
      await showFeature(page, "Collaboration");
      await page.getByLabel("Permission").selectOption("allow");
      await showFeature(page, "Collaboration");
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
      await showFeature(page, "chat");
      await page.getByRole("button", { name: "Select Personal" }).click();
      await expect(page.locator("#chat-works")).toContainText("Delegation browser-child");
      await showFeature(page, "chat");
      await page.getByRole("button", { name: "Select Writer" }).click();
      await expect(page.locator("#chat-works")).toContainText("Origin: delegation");
      await expect(page.locator("#chat-works")).toContainText("Selected browser text");
      await showFeature(page, "Collaboration");
      await page.getByLabel("Target Bot").selectOption(reviewerId);
      await showFeature(page, "Collaboration");
      await page
        .getByLabel("Permission")
        .selectOption(outcome === "uncertain" ? "ask-each-time" : "allow");
      await showFeature(page, "Collaboration");
      await page.getByRole("button", { name: "Save delegation permission" }).click();
      await expect(page.locator("#collaboration-notice")).toContainText(
        `Delegation from this Bot to ${reviewerId} is ${outcome === "uncertain" ? "ask-each-time" : "allow"}.`,
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
      let review = childMailbox.historyResponse("browser-review")?.result as {
        childRunId: string;
      };
      childMailbox.requestDurableWait("delegation");
      await expect(page.locator("#chat-works")).toContainText("Execution: waiting");
      await expect(page.locator('[data-delegation-id="browser-review"]')).toContainText(
        `Originating Run ${ready.sessionId}`,
      );
      if (outcome === "uncertain") {
        const card = page.locator('#chat-works [data-approval-id="browser-review"]');
        await showFeature(page, "tasks");
        await card.getByRole("button", { name: "Approve action" }).click();
        await expect(card).toContainText("executed");
        const detail = await (
          await page.request.get(`${ready.url}/api/bots/${writerId}/thread`, {
            headers: { Authorization: `Bearer ${ready.credential}` },
          })
        ).json();
        review = detail.tasks[0].runs[0].delegations.find(
          (row: { id: string }) => row.id === "browser-review",
        );
      }
      await showFeature(page, "chat");
      await page.getByRole("button", { name: "Select Reviewer" }).click();
      await expect(page.locator("#chat-works")).toContainText("Hold slot");
      await stop();
      await start(Number(new URL(ready.url).port));
      await page.reload();
      await showFeature(page, "chat");
      await page.getByRole("button", { name: "Select Writer" }).click();
      await expect(page.locator("#chat-works")).toContainText("Execution: waiting");
      await expect(page.locator("#chat-works")).toContainText("Delegation browser-review");
      await showFeature(page, "tasks");
      await page.locator("#chat-works").screenshot({
        path: join(tmpdir(), "mybots-nested-delegation.png"),
      });
      await expect(page.locator("#chat-works")).toContainText("Origin: delegation");
      if (outcome === "revoke" || outcome === "revoke-uncertain") {
        await showFeature(page, "chat");
        await page.getByRole("button", { name: "Select Reviewer" }).click();
        await expect(
          page.locator("#chat-works article").filter({ hasText: `Run ID: ${review.childRunId}` }),
        ).toContainText("Execution: active", { timeout: 10000 });
        const auth = { Authorization: `Bearer ${ready.credential}` };
        await showFeature(page, "chat");
        await page.getByRole("button", { name: "Select Personal" }).click();
        await showFeature(page, "tasks");
        await expect(page.locator('[data-delegation-id="browser-child"]')).toBeVisible();
        await showFeature(page, "Collaboration");
        await page.getByLabel("Target Bot").selectOption(writerId);
        await showFeature(page, "Collaboration");
        await page.getByLabel("Permission").focus();
        await showFeature(page, "Collaboration");
        await page.getByLabel("Permission").selectOption("ask-each-time");
        await showFeature(page, "Collaboration");
        await page.getByRole("button", { name: "Save delegation permission" }).click();
        await expect(page.locator("#collaboration-notice")).toContainText(
          `to ${writerId} is ask-each-time.`,
        );
        const pendingSource = await (
          await page.request.post(`${ready.url}/api/bots/personal/thread/tasks`, {
            headers: auth,
            data: { requestId: "revocation-proposal-source", text: "Hold chat" },
          })
        ).json();
        const pendingMailbox = new RunnerMailbox(
          join(root, "data", "sessions", "personal", pendingSource.runId),
        );
        await expect.poll(() => pendingMailbox.executionIncarnation()).toBeGreaterThan(0);
        pendingMailbox.requestHistory({
          id: "revocation-pending",
          operation: "delegate",
          incarnation: pendingMailbox.executionIncarnation(),
          input: {
            requestId: "revocation-pending",
            targetBotId: writerId,
            text: "Exact pending operation",
          },
        });
        await expect
          .poll(() => pendingMailbox.historyResponse("revocation-pending"))
          .toMatchObject({ result: { approval: { state: "pending" } } });
        const approvalCard = page.locator('#chat-works [data-approval-id="revocation-pending"]');
        await expect(approvalCard).toContainText("Exact pending operation");
        const queued = await (
          await page.request.post(`${ready.url}/api/bots/${reviewerId}/thread/tasks`, {
            headers: auth,
            data: { requestId: "unrelated-review", text: "Unrelated review" },
          })
        ).json();
        const directory = join(root, "data", "sessions", reviewerId, review.childRunId);
        const input = new HostMailbox(directory).inputs()[0];
        if (!input) throw new Error("Reviewer input is missing");
        if (outcome === "revoke-uncertain")
          new RunnerMailbox(directory).acknowledge(input.id, "completed");
        child?.send("fail-stop");
        await showFeature(page, "Collaboration");
        await page.getByLabel("Permission").focus();
        await showFeature(page, "Collaboration");
        await page.getByLabel("Permission").selectOption("deny");
        await showFeature(page, "Collaboration");
        await page.getByRole("button", { name: "Save delegation permission" }).click();
        await expect(page.locator("#collaboration-notice")).toContainText(
          `to ${writerId} is deny.`,
        );
        await expect(approvalCard).toContainText("stale");
        const conversationApproval = page.locator(
          '#work-cards [data-approval-id="revocation-pending"]',
        );
        await expect(conversationApproval).toContainText("stale");
        await expect(
          conversationApproval.getByRole("button", { name: "Approve action" }),
        ).toHaveCount(0);
        await expect(approvalCard.getByRole("button", { name: "Approve action" })).toHaveCount(0);
        await expect(page.locator('[data-delegation-id="browser-child"]')).toContainText(
          "Collaboration revoked",
        );
        await showFeature(page, "chat");
        await page.getByRole("button", { name: "Select Writer" }).click();
        await expect(page.locator("#chat-works")).toContainText("Owned child stop is unconfirmed.");
        await showFeature(page, "chat");
        await page.getByRole("button", { name: "Select Reviewer" }).click();
        await expect(page.locator("#chat-works")).toContainText("Execution stop unconfirmed");
        await expect(page.locator("#chat-works")).toContainText("Execution: queued");
        // Shutdown confirms the external executor stopped; a fresh Host settles the persisted scope.
        child?.send("allow-stop");
        await stop();
        await start(Number(new URL(ready.url).port));
        await page.reload();
        await showFeature(page, "chat");
        await page.getByRole("button", { name: "Select Reviewer" }).click();
        const leaf = page
          .locator("#chat-works article")
          .filter({ hasText: `Run ID: ${review.childRunId}` });
        await expect(leaf).toContainText(
          outcome === "revoke" ? "Execution: closed" : "Execution: uncertain",
        );
        // A briefly started Task may need the five-second interrupted-execution backoff.
        await expect(
          page.locator("#chat-works article").filter({ hasText: `Run ID: ${queued.runId}` }),
        ).toContainText("Execution: active", { timeout: 10000 });
        new RunnerMailbox(directory).reply(input, "Late evidence after revocation", "message");
        await showFeature(page, "chat");
        await page.getByRole("button", { name: "Refresh status" }).click();
        await expect(leaf).toContainText("Late result: Late evidence after revocation");
        await showFeature(page, "chat");
        await page.getByRole("button", { name: "Select Personal" }).click();
        await expect(page.locator('[data-delegation-id="browser-child"]')).toContainText(
          "Collaboration revoked",
        );
        await expect(
          page.locator('#chat-works [data-approval-id="revocation-pending"]'),
        ).toContainText("stale");
        if (outcome === "revoke-uncertain") {
          await expect(
            page.locator("#chat-works article").filter({ hasText: `Run ID: ${ready.sessionId}` }),
          ).toContainText("Owned child outcome is uncertain");
        } else {
          child?.send("complete");
          await expect(
            page.locator("#chat-works article").filter({ hasText: `Run ID: ${ready.sessionId}` }),
          ).toContainText("Execution: succeeded");
        }
      } else if (outcome === "cancel") {
        await showFeature(page, "chat");
        await page.getByRole("button", { name: "Select Personal" }).click();
        await showFeature(page, "tasks");
        await page.getByRole("button", { name: "Stop run", exact: true }).click();
        await expect(page.locator("#chat-works")).toContainText("Execution: closed");
        await showFeature(page, "chat");
        await page.getByRole("button", { name: "Select Writer" }).click();
        await expect(page.locator("#chat-works")).toContainText("Execution: closed");
        await expect(page.locator('[data-delegation-id="browser-review"]')).toContainText(
          "cancelled",
        );
        await showFeature(page, "chat");
        await page.getByRole("button", { name: "Select Reviewer" }).click();
        await expect(page.locator("#chat-works")).toContainText("Execution: closed");
        await expect(page.locator("#chat-works")).toContainText("Hold slot");
      } else {
        await showFeature(page, "chat");
        await page.getByRole("button", { name: "Select Reviewer" }).click();
        await expect(page.locator("#chat-works")).toContainText("Hold slot");
        const directory = join(root, "data", "sessions", reviewerId, review.childRunId);
        const input = new HostMailbox(directory).inputs()[0];
        if (!input) throw new Error("Reviewer input is missing");
        new RunnerMailbox(directory).acknowledge(input.id, "completed");
        await showFeature(page, "tasks");
        await page.getByRole("button", { name: "Stop run", exact: true }).click();
        await expect(page.locator("#chat-works")).toContainText("Execution: uncertain");
        await showFeature(page, "chat");
        await page.getByRole("button", { name: "Select Personal" }).click();
        await expect(page.locator("#chat-works")).toContainText("Owned child outcome is uncertain");
        await expect(page.locator("#chat-works")).toContainText("Execution: waiting");
        await showFeature(page, "tasks");
        await page.locator("#chat-works").screenshot({
          path: join(tmpdir(), "mybots-nested-uncertainty.png"),
        });
        await showFeature(page, "chat");
        await page.getByRole("button", { name: "Select Writer" }).click();
        await expect(page.locator("#chat-works")).toContainText("Owned child outcome is uncertain");
        await showFeature(page, "chat");
        await page.getByRole("button", { name: "Select Reviewer" }).click();
        await showFeature(page, "tasks");
        await page.getByRole("button", { name: "Close uncertain run", exact: true }).click();
        await expect(page.locator("#chat-works")).toContainText("Execution: closed");
        child?.send("complete");
        await showFeature(page, "chat");
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
