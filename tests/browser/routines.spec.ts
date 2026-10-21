import { type ChildProcess, fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { showFeature } from "./navigation.ts";

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
    await showFeature(page, "chat");
    await page.getByRole("button", { name: "Select Personal", exact: true }).click();
    await showFeature(page, "Routines");
    await page.getByLabel("Routine instructions", { exact: true }).fill("Read the archive");
    await showFeature(page, "Routines");
    await page
      .getByLabel("Run at (ISO instant with offset)", { exact: true })
      .fill("2026-10-20T09:00:00+08:00");
    await showFeature(page, "Routines");
    await page.getByLabel("Schedule timezone", { exact: true }).fill("Asia/Shanghai");
    await showFeature(page, "Routines");
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
    await showFeature(page, "Routines");
    await expect(
      routines.first().getByRole("link", { name: /Inspect occurrence Task/ }),
    ).toBeVisible();
    await showFeature(page, "chat");
    await page.getByLabel("Input target", { exact: true }).selectOption({ index: 1 });
    await showFeature(page, "chat");
    await page.getByLabel("Message", { exact: true }).fill("Only shelf 3");
    await showFeature(page, "chat");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(work).toContainText("You: Only shelf 3");
    await expect(routines.first()).not.toContainText("Only shelf 3");
    child?.send("complete");
    await expect(work).toContainText("Outcome: succeeded");
    await expect(work).toContainText("Routine result: Only shelf 3");
    await page.setViewportSize({ width: 1920, height: 1080 });
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
    await showFeature(page, "chat");
    await page.getByRole("button", { name: "Select Personal", exact: true }).click();
    const writerResponse = await page.request.post(`${ready.url}/api/bots`, {
      data: {
        requestId: "writer",
        name: "Writer",
        instructions: "Write reports",
        model: { provider: "deepseek", id: "deepseek-chat" },
        tools: [],
      },
    });
    expect(writerResponse.status()).toBe(201);
    const writer = (await writerResponse.json()).bot;
    await page.route(
      "**/api/bots/personal/timezone",
      async (route) => {
        await route.fetch();
        await route.abort();
      },
      { times: 1 },
    );
    await showFeature(page, "Routines");
    await page.getByLabel("Bot timezone", { exact: true }).fill("UTC");
    await showFeature(page, "Routines");
    await page.getByRole("button", { name: "Save Bot timezone", exact: true }).click();
    await expect(page.locator("#bot-timezone-notice")).toContainText("unconfirmed");
    await page.reload();
    await expect(page.locator("#bot-timezone-notice")).toContainText("personal");
    await showFeature(page, "chat");
    await page.getByRole("button", { name: "Select Writer", exact: true }).click();
    await showFeature(page, "Routines");
    await expect(
      page.getByRole("button", { name: "Save Bot timezone", exact: true }),
    ).toBeDisabled();
    await expect(page.locator("#bot-timezone-notice")).toContainText("personal");
    await showFeature(page, "Routines");
    await page.getByRole("button", { name: "Retry Bot timezone", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Save Bot timezone", exact: true }),
    ).toBeEnabled();
    expect(
      (await (await page.request.get(`${ready.url}/api/bots/${writer.id}/routines`)).json())
        .timezone,
    ).toBe("Asia/Shanghai");
    await showFeature(page, "chat");
    await page.getByRole("button", { name: "Select Personal", exact: true }).click();
    await expect(page.getByLabel("Bot timezone", { exact: true })).toHaveValue("UTC");
    await showFeature(page, "Routines");
    await page.getByLabel("Routine instructions", { exact: true }).fill("Hourly archive");
    await showFeature(page, "Routines");
    await page.getByLabel("Routine schedule", { exact: true }).selectOption("hourly");
    await showFeature(page, "Routines");
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
    await showFeature(page, "Routines");
    await expect(routines.getByRole("link", { name: /Inspect occurrence Task/ })).toHaveCount(2);
    await expect(routines).toContainText("2026-10-22T06:00:00.000Z");
    await page.screenshot({ path: join(root, "cron-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 1920, height: 1080 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.locator("#routines").scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(root, "cron-wide.png") });
    expect(errors).toEqual([]);
  } finally {
    if (child) await stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("owner can edit, pause, run and delete a Routine without losing its evidence", async ({
  page,
}) => {
  const root = await mkdtemp(join(tmpdir(), "mybots-routine-lifecycle-"));
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
    await page.getByLabel("Connection credential").fill(ready.credential);
    await page.getByRole("button", { name: "Pair with Host" }).click();
    await showFeature(page, "chat");
    await page.getByRole("button", { name: "Select Personal", exact: true }).click();
    await showFeature(page, "Routines");
    await page.getByLabel("Routine instructions", { exact: true }).fill("Read the archive");
    await showFeature(page, "Routines");
    await page
      .getByLabel("Run at (ISO instant with offset)", { exact: true })
      .fill("2026-10-21T09:00:00+08:00");
    await showFeature(page, "Routines");
    await page.getByLabel("Schedule timezone", { exact: true }).fill("Asia/Shanghai");
    await showFeature(page, "Routines");
    await page.getByRole("button", { name: "Create one-shot Routine", exact: true }).click();
    const routines = page.locator("#routine-list article");
    await expect(routines).toHaveCount(1);
    await showFeature(page, "Routines");
    const id = ((await routines.innerText()).match(/Routine ID: ([0-9a-f-]+)/) ?? [])[1] as string;
    await showFeature(page, "Routines");
    await routines.getByRole("button", { name: "Pause routine" }).click();
    await expect(routines).toContainText("Paused. Automatic starts are blocked.");
    await page.reload();
    await expect(routines).toContainText("Paused. Automatic starts are blocked.");
    await showFeature(page, "Routines");
    await routines.getByRole("button", { name: "Run now" }).click();
    const work = page.locator("#chat-works article");
    await expect(work).toHaveCount(1);
    await expect(work).toContainText("Read the archive");
    await expect(work).toContainText("Execution: active");
    await showFeature(page, "Routines");
    await routines.getByLabel(`Edit instructions for ${id}`).fill("Shelf 3 only");
    await showFeature(page, "Routines");
    await routines.getByRole("button", { name: "Save Routine edit" }).click();
    await expect(routines).toContainText("Shelf 3 only");
    await expect(work).toContainText("Read the archive");
    await expect(routines).toContainText("Paused. Automatic starts are blocked.");
    await showFeature(page, "Routines");
    await routines.getByRole("button", { name: "Resume routine" }).click();
    await expect(routines).toContainText("Automatic starts are on.");
    await showFeature(page, "Routines");
    await routines.getByRole("button", { name: "Delete routine" }).click();
    await expect(routines).toContainText("Definition and results are retained.");
    await expect(routines).toContainText("Shelf 3 only");
    await stop();
    await start(Number(new URL(ready.url).port), "2026-10-22T02:00:00Z");
    await page.reload();
    await expect(work).toHaveCount(1);
    await expect(routines).toContainText("Definition and results are retained.");
    await expect(routines.getByRole("button", { name: "Run now" })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    if (child) await stop();
    await rm(root, { recursive: true, force: true });
  }
});
