import { type ChildProcess, fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RunnerMailbox } from "@mybots/mailbox/node";
import { expect, test } from "@playwright/test";
import { showFeature } from "./navigation.ts";

test("approves a selected attachment and downloads the receiving copy after restart", async ({
  page,
}) => {
  const root = await mkdtemp(join(tmpdir(), "mybots-transfer-browser-"));
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
    const detail = await page.request.get(`${ready.url}/api/bots/personal/thread`, {
      headers: { Authorization: `Bearer ${ready.credential}` },
    });
    const taskId = ((await detail.json()) as { tasks: { id: string }[] }).tasks[0]?.id as string;
    const uploaded = await page.request.post(
      `${ready.url}/api/bots/personal/tasks/${taskId}/attachments`,
      {
        headers: {
          Authorization: `Bearer ${ready.credential}`,
          "X-Filename": "note.txt",
        },
        data: Buffer.from("browser-note"),
      },
    );
    expect(uploaded.status()).toBe(201);
    const attachmentId = ((await uploaded.json()) as { id: string }).id;
    await page.goto(ready.url);
    await page.getByLabel("Connection credential").fill(ready.credential);
    await page.getByRole("button", { name: "Pair with Host" }).click();
    await showFeature(page, "chat");
    await page.getByRole("button", { name: "Select Personal" }).click();
    await showFeature(page, "Collaboration");
    await page.getByLabel("Target Bot").selectOption(writerId);
    await showFeature(page, "Collaboration");
    await page.getByLabel("Permission").selectOption("ask-each-time");
    await showFeature(page, "Collaboration");
    await page.getByRole("button", { name: "Save delegation permission" }).click();
    const mailbox = new RunnerMailbox(join(root, "data", "sessions", "personal", ready.sessionId));
    mailbox.requestHistory({
      id: "browser-copy",
      operation: "delegate",
      incarnation: mailbox.executionIncarnation(),
      input: {
        requestId: "browser-copy",
        targetBotId: writerId,
        text: "Copy the browser note",
        files: [{ kind: "attachment", id: attachmentId }],
      },
    });
    await expect
      .poll(() => mailbox.historyResponse("browser-copy"))
      .toMatchObject({
        result: { state: "pending", childTaskId: null },
      });
    mailbox.requestDurableWait("delegation");
    await expect(page.locator("#chat-works")).toContainText(
      "Selected files: attachment note.txt (12 bytes)",
    );
    await showFeature(page, "tasks");
    await page.getByRole("button", { name: "Approve action" }).click();
    await expect(page.locator('[data-approval-id="browser-copy"]')).toContainText("executed");
    await showFeature(page, "chat");
    await page.getByRole("button", { name: "Select Writer" }).click();
    await expect(page.locator("#attachment-list")).toContainText("note.txt · 12 bytes");
    await expect(page.locator("#attachment-list")).toContainText(`Delegation browser-copy`);
    await expect(page.locator("#attachment-list")).toContainText(
      `Source attachment ${attachmentId}`,
    );
    await expect(page.locator("#workspace-files")).not.toContainText("note.txt");
    const tasks = page.getByLabel("Attachment Task");
    const receiving = await tasks.inputValue();
    const download = await page.request.get(
      `${ready.url}/api/bots/${writerId}/tasks/${receiving}/attachments`,
      { headers: { Authorization: `Bearer ${ready.credential}` } },
    );
    const copyId = ((await download.json()) as { attachments: { id: string }[] }).attachments[0]
      ?.id as string;
    const bytes = await page.request.get(
      `${ready.url}/api/bots/${writerId}/tasks/${receiving}/attachments/${copyId}`,
      { headers: { Authorization: `Bearer ${ready.credential}` } },
    );
    expect(Buffer.from(await bytes.body())).toEqual(Buffer.from("browser-note"));
    await page.reload();
    await showFeature(page, "chat");
    await page.getByRole("button", { name: "Select Writer" }).click();
    await expect(page.locator("#attachment-list")).toContainText("note.txt · 12 bytes");
    await stop();
    await start(Number(new URL(ready.url).port));
    await page.reload();
    await showFeature(page, "chat");
    await page.getByRole("button", { name: "Select Writer" }).click();
    await showFeature(page, "files");
    await tasks.selectOption(receiving);
    await expect(page.locator("#attachment-list")).toContainText("Source attachment");
    const again = await page.request.get(
      `${ready.url}/api/bots/${writerId}/tasks/${receiving}/attachments/${copyId}`,
      { headers: { Authorization: `Bearer ${ready.credential}` } },
    );
    expect(Buffer.from(await again.body())).toEqual(Buffer.from("browser-note"));
    expect(errors).toEqual([]);
  } finally {
    if (child) await stop();
    await rm(root, { recursive: true, force: true });
  }
});
