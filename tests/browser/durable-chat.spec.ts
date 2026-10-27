import { fork } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { startDurableModel } from "../durable-model-fixture.ts";
import { configureFixture, fixtureEnvironment } from "../provider-fixture.ts";

test("built Web streams, reloads committed chat, edits Bots and keeps Threads separate", async ({
  page,
}) => {
  const root = await mkdtemp(join(tmpdir(), "mybots-durable-browser-"));
  let release: () => void = () => {};
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = await startDurableModel((request) => {
    if (JSON.stringify(request.messages.at(-1)).includes("Render safe Markdown"))
      return {
        text: '**Safe Markdown**\n\n<script>throw new Error("unsafe")</script>\n\n[unsafe](javascript:alert(1)) [local](/api/bots) [safe](https://example.com)\n\n![hidden image](https://example.com/tracker.png)\n\n```js\nconst value = "copied";\n```',
      };
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
  configureFixture(root);
  const child = fork(
    new URL("../../apps/api/dist/index.js", import.meta.url),
    ["--root", root, "--port", "0"],
    {
      execArgv: ["--no-strip-types"],
      silent: true,
      env: Object.fromEntries(
        Object.entries(fixtureEnvironment(service)).filter(([key]) => key !== "NO_COLOR"),
      ),
    },
  );
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
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
    const credential = (await readFile(join(root, "client-credential"), "utf8")).trim();
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(url);
    await expect(page).toHaveTitle("Mybots");
    await page.getByLabel("Connection credential").fill(credential);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page.locator("#workspace")).toBeVisible();
    await page.getByRole("button", { name: "Create Bot", exact: true }).click();
    await page.getByLabel("Bot name", { exact: true }).fill("Writer");
    await page.getByLabel("Instructions", { exact: true }).fill("Write clearly");
    await page.getByRole("button", { name: "Save Bot", exact: true }).click();
    await expect(page.locator("#bot-identity-name")).toHaveText("Writer");
    await page.getByRole("button", { name: "Shared Skills", exact: true }).click();
    await page.getByLabel("Skill", { exact: true }).selectOption("resource-maintenance");
    await expect(page.getByLabel("Skill instructions (Markdown)")).toHaveAttribute("readonly", "");
    await expect(page.getByRole("button", { name: "Save Skill", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Remove Skill", exact: true })).toBeDisabled();
    await page.getByLabel("Skill", { exact: true }).selectOption("");
    await page.getByLabel("Skill name", { exact: true }).fill("writing");
    await page.getByLabel("Description", { exact: true }).fill("Writing help");
    await page.getByLabel("Skill instructions (Markdown)").fill("Prefer short sentences.");
    await page.getByRole("button", { name: "Save Skill", exact: true }).click();
    await expect(page.locator("#skill-status")).toHaveText("Skill saved");
    await page.screenshot({ path: "test-results/durable-skills.png", fullPage: true });
    await page.getByRole("button", { name: "Close Skills", exact: true }).click();
    await page.getByRole("button", { name: "Memory", exact: true }).click();
    await page.getByLabel("Memory (Markdown)").fill("OWNER_BROWSER_PREFERENCE");
    await page.getByRole("button", { name: "Save memory", exact: true }).click();
    await expect(page.locator("#memory-status")).toHaveText("Memory saved");
    await page.getByLabel("Memory scope").selectOption("bot");
    await expect(page.getByLabel("Memory (Markdown)")).toHaveValue("");
    await page.getByLabel("Memory (Markdown)").fill("WRITER_BROWSER_MEMORY");
    await page.getByRole("button", { name: "Save memory", exact: true }).click();
    await expect(page.locator("#memory-status")).toHaveText("Memory saved");
    await page.screenshot({ path: "test-results/durable-memory.png", fullPage: true });
    await page.getByRole("button", { name: "Close memory", exact: true }).click();
    await page.reload();
    await page.getByRole("button", { name: "Shared Skills", exact: true }).click();
    await page.getByLabel("Skill", { exact: true }).selectOption("writing");
    await expect(page.getByLabel("Skill instructions (Markdown)")).toHaveValue(
      "Prefer short sentences.",
    );
    await page.getByLabel("Skill instructions (Markdown)").fill("Keep paragraphs short too.");
    await page.getByRole("button", { name: "Save Skill", exact: true }).click();
    await expect(page.locator("#skill-status")).toHaveText("Skill saved");
    await page.getByRole("button", { name: "Close Skills", exact: true }).click();
    await page.getByLabel("Message", { exact: true }).fill("Stream and remember");
    await page.getByLabel("Message", { exact: true }).press("Enter");
    await expect(page.locator("article.assistant")).toContainText("A growing reply");
    await expect(page.locator("article.assistant")).toContainText("In progress");
    expect(JSON.stringify(service.requests[0]?.messages)).toContain("OWNER_BROWSER_PREFERENCE");
    expect(JSON.stringify(service.requests[0]?.messages)).toContain("WRITER_BROWSER_MEMORY");
    expect(JSON.stringify(service.requests[0]?.messages)).toContain("Writing help");
    expect(JSON.stringify(service.requests[0]?.messages)).not.toContain(
      "Keep paragraphs short too.",
    );
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
    await page.getByRole("button", { name: "Memory", exact: true }).click();
    await expect(page.getByLabel("Memory (Markdown)")).toHaveValue("OWNER_BROWSER_PREFERENCE");
    await page.getByLabel("Memory scope").selectOption("bot");
    await expect(page.getByLabel("Memory (Markdown)")).toHaveValue("");
    await page.getByRole("button", { name: "Close memory", exact: true }).click();
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
    await expect(page.locator("article.tool")).toHaveCount(0);
    await page.getByLabel("Tool activity", { exact: true }).check();
    await expect(page.locator(".tool-steps").first()).toBeVisible();
    await page.locator(".tool-steps summary").first().click();
    await expect(page.locator(".tool-steps").first()).toContainText(
      "read_file · Failed · Path escapes",
    );
    await page.getByRole("button", { name: "Shared Skills", exact: true }).click();
    await page.getByLabel("Skill", { exact: true }).selectOption("writing");
    await page.getByRole("button", { name: "Remove Skill", exact: true }).click();
    await expect(page.locator("#skill-status")).toHaveText("Skill removed");
    await expect(
      page.getByLabel("Skill", { exact: true }).locator("option[value=writing]"),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Close Skills", exact: true }).click();
    await page.getByRole("button", { name: "Memory", exact: true }).click();
    await page.getByLabel("Memory scope").selectOption("bot");
    await expect(page.getByLabel("Memory (Markdown)")).toHaveValue("WRITER_BROWSER_MEMORY");
    await page.getByRole("button", { name: "Remove memory", exact: true }).click();
    await expect(page.locator("#memory-status")).toHaveText("Memory removed");
    await expect(page.getByLabel("Memory (Markdown)")).toHaveValue("");
    await page.getByLabel("Memory scope").selectOption("owner");
    await page.getByRole("button", { name: "Remove memory", exact: true }).click();
    await expect(page.locator("#memory-status")).toHaveText("Memory removed");
    await page.getByRole("button", { name: "Close memory", exact: true }).click();
    await page.reload();
    await page.getByRole("button", { name: "Memory", exact: true }).click();
    await expect(page.getByLabel("Memory (Markdown)")).toHaveValue("");
    await page.getByRole("button", { name: "Close memory", exact: true }).click();
    await expect(page.locator("#stop")).toBeDisabled();
    await page.reload();
    await expect(page.locator(".tool-steps").first()).toContainText("Path escapes");
    await page.getByLabel("Message", { exact: true }).fill("Render safe Markdown");
    await page.getByLabel("Message", { exact: true }).press("Shift+Enter");
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Render safe Markdown\n");
    await page.getByLabel("Message", { exact: true }).press("Enter");
    const rendered = page.locator("article.assistant").filter({ hasText: "Safe Markdown" });
    await expect(rendered.locator("strong")).toHaveText("Safe Markdown");
    await expect(rendered.locator("script, img")).toHaveCount(0);
    await expect(rendered.locator("a")).toHaveCount(1);
    await expect(rendered.locator("a")).toHaveAttribute("href", "https://example.com");
    await expect(rendered).toContainText('<script>throw new Error("unsafe")</script>');
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await rendered.getByRole("button", { name: "Copy code" }).click();
    await expect(rendered.getByRole("status")).toHaveText("Copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      'const value = "copied";',
    );
    await page.getByRole("button", { name: "Bot settings", exact: true }).click();
    await expect(page.getByLabel("Bot name", { exact: true })).toBeFocused();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("button", { name: "Bot settings", exact: true })).toBeFocused();
    expect(pageErrors).toEqual([]);
    expect(errors).toBe("");
  } finally {
    release();
    child.kill("SIGTERM");
    await exited;
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
