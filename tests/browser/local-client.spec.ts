import { type ChildProcess, fork } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

interface Ready {
  url: string;
  credential: string;
  sessionId: string;
}

test("pair, inspect execution, reload and return after a fresh built Host starts", async ({
  page,
  context,
}) => {
  const root = await mkdtemp(join(tmpdir(), "mybots-browser-"));
  let child: ChildProcess | undefined;
  let exited: Promise<number | null> | undefined;
  async function start(port = 0): Promise<Ready> {
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
    exited = new Promise((resolve, reject) => {
      process.once("exit", resolve);
      process.once("error", reject);
    });
    return Promise.race([
      new Promise<Ready>((resolve) =>
        process.once("message", (message) => resolve(message as Ready)),
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
    await page.goto(ready.url);
    await expect(page).toHaveTitle("Mybots · Bots");
    await expect(page.getByLabel("Connection credential")).toBeVisible();
    await page.getByLabel("Connection credential").fill("incorrect");
    await page.getByRole("button", { name: "Pair with Host" }).click();
    await expect(page.getByRole("status")).toContainText("credential rejected");
    await page.getByLabel("Connection credential").fill(ready.credential);
    await page.getByRole("button", { name: "Pair with Host" }).click();
    await expect(page.getByRole("heading", { name: "Personal", exact: true })).toBeVisible();
    await expect(page.locator("#bots")).toContainText(ready.sessionId);
    await expect(page.locator("#bots")).toContainText("1 processing");
    child?.send("complete");
    await page.getByRole("button", { name: "Refresh status" }).click();
    await expect(page.locator("#bots")).toContainText("1 acknowledged");
    await page.getByLabel("Bot name").fill("Researcher");
    await page.getByLabel("Role instructions").fill("Investigate sources.");
    await page.getByLabel("Model", { exact: true }).selectOption("deepseek/deepseek-chat");
    await page.getByLabel("write", { exact: true }).check();
    let lostResponse = false;
    await page.route("**/api/bots", async (route) => {
      if (route.request().method() === "POST" && !lostResponse) {
        lostResponse = true;
        await route.fetch();
        await route.abort();
      } else await route.continue();
    });
    await page.getByRole("button", { name: "Create Bot", exact: true }).click();
    await expect(page.locator("#create-message")).toContainText("unconfirmed");
    await page.reload();
    await page.getByRole("button", { name: "Retry creation", exact: true }).click();
    await expect(
      page.locator("#bots").getByRole("heading", { name: "Researcher", exact: true }),
    ).toHaveCount(1);
    await expect(page.locator("#selected-bot")).toContainText("Researcher");
    await expect(page.locator("#selected-bot")).toContainText("Investigate sources.");
    await page.getByLabel("Bot name").fill("Writer");
    await page.getByLabel("Role instructions").fill("Write clear reports.");
    await page.getByLabel("Model", { exact: true }).selectOption("deepseek/deepseek-reasoner");
    await page.getByLabel("edit", { exact: true }).check();
    await page.getByRole("button", { name: "Create Bot", exact: true }).click();
    await expect(page.locator("#selected-bot")).toContainText("Writer");
    await expect(page.locator("#selected-bot")).toContainText("deepseek-reasoner");
    await page.getByRole("button", { name: "Select Researcher", exact: true }).click();
    await expect(page.locator("#selected-bot")).toContainText("Investigate sources.");
    await expect(page.locator("#selected-chat")).toContainText("Thread ID:");
    await page.getByLabel("Message", { exact: true }).fill("Research first");
    let lostMessage = false;
    await page.route("**/api/bots/*/thread/messages", async (route) => {
      if (!lostMessage) {
        lostMessage = true;
        await route.fetch();
        await route.abort();
      } else await route.continue();
    });
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.locator("#chat-message")).toContainText("unconfirmed");
    await page.reload();
    await page.getByRole("button", { name: "Retry chat request", exact: true }).click();
    await expect(page.locator("#chat-works")).toContainText("Final: Research first");
    await expect(page.locator("#chat-works article")).toHaveCount(1);
    await page.getByLabel("Message", { exact: true }).fill("Hold chat");
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await expect(page.locator("#chat-works article").nth(1)).toContainText("Execution: active");
    await page.getByLabel("Message", { exact: true }).fill("Independent work");
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await expect(page.locator("#chat-works article").nth(2)).toContainText("Execution: queued");
    await expect(page.locator("#chat-works article").nth(2)).toContainText("interactive");
    await expect(page.locator("#chat-works article").nth(2)).toContainText("position 1");
    await expect(page.locator("#selected-chat")).toContainText("1 of 4 active");
    const executing = await page
      .locator("#chat-works article")
      .nth(1)
      .getByText("is executing")
      .textContent();
    const target = await page.locator("#chat-works article").nth(1).getAttribute("data-task-id");
    await page.getByLabel("Input target").selectOption(target as string);
    await page.getByLabel("Message", { exact: true }).fill("Follow-up");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.locator("#chat-works article").nth(1)).toContainText("Follow-up");
    await expect(page.locator("#chat-works article").nth(1)).toContainText(executing ?? "");
    await expect(page.locator("#chat-works article").nth(2)).not.toContainText("Follow-up");
    await page.getByRole("button", { name: "Select Writer", exact: true }).click();
    await page.getByLabel("Message", { exact: true }).fill("Write independently");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.locator("#chat-works")).toContainText("Final: Write independently");
    await expect(page.locator("#chat-works")).not.toContainText("Research first");
    await page.getByRole("button", { name: "Select Researcher", exact: true }).click();
    await expect(page.locator("#chat-works article").nth(1)).toContainText("Execution: active");
    await expect(page.locator("#chat-works article").nth(1)).toContainText(executing ?? "");
    for (const name of ["North", "South", "East"]) {
      await page.getByLabel("Bot name").fill(name);
      await page.getByLabel("Role instructions").fill(`${name} holds a slot.`);
      await page.getByLabel("Model", { exact: true }).selectOption("deepseek/deepseek-chat");
      await page.getByLabel("write", { exact: true }).check();
      await page.getByRole("button", { name: "Create Bot", exact: true }).click();
      await expect(page.locator("#selected-bot")).toContainText(name);
      await page.getByLabel("Message", { exact: true }).fill("Hold slot");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await expect(page.locator("#chat-works")).toContainText("Execution: active");
    }
    await page.getByLabel("Bot name").fill("West");
    await page.getByLabel("Role instructions").fill("West waits for a slot.");
    await page.getByLabel("Model", { exact: true }).selectOption("deepseek/deepseek-chat");
    await page.getByLabel("write", { exact: true }).check();
    await page.getByRole("button", { name: "Create Bot", exact: true }).click();
    await expect(page.locator("#selected-bot")).toContainText("West");
    await page.getByLabel("Message", { exact: true }).fill("West waits");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.locator("#selected-chat")).toContainText("4 of 4 active");
    await expect(page.locator("#chat-works")).toContainText("Execution: queued");
    await expect(page.locator("#chat-works")).toContainText("West waits");
    await page.getByRole("button", { name: "Select Researcher", exact: true }).click();
    await expect(page.locator("#chat-works article").nth(1)).toContainText(executing ?? "");
    await expect(page.locator("#chat-works article").nth(2)).toContainText("Execution: queued");
    const capacityPort = Number(new URL(ready.url).port);
    await stop();
    await start(capacityPort);
    await page.getByRole("button", { name: "Refresh status" }).click();
    await expect(page.getByRole("status")).toContainText("Connected");
    await page.getByRole("button", { name: "Select West", exact: true }).click();
    // Stopped containers are not executing during recovery backoff, so the cap stays honest.
    await expect(page.locator("#selected-chat")).toContainText(/[0-4] of 4 active/);
    await expect(page.locator("#chat-works article")).toHaveCount(1);
    await expect(page.locator("#chat-works")).toContainText("West waits");
    child?.send("release-slots");
    child?.send("complete");
    child?.send("complete-chat");
    await page.getByRole("button", { name: "Select Researcher", exact: true }).click();
    await page.getByRole("button", { name: "Refresh status" }).click();
    await expect(page.locator("#chat-works article").nth(1)).toContainText("Outcome: succeeded", {
      timeout: 20_000,
    });
    await expect(page.locator("#chat-works article").nth(2)).toContainText("Outcome: succeeded", {
      timeout: 20_000,
    });
    await expect(page.locator("#chat-works")).toContainText("Run ID:");
    await expect(page.locator("#chat-works")).toContainText("Attempt:");
    await page.getByLabel("Search original history").fill("Research");
    await page.getByRole("button", { name: "Search history", exact: true }).click();
    await expect(page.locator("#thread-messages")).toContainText("Research first");
    await page.getByRole("button", { name: "Latest originals", exact: true }).click();
    await expect(page.locator("#thread-messages")).toContainText("Independent work");
    await page.getByRole("button", { name: "Older originals", exact: true }).click();
    await expect(page.locator("#thread-messages")).toContainText("Research first");
    await page.getByRole("button", { name: "Inspect Run evidence", exact: true }).first().click();
    await expect(page.locator("#run-history")).toContainText("Recorded Run evidence");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator("#chat-heading").evaluate((element) => element.scrollIntoView());
    await page.screenshot({ path: "/tmp/mybots-thread-desktop.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.locator("#chat-heading").evaluate((element) => element.scrollIntoView());
    await page.screenshot({ path: "/tmp/mybots-thread-mobile.png" });
    await page.setViewportSize({ width: 1280, height: 900 });
    const cookie = (await context.cookies()).find((cookie) => cookie.name === "mybots_connection");
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Strict" });
    await page.reload();
    await expect(page.getByRole("heading", { name: "Personal", exact: true })).toBeVisible();
    await expect(page.getByLabel("Connection credential")).toBeHidden();
    await stop();
    await page.getByRole("button", { name: "Refresh status" }).click();
    await expect(page.getByRole("status")).toContainText("Host unavailable");
    const returned = await start(Number(new URL(ready.url).port));
    expect(returned.sessionId).toBe(ready.sessionId);
    await page.getByRole("button", { name: "Refresh status" }).click();
    await expect(page.getByRole("status")).toContainText("Connected");
    await page.getByRole("button", { name: "Select Writer", exact: true }).click();
    await page.getByLabel("Memory index", { exact: true }).fill("Writer prefers short paragraphs.");
    await page.getByRole("button", { name: "Save memory index", exact: true }).click();
    await expect(page.locator("#memory-message")).toContainText("Saved");
    await page.getByLabel("Topic", { exact: true }).fill("voice");
    await page.getByLabel("Topic text", { exact: true }).fill("Use plain words.");
    await page.getByRole("button", { name: "Save memory topic", exact: true }).click();
    await expect(page.locator("#memory-topics")).toContainText("voice");
    const skillSource = join(root, "reviewed-skill");
    await mkdir(skillSource);
    await writeFile(
      join(skillSource, "SKILL.md"),
      "---\nname: brief\ndescription: Reviewed brief\n---\nReviewed browser instructions.",
    );
    await page.getByLabel("Skill ID", { exact: true }).fill("brief");
    await page.getByLabel("Local Skill directory", { exact: true }).fill(skillSource);
    await page.getByRole("button", { name: "Import Skill for inspection", exact: true }).click();
    await expect(page.locator("#skill-library summary")).toContainText("brief");
    await page.locator("#skill-library summary").click();
    await expect(page.locator("#skill-library")).toContainText("Reviewed browser instructions.");
    await expect(page.locator("#selected-bot")).toContainText("Saved Skills: None");
    const revision = await page
      .getByLabel("Skill brief", { exact: true })
      .locator("option")
      .nth(1)
      .getAttribute("value");
    await page.getByLabel("Skill brief", { exact: true }).selectOption(revision as string);
    await page.getByLabel("Bot role").fill("Edited writer role.");
    await page.getByRole("button", { name: "Save configuration", exact: true }).click();
    await expect(page.locator("#settings-versions")).toContainText(
      "Saved and effective configuration 2",
    );
    await page.getByRole("button", { name: "Select Researcher", exact: true }).click();
    await stop();
    await start(Number(new URL(ready.url).port));
    await page.getByRole("button", { name: "Refresh status" }).click();
    await expect(page.getByRole("status")).toContainText("Connected");
    await page.reload();
    await expect(page.locator("#bots")).toContainText(ready.sessionId);
    await expect(page.locator("#bots")).toContainText("Container: stopped");
    await expect(page.locator("#selected-bot")).toContainText("Researcher");
    await expect(page.locator("#selected-chat")).toContainText("Thread ID:");
    await expect(page.locator("#chat-works")).toContainText("Final: Research first");
    await expect(page.locator("#chat-works article")).toHaveCount(3);
    await page.getByRole("button", { name: "Select Writer", exact: true }).click();
    await expect(page.locator("#selected-bot")).toContainText("Edited writer role.");
    await expect(page.locator("#selected-bot")).toContainText(`Saved Skills: brief@${revision}`);
    await expect(page.getByLabel("Skill brief", { exact: true })).toHaveValue(revision as string);
    await expect(page.getByLabel("Memory index", { exact: true })).toHaveValue(
      "Writer prefers short paragraphs.",
      { timeout: 15000 },
    );
    await expect(page.locator("#memory-topics")).toContainText("voice");
    await page.getByLabel("Memory index", { exact: true }).fill("Stale browser draft.");
    const memoryBot = (
      await page.locator("#selected-bot p").filter({ hasText: "Bot ID:" }).innerText()
    )
      .replace("Bot ID: ", "")
      .trim();
    expect(
      await page.evaluate(async (botId) => {
        const current = await fetch(`/api/bots/${botId}/memory`);
        const memory = (await current.json()) as { index: { version: string } };
        const response = await fetch(`/api/bots/${botId}/memory/index`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: "Intervening browser note.",
            version: memory.index.version,
          }),
        });
        return response.ok;
      }, memoryBot),
    ).toBe(true);
    await page.getByRole("button", { name: "Save memory index", exact: true }).click();
    await expect(page.locator("#memory-conflict")).toContainText("Intervening browser note.");
    await page.getByRole("button", { name: "Load observed memory", exact: true }).click();
    await expect(page.getByLabel("Memory index", { exact: true })).toHaveValue(
      "Intervening browser note.",
    );
    await page.getByRole("button", { name: "Delete memory index", exact: true }).click();
    await expect(page.locator("#memory-message")).toContainText("does not guarantee forgetting");
    await expect(page.getByLabel("Memory index", { exact: true })).toHaveValue("");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.locator("#settings-versions")).toContainText(
      "Saved and effective configuration 2",
    );
    await expect(page.getByLabel("Connection credential")).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    if (child) await stop();
    await rm(root, { recursive: true, force: true });
  }
});
