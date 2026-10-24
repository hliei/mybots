import { fork } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { startDurableModel } from "../durable-model-fixture.ts";

test("built Web streams, reloads committed chat, edits Bots and keeps Threads separate", async ({
  page,
}) => {
  const root = await mkdtemp(join(tmpdir(), "mybots-durable-browser-"));
  let release: () => void = () => {};
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = await startDurableModel((request) => {
    if (JSON.stringify(request.messages.at(-1)).includes("Show a tool error"))
      return { tool: "read_file", arguments: { path: "../models.json" } };
    return {
      chunks: (async function* () {
        yield "A growing **reply**";
        await barrier;
        yield " with saved history.";
      })(),
    };
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
  try {
    const { url } = await Promise.race([
      new Promise<{ url: string }>((resolve) =>
        child.once("message", (value) => resolve(value as { url: string })),
      ),
      exited.then(() => {
        throw new Error(`Compiled startup failed: ${errors}`);
      }),
    ]);
    const credential = (await readFile(join(root, "data/client-credential"), "utf8")).trim();
    await page.goto(url);
    await page.getByLabel("Connection credential").fill(credential);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page.locator("#workspace")).toBeVisible();
    await page.getByRole("button", { name: "Create Bot", exact: true }).click();
    await page.getByLabel("Bot name", { exact: true }).fill("Writer");
    await page.getByLabel("Instructions", { exact: true }).fill("Write clearly");
    await page.getByRole("button", { name: "Save Bot", exact: true }).click();
    await expect(page.locator("#bot-identity-name")).toHaveText("Writer");
    await page.getByLabel("Message", { exact: true }).fill("Stream and remember");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.locator("article.assistant")).toContainText("A growing reply");
    await expect(page.locator("article.assistant")).toContainText("In progress");
    await page.reload();
    await expect(page.locator("article.assistant")).toContainText("A growing reply");
    release();
    await expect(page.locator("article.assistant")).toContainText("with saved history.");
    await expect(page.locator("#stop")).toBeDisabled();
    await page.reload();
    await expect(page.locator("article.assistant")).toContainText("with saved history.");
    await expect(page.locator("article.user")).toHaveCount(1);
    await page.getByRole("button", { name: "Bot settings", exact: true }).click();
    await page.getByLabel("Bot name", { exact: true }).fill("Editor");
    await page.getByLabel("Instructions", { exact: true }).fill("Edit concisely");
    await page.getByRole("button", { name: "Save Bot", exact: true }).click();
    await expect(page.locator("#bot-identity-name")).toHaveText("Editor");
    await page.getByRole("button", { name: "Create Bot", exact: true }).click();
    await page.getByLabel("Bot name", { exact: true }).fill("Reader");
    await page.getByRole("button", { name: "Save Bot", exact: true }).click();
    await expect(page.locator("#bot-identity-name")).toHaveText("Reader");
    await expect(page.locator("#thread-messages article")).toHaveCount(0);
    await page.getByRole("button", { name: "Select Editor", exact: true }).click();
    await expect(page.locator("article.assistant")).toContainText("with saved history.");
    expect(
      await page
        .locator(".sidebar")
        .evaluate((element) => Math.round(element.getBoundingClientRect().width)),
    ).toBe(316);
    await page.screenshot({ path: "test-results/durable-chat.png", fullPage: true });
    await page.getByLabel("Message", { exact: true }).fill("Show a tool error");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(
      page.locator("article.assistant").filter({ hasText: "Tools: read_file" }),
    ).toBeVisible();
    await expect(page.locator("article.tool")).toContainText("Path escapes");
    await expect(page.locator("#stop")).toBeDisabled();
    await page.reload();
    await expect(page.locator("article.tool")).toContainText("Path escapes");
    expect(errors).toBe("");
  } finally {
    release();
    child.kill("SIGTERM");
    await exited;
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
