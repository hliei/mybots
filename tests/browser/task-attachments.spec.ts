import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { showFeature } from "./navigation.ts";

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
    await showFeature(page, "files");
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
    await page.getByLabel("Message").fill("Second task");
    await showFeature(page, "chat");
    await page.getByRole("button", { name: "New task" }).click();
    await expect(tasks.locator("option")).toHaveCount(2);
    const second = await tasks.locator("option").nth(1).getAttribute("value");
    await showFeature(page, "files");
    await tasks.selectOption(second as string);
    await expect(page.locator("#attachment-list")).toContainText("This Task has no attachments.");
    await expect(page.locator("#attachment-list")).not.toContainText(filename);

    await showFeature(page, "files");

    await tasks.selectOption(first);
    await showFeature(page, "files");
    await page.getByLabel(`Workspace path for ${filename}`).fill("shared/sample.bin");
    await showFeature(page, "files");
    await page.getByRole("button", { name: "Save to Bot workspace" }).click();
    await expect(page.locator("#workspace-files")).toContainText("shared/sample.bin · 4 bytes");

    await showFeature(page, "create");
    await page.getByLabel("Bot name").fill("Writer");
    await page.getByLabel("Role instructions").fill("Write.");
    await page.getByLabel("Model", { exact: true }).selectOption("deepseek/deepseek-chat");
    await page.getByRole("button", { name: "Create Bot", exact: true }).click();
    await showFeature(page, "chat");
    await page.getByRole("button", { name: "Select Writer" }).click();
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
