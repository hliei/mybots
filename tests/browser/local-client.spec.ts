import { type ChildProcess, fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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
    await page.getByLabel("Session name", { exact: true }).fill("Sources");
    await page.getByRole("button", { name: "Create session", exact: true }).click();
    await expect(page.locator("#selected-chat")).toContainText("Sources");
    await page.getByLabel("Message", { exact: true }).fill("Research first");
    let lostMessage = false;
    await page.route("**/api/sessions/*/messages", async (route) => {
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
    await page.getByLabel("Session name", { exact: true }).fill("Analysis");
    await page.getByRole("button", { name: "Create session", exact: true }).click();
    await page.getByLabel("Message", { exact: true }).fill("Hold chat");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.locator("#chat-works")).toContainText("Execution: active");
    await page.getByLabel("Message", { exact: true }).fill("Follow-up");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.locator("#chat-works .chat-input")).toHaveCount(2);
    await expect(page.locator("#chat-works article")).toHaveCount(1);
    await page.getByRole("button", { name: "Select Writer", exact: true }).click();
    await page.getByLabel("Session name", { exact: true }).fill("Draft");
    await page.getByRole("button", { name: "Create session", exact: true }).click();
    await page.getByLabel("Message", { exact: true }).fill("Write independently");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.locator("#chat-works")).toContainText("Final: Write independently");
    await expect(page.locator("#chat-works")).not.toContainText("Research first");
    await page.getByRole("button", { name: "Select Researcher", exact: true }).click();
    await expect(page.locator("#chat-works")).toContainText("Execution: active");
    child?.send("complete-chat");
    await page.getByRole("button", { name: "Refresh status" }).click();
    await expect(page.locator("#chat-works")).toContainText("Outcome: succeeded");
    await expect(page.locator("#chat-works")).toContainText("Final: Follow-up");
    await page.getByRole("button", { name: "Select session Sources", exact: true }).click();
    await expect(page.locator("#chat-works")).toContainText("Final: Research first");
    await expect(page.locator("#chat-works")).not.toContainText("Follow-up");
    await page.getByLabel("Rename session").fill("Research sources");
    await page.getByRole("button", { name: "Save session name", exact: true }).click();
    await expect(page.locator("#selected-chat")).toContainText("Research sources");
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
    await page.reload();
    await expect(page.locator("#bots")).toContainText(ready.sessionId);
    await expect(page.locator("#bots")).toContainText("Container: stopped");
    await expect(page.locator("#selected-bot")).toContainText("Researcher");
    await expect(page.locator("#selected-chat")).toContainText("Research sources");
    await expect(page.locator("#chat-works")).toContainText("Final: Research first");
    await expect(page.locator("#chat-works article")).toHaveCount(1);
    await page.getByRole("button", { name: "Select Writer", exact: true }).click();
    await expect(page.locator("#selected-bot")).toContainText("Write clear reports.");
    await expect(page.getByRole("button", { name: /save settings|edit bot/i })).toHaveCount(0);
    await expect(page.getByLabel("Connection credential")).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    if (child) await stop();
    await rm(root, { recursive: true, force: true });
  }
});
