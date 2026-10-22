import { type ChildProcess, fork } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RunnerMailbox } from "@mybots/mailbox/node";
import { expect, test } from "@playwright/test";
import { showFeature } from "./navigation.ts";

test("downloads a selected result unchanged after workspace edits and a fresh Host", async ({
  page,
}) => {
  const root = await mkdtemp(join(tmpdir(), "mybots-artifact-browser-"));
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
    const original = Buffer.from("Report at delivery\n");
    const workspaceFile = join(root, "groups", "personal", "report.txt");
    await writeFile(workspaceFile, original);
    const mailbox = new RunnerMailbox(join(root, "data", "sessions", "personal", ready.sessionId));
    mailbox.requestHistory({
      id: "browser-report",
      operation: "publish_result",
      incarnation: mailbox.executionIncarnation(),
      input: { requestId: "browser-report", text: "Report ready", files: ["report.txt"] },
    });
    await page.goto(ready.url);
    await page.getByLabel("Connection credential").fill(ready.credential);
    await page.getByRole("button", { name: "Pair with Host" }).click();
    await showFeature(page, "chat");
    await page.getByRole("button", { name: "Select Personal" }).click();
    const link = page.getByRole("link", {
      name: `Download report.txt (${original.length} bytes)`,
      exact: true,
    });
    await expect(page.locator("#chat-works")).toContainText("Report ready");
    await showFeature(page, "tasks");
    await expect(link).toBeVisible();
    await expect(page.locator("#chat-works")).toContainText("Bot: personal · Task:");
    await writeFile(workspaceFile, "Replaced working report\n");
    async function download() {
      await showFeature(page, "tasks");
      const [saved] = await Promise.all([page.waitForEvent("download"), link.click()]);
      expect(saved.suggestedFilename()).toBe("report.txt");
      const target = join(root, "downloaded-report.txt");
      await saved.saveAs(target);
      expect(await readFile(target)).toEqual(original);
    }
    await download();
    await showFeature(page, "files");
    const deliveries = page.getByRole("region", { name: "Immutable deliveries" });
    await expect(deliveries).toContainText("report.txt");
    await expect(deliveries).toContainText("Bot: personal · Task:");
    await deliveries.getByRole("button", { name: "View producing Task", exact: true }).click();
    await expect(page.locator("#chat-works > article > details[open]")).toContainText(
      "Report ready",
    );
    await showFeature(page, "files");
    await deliveries.getByRole("button", { name: "Inspect producing Run", exact: true }).click();
    await expect(page.locator("#run-history")).toContainText("Recorded Run evidence:");
    await showFeature(page, "files");
    const [fileDownload] = await Promise.all([
      page.waitForEvent("download"),
      deliveries.getByRole("link", { name: /Download report.txt/ }).click(),
    ]);
    const deliveredPath = join(root, "files-report.txt");
    await fileDownload.saveAs(deliveredPath);
    expect(await readFile(deliveredPath)).toEqual(original);
    child?.send("complete");
    await expect(page.locator("#chat-works")).toContainText("Controlled reply");
    await stop();
    await start(Number(new URL(ready.url).port));
    await page.reload();
    await showFeature(page, "chat");
    await page.getByRole("button", { name: "Select Personal" }).click();
    await expect(page.locator("#chat-works")).toContainText("Report ready");
    await showFeature(page, "tasks");
    await expect(link).toBeVisible();
    await download();
    await showFeature(page, "files");
    await expect(deliveries).toContainText("report.txt");
    const [restored] = await Promise.all([
      page.waitForEvent("download"),
      deliveries.getByRole("link", { name: /Download report.txt/ }).click(),
    ]);
    await restored.saveAs(deliveredPath);
    expect(await readFile(deliveredPath)).toEqual(original);
    expect(errors).toEqual([]);
  } finally {
    if (child) await stop();
    await rm(root, { recursive: true, force: true });
  }
});
