import { fork } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { startDurableModel } from "../durable-model-fixture.ts";

test("built Web searches selected history, pages originals and returns to the unchanged chat", async ({
  page,
}) => {
  const root = await mkdtemp(join(tmpdir(), "mybots-original-browser-"));
  let first = true;
  const original = `BROWSER_ORIGINAL ${"Original detail ".repeat(600)}END_OF_BROWSER_ORIGINAL`;
  const service = await startDurableModel(() => {
    const text = first ? original : "Saved reply";
    first = false;
    return { text };
  });
  await writeFile(join(root, "models.json"), JSON.stringify([service.config]), { mode: 0o600 });
  const child = fork(
    new URL("../../apps/api/dist/index.js", import.meta.url),
    ["--root", root, "--port", "0"],
    {
      execArgv: ["--no-strip-types"],
      silent: true,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NO_COLOR")),
    },
  );
  let errors = "";
  child.stderr?.on("data", (chunk) => {
    errors += chunk;
  });
  const exited = new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  try {
    const { url } = await Promise.race([
      new Promise<{ url: string }>((resolve) =>
        child.once("message", (value) => resolve(value as { url: string })),
      ),
      exited.then(() => {
        throw new Error(`Compiled startup failed: ${errors}`);
      }),
    ]);
    const credential = (await readFile(join(root, "client-credential"), "utf8")).trim();
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(url);
    await expect(page).toHaveTitle("Mybots");
    await page.getByLabel("Connection credential").fill(credential);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page.locator("#workspace")).toBeVisible();
    // The initial unauthenticated Bot listing is expected to return 401.
    expect(consoleErrors).toEqual([
      "Failed to load resource: the server responded with a status of 401 (Unauthorized)",
    ]);
    consoleErrors.length = 0;
    const headers = { Authorization: `Bearer ${credential}` };
    const response = await page.request.post(`${url}api/bots`, {
      headers,
      data: { name: "Writer", instructions: "", model: "controlled" },
    });
    expect(response.ok()).toBe(true);
    const bot = await response.json();
    for (let index = 0; index < 25; index++) {
      const sent = await page.request.post(`${url}api/bots/${bot.id}/send`, {
        headers,
        data: { text: `HISTORY_NOTE ${index}`, requestId: `seed-${index}` },
      });
      expect(sent.status()).toBe(202);
      await expect
        .poll(
          async () =>
            (await (await page.request.get(`${url}api/bots/${bot.id}/chat`, { headers })).json())
              .busy,
        )
        .toBe(false);
    }
    await page.reload();
    await expect(page.locator("#bot-identity-name")).toHaveText("Writer");
    await page.getByLabel("Message", { exact: true }).fill("Unsent draft");
    await page.locator(".timeline").evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect
      .poll(() => page.locator(".timeline").evaluate((element) => element.scrollTop))
      .toBe(0);
    await page.getByRole("button", { name: "History", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Writer · Thread history" })).toBeVisible();
    await page.getByLabel("Search history").fill("history_note");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.locator("#history-results article")).toHaveCount(20);
    await page.getByRole("button", { name: "Older results", exact: true }).click();
    await expect(page.locator("#history-results article")).toHaveCount(5);
    await expect(page.locator("#history-results")).toContainText("HISTORY_NOTE 0");
    await page.getByRole("button", { name: "Newer results", exact: true }).click();
    await expect(page.locator("#history-results article")).toHaveCount(20);
    await page.getByLabel("Search history").fill("BROWSER_ORIGINAL");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.locator("#history-results article")).toHaveCount(1);
    await page.getByRole("button", { name: /Read original/ }).click();
    await expect(page.locator("#history-original")).toContainText("BROWSER_ORIGINAL");
    await expect(page.locator("#history-original")).not.toContainText("END_OF_BROWSER_ORIGINAL");
    await page.getByRole("button", { name: "Read more", exact: true }).click();
    await expect(page.locator("#history-original")).toContainText("END_OF_BROWSER_ORIGINAL");
    await expect(page.getByRole("button", { name: "Read more", exact: true })).toBeHidden();
    await page.getByRole("button", { name: "Back to results", exact: true }).click();
    await page.screenshot({ path: "/tmp/mybots-original-history-desktop.png", fullPage: true });
    await page.getByLabel("Search history").fill("missing-evidence");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.locator("#history-status")).toHaveText("No matches in this page.");
    await page.getByRole("button", { name: "Return to chat", exact: true }).click();
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Unsent draft");
    await expect
      .poll(() => page.locator(".timeline").evaluate((element) => element.scrollTop))
      .toBe(0);
    await expect(page.locator("#thread-messages article.user")).toHaveCount(25);
    await page.getByRole("button", { name: "Create Bot", exact: true }).click();
    await page.getByLabel("Bot name", { exact: true }).fill("Reader");
    await page.getByRole("button", { name: "Save Bot", exact: true }).click();
    await expect(page.locator("#bot-identity-name")).toHaveText("Reader");
    await page.getByRole("button", { name: "History", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Reader · Thread history" })).toBeVisible();
    await expect(page.locator("#history-results article")).toHaveCount(0);
    await expect(page.locator("#history-status")).toHaveText("No matches in this page.");
    expect(consoleErrors).toEqual([]);
    expect(errors).toBe("");
  } finally {
    child.kill("SIGTERM");
    await exited;
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
