import { fork } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { sendNewTask, showFeature } from "./navigation.ts";

test("uploads bytes to the selected Task and deliberately saves them for that Bot", async ({
  page,
}) => {
  const filename = `<img src=x onerror=alert(1)>${"LongFilename".repeat(6)}.bin`;
  const root = await mkdtemp(join(tmpdir(), "mybots-files-browser-"));
  const child = fork(
    fileURLToPath(new URL("../../scripts/client-browser-host.mjs", import.meta.url)),
    [root, "0"],
    {
      silent: true,
      env: { ...process.env, MYBOTS_MAX_ATTACHMENT_BYTES: "8" },
    },
  );
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  const ready = await Promise.race([
    new Promise<{ url: string; credential: string }>((resolve) =>
      child.once("message", (message) => resolve(message as { url: string; credential: string })),
    ),
    exited.then(() => {
      throw new Error(`Browser Host stopped before ready: ${stderr}`);
    }),
  ]);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(ready.url);
    await page.getByLabel("Connection credential").fill(ready.credential);
    await page.getByRole("button", { name: "Pair with Host" }).click();
    await showFeature(page, "chat");
    await page.getByRole("button", { name: "Select Personal" }).click();
    const tasks = page.getByLabel("Attachment Task");
    await expect(tasks.locator("option")).toHaveCount(1);
    await expect(page.locator("#attachment-list")).toContainText("This Task has no attachments.");
    const first = await tasks.inputValue();
    await page.getByLabel("File", { exact: true }).setInputFiles({
      name: filename,
      mimeType: "application/octet-stream",
      buffer: Buffer.from([1, 2, 3, 4]),
    });
    await page.getByRole("button", { name: "Message actions", exact: true }).click();
    await page.getByRole("button", { name: "Upload to a Task", exact: true }).click();
    await expect(tasks).toBeFocused();
    await page.getByRole("button", { name: "Upload attachment" }).click();
    await expect(page.locator("#attachment-list")).toContainText(`${filename} · 4 bytes`);
    await expect(
      page.locator("#attachments img, #attachments video, #attachments canvas"),
    ).toHaveCount(0);

    expect(
      await page
        .locator("#attachment-list")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );

    await showFeature(page, "chat");
    await page.getByLabel("Message", { exact: true }).fill("Second task");
    await showFeature(page, "chat");
    await sendNewTask(page);
    await expect(tasks.locator("option")).toHaveCount(2);
    const second = await tasks.locator("option").nth(1).getAttribute("value");
    await showFeature(page, "files");
    await tasks.selectOption(second as string);
    await expect(page.locator("#attachment-list")).toContainText("This Task has no attachments.");
    await expect(page.locator("#attachment-list")).not.toContainText(filename);

    await showFeature(page, "files");

    await showFeature(page, "tasks");
    await page
      .locator(`#task-${first}`)
      .getByRole("button", { name: "Upload to this Task", exact: true })
      .click();
    await expect(tasks).toHaveValue(first);
    await showFeature(page, "files");
    await page.getByLabel(`Workspace path for ${filename}`).fill("shared/sample.bin");
    let finishSaveRefresh: (() => Promise<void>) | undefined;
    await page.route("**/workspace/files", async (route) => {
      const response = await route.fetch();
      finishSaveRefresh = () => route.fulfill({ response });
    });
    await showFeature(page, "files");
    const save = page.getByRole("button", { name: "Save to Bot workspace" });
    await save.click();
    await expect(page.locator("#attachment-message")).toContainText("Saved");
    await expect.poll(() => Boolean(finishSaveRefresh)).toBe(true);
    await expect(save).toBeDisabled();
    await expect(page.getByLabel(`Workspace path for ${filename}`)).toBeDisabled();
    await finishSaveRefresh?.();
    await page.unroute("**/workspace/files");
    await expect(save).toBeEnabled();
    await expect(page.locator("#workspace-files")).toContainText("shared/sample.bin · 4 bytes");
    const workspaceReads: (() => Promise<void>)[] = [];
    await page.route("**/workspace/files", async (route) => {
      const response = await route.fetch();
      workspaceReads.push(() => route.fulfill({ response }));
    });
    await page.getByRole("button", { name: "Refresh status", exact: true }).click();
    await expect.poll(() => workspaceReads.length).toBe(1);
    await page.getByRole("button", { name: "Refresh status", exact: true }).click();
    await expect.poll(() => workspaceReads.length).toBe(2);
    await Promise.all(workspaceReads.map((finish) => finish()));
    await page.unroute("**/workspace/files");
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    expect(
      await page
        .getByRole("link", { name: "Download workspace shared/sample.bin", exact: true })
        .count(),
    ).toBe(1);
    for (const name of [`Download ${filename}`, "Download workspace shared/sample.bin"]) {
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.getByRole("link", { name, exact: true }).click(),
      ]);
      const path = join(root, "download.bin");
      await download.saveAs(path);
      expect(await readFile(path)).toEqual(Buffer.from([1, 2, 3, 4]));
    }
    for (const viewport of [
      { width: 1280, height: 900 },
      { width: 1440, height: 900 },
      { width: 1920, height: 1080 },
    ]) {
      await page.setViewportSize(viewport);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.locator("#detail-surface").evaluate((panel) => {
        panel.scrollTop = 0;
      });
      await page.screenshot({ path: `/tmp/mybots-files-${viewport.width}.png` });
    }

    await showFeature(page, "create");
    await page.getByLabel("Bot name").fill("Writer");
    await page.getByLabel("Role instructions").fill("Write.");
    await page.getByLabel("Model", { exact: true }).selectOption("deepseek/deepseek-chat");
    await page.getByRole("button", { name: "Create Bot", exact: true }).click();
    await showFeature(page, "chat");
    await page.getByRole("button", { name: "Select Writer" }).click();
    await showFeature(page, "files");
    await expect(page.locator("#attachment-scope")).toContainText(
      "Select an existing Task. First-message attachments are unavailable.",
    );
    await expect(
      page.getByRole("button", { name: "Upload attachment", exact: true }),
    ).toBeDisabled();
    await expect(page.locator("#workspace-files")).toContainText("No workspace files.");
    await expect(page.locator("#workspace-files")).not.toContainText("shared/sample.bin");

    await showFeature(page, "chat");
    await page.getByRole("button", { name: "Select Personal" }).click();
    await showFeature(page, "files");
    await tasks.selectOption(first);
    await page.getByLabel("File", { exact: true }).setInputFiles({
      name: "over.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(9),
    });
    await showFeature(page, "files");
    await page.getByRole("button", { name: "Upload attachment" }).click();
    await expect(page.locator("#attachment-message")).toContainText("8");
    await showFeature(page, "files");
    await page.getByLabel(`Workspace path for ${filename}`).fill("../escape");
    await showFeature(page, "files");
    await page.getByRole("button", { name: "Save to Bot workspace" }).click();
    await expect(page.locator("#attachment-message")).toContainText(/workspace/i);
    expect(errors).toEqual([]);
  } finally {
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
    await rm(root, { recursive: true, force: true });
  }
});
