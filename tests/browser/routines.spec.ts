import { type ChildProcess, fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

test("one-shot Routine survives overdue restart and accepts targeted occurrence input", async ({
  page,
}) => {
  const root = await mkdtemp(join(tmpdir(), "mybots-routines-browser-"));
  let child: ChildProcess | undefined;
  let exit: Promise<number | null> | undefined;
  async function start(port = 0, now = "2026-10-20T00:00:00Z") {
    const process = fork(
      fileURLToPath(new URL("../../scripts/client-routines-host.mjs", import.meta.url)),
      [root, String(port), now],
      { silent: true },
    );
    child = process;
    let errors = "";
    process.stderr?.on("data", (chunk) => {
      errors += chunk;
    });
    exit = new Promise((resolve, reject) => {
      process.once("exit", resolve);
      process.once("error", reject);
    });
    return Promise.race([
      new Promise<{ url: string; credential: string }>((resolve) =>
        process.once("message", (message) =>
          resolve(message as { url: string; credential: string }),
        ),
      ),
      exit.then(() => {
        throw new Error(errors);
      }),
    ]);
  }
  async function stop() {
    child?.kill("SIGTERM");
    expect(await exit).toBe(0);
    child = undefined;
  }
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const ready = await start();
    await page.goto(ready.url);
    await expect(page).toHaveTitle("Mybots · Bots");
    await page.getByLabel("Connection credential").fill(ready.credential);
    await page.getByRole("button", { name: "Pair with Host" }).click();
    await page.getByRole("button", { name: "Select Personal", exact: true }).click();
    await page.getByLabel("Routine instructions", { exact: true }).fill("Read the archive");
    await page
      .getByLabel("Run at (ISO instant with offset)", { exact: true })
      .fill("2026-10-20T09:00:00+08:00");
    await page.getByLabel("Schedule timezone", { exact: true }).fill("Asia/Shanghai");
    await page.getByRole("button", { name: "Create one-shot Routine", exact: true }).click();
    const routines = page.locator("#routine-list article");
    await expect(routines).toHaveCount(1);
    await expect(routines.first()).toContainText("2026-10-20T01:00:00.000Z");
    await expect(routines.first()).toContainText("Asia/Shanghai");
    await expect(page.locator("#chat-works article")).toHaveCount(0);
    await page.reload();
    await expect(routines).toHaveCount(1);
    await stop();
    await start(Number(new URL(ready.url).port), "2026-10-20T02:00:00Z");
    await page.reload();
    const work = page.locator("#chat-works article");
    await expect(work).toHaveCount(1);
    await expect(work).toContainText("Origin: routine");
    await expect(work).toContainText("Execution: active");
    await expect(work).toContainText("Run background: none");
    await expect(routines.first()).toContainText("none — one-shot admitted");
    await expect(
      routines.first().getByRole("link", { name: /Inspect occurrence Task/ }),
    ).toBeVisible();
    await page.getByLabel("Input target", { exact: true }).selectOption({ index: 1 });
    await page.getByLabel("Message", { exact: true }).fill("Only shelf 3");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(work).toContainText("You: Only shelf 3");
    await expect(routines.first()).not.toContainText("Only shelf 3");
    child?.send("complete");
    await expect(work).toContainText("Outcome: succeeded");
    await expect(work).toContainText("Routine result: Only shelf 3");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await stop();
    await start(Number(new URL(ready.url).port), "2026-10-21T02:00:00Z");
    await page.reload();
    await expect(work).toHaveCount(1);
    await expect(work).toContainText("Outcome: succeeded");
    expect(errors).toEqual([]);
  } finally {
    if (child) await stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("cron choices inherit Bot timezone and show separate occurrences without a missed-slot backlog", async ({
  page,
}) => {
  const root = await mkdtemp(join(tmpdir(), "mybots-cron-browser-"));
  let child: ChildProcess | undefined;
  let exit: Promise<number | null> | undefined;
  async function start(port = 0, now = "2026-10-20T00:00:00Z") {
    child = fork(
      fileURLToPath(new URL("../../scripts/client-routines-host.mjs", import.meta.url)),
      [root, String(port), now],
      { silent: true },
    );
    const process = child;
    let errors = "";
    process.stderr?.on("data", (chunk) => {
      errors += chunk;
    });
    exit = new Promise((resolve, reject) => {
      process.once("exit", resolve);
      process.once("error", reject);
    });
    return Promise.race([
      new Promise<{ url: string; credential: string }>((resolve) =>
        process.once("message", (message) =>
          resolve(message as { url: string; credential: string }),
        ),
      ),
      exit.then(() => {
        throw new Error(errors);
      }),
    ]);
  }
  async function stop() {
    child?.kill("SIGTERM");
    expect(await exit).toBe(0);
    child = undefined;
  }
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const ready = await start();
    await page.goto(ready.url);
    await page.getByLabel("Connection credential").fill(ready.credential);
    await page.getByRole("button", { name: "Pair with Host" }).click();
    await page.getByRole("button", { name: "Select Personal", exact: true }).click();
    await page.getByLabel("Bot timezone", { exact: true }).fill("UTC");
    await page.getByRole("button", { name: "Save Bot timezone", exact: true }).click();
    await expect(page.locator("#bot-timezone-notice")).toContainText("UTC");
    await page.getByLabel("Routine instructions", { exact: true }).fill("Hourly archive");
    await page.getByLabel("Routine schedule", { exact: true }).selectOption("hourly");
    await page.getByRole("button", { name: "Create cron Routine", exact: true }).click();
    const routines = page.locator("#routine-list article");
    const work = page.locator("#chat-works article");
    await expect(routines).toHaveCount(1);
    await expect(routines).toContainText("Cron: 0 * * * *");
    await expect(routines).toContainText("Timezone: UTC");
    await expect(routines).toContainText("2026-10-20T01:00:00.000Z");
    await page.reload();
    await expect(routines).toHaveCount(1);
    await stop();
    await start(Number(new URL(ready.url).port), "2026-10-22T02:30:00Z");
    await page.reload();
    await expect(work).toHaveCount(1);
    await expect(work).toContainText("Execution: active");
    child?.send("complete");
    await expect(work).toContainText("Outcome: succeeded");
    await expect(routines).toContainText("2026-10-22T03:00:00.000Z");
    await stop();
    await start(Number(new URL(ready.url).port), "2026-10-22T05:30:00Z");
    await page.reload();
    await expect(work).toHaveCount(2);
    await expect(work.nth(1)).toContainText("Execution: active");
    child?.send("complete");
    await expect(work.nth(1)).toContainText("Outcome: succeeded");
    await expect(routines.getByRole("link", { name: /Inspect occurrence Task/ })).toHaveCount(2);
    await expect(routines).toContainText("2026-10-22T06:00:00.000Z");
    await page.screenshot({ path: "/tmp/mybots-cron-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.locator("#routines").scrollIntoViewIfNeeded();
    await page.screenshot({ path: "/tmp/mybots-cron-mobile.png" });
    expect(errors).toEqual([]);
  } finally {
    if (child) await stop();
    await rm(root, { recursive: true, force: true });
  }
});
