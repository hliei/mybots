import { type ChildProcess, fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

interface Ready {
  url: string;
  credential: string;
}

test("stop a Run, inspect late evidence, and keep an unconfirmed stop from blocking another Bot", async ({
  page,
}) => {
  const root = await mkdtemp(join(tmpdir(), "mybots-browser-stop-"));
  let child: ChildProcess | undefined;
  let exited: Promise<number | null> | undefined;
  async function start(): Promise<Ready> {
    const hostProcess = fork(
      fileURLToPath(new URL("../../scripts/client-browser-host.mjs", import.meta.url)),
      [root, "0"],
      { silent: true, env: { ...process.env, MYBOTS_HOLD_STOP: "1" } },
    );
    child = hostProcess;
    let stderr = "";
    hostProcess.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    exited = new Promise((resolve, reject) => {
      hostProcess.once("exit", resolve);
      hostProcess.once("error", reject);
    });
    return Promise.race([
      new Promise<Ready>((resolve) =>
        hostProcess.once("message", (message) => resolve(message as Ready)),
      ),
      exited.then(() => {
        throw new Error(`Browser Host stopped before ready: ${stderr}`);
      }),
    ]);
  }
  async function stop() {
    child?.send("allow-stop");
    child?.send("release-stop");
    child?.kill("SIGTERM");
    expect(await exited).toBe(0);
    child = undefined;
  }
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const ready = await start();
    await page.goto(ready.url);
    await page.getByLabel("Connection credential").fill(ready.credential);
    await page.getByRole("button", { name: "Pair with Host" }).click();
    await expect(page.getByRole("heading", { name: "Personal", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Select Personal", exact: true }).click();
    child?.send("complete");
    await page.getByRole("button", { name: "Refresh status" }).click();
    await expect(page.locator("#bots")).toContainText("1 acknowledged");
    await page.getByLabel("Message", { exact: true }).fill("Hold chat");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.locator("#chat-works")).toContainText("Execution: active");
    let lostStop = false;
    await page.route("**/api/bots/*/runs/*/stop", async (route) => {
      if (!lostStop) {
        lostStop = true;
        await route.fetch();
        await route.abort();
      } else await route.continue();
    });
    await page.getByRole("button", { name: "Stop run", exact: true }).click();
    await expect(page.locator("#chat-message")).toContainText("unconfirmed");
    await page.reload();
    await page.getByRole("button", { name: "Retry chat request", exact: true }).click();
    await expect(page.locator("#chat-works")).toContainText(
      "Stopping until termination is confirmed",
    );
    child?.send("release-stop");
    await expect(page.locator("#chat-works")).toContainText("Stopped before a final result.");
    await expect(page.locator("#chat-works")).toContainText("Hold chat");
    child?.send("write-late");
    await page.getByRole("button", { name: "Refresh status" }).click();
    await expect(page.locator("#chat-works")).toContainText(
      "Late result: Late evidence after stop",
    );
    await expect(page.locator("#chat-works")).toContainText("Outcome: cancelled");
    await page.getByLabel("Message", { exact: true }).fill("Hold chat");
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await expect(page.locator("#chat-works article").nth(2)).toContainText("Execution: active");
    child?.send("fail-stop");
    await page
      .locator("#chat-works article")
      .nth(2)
      .getByRole("button", { name: "Stop run" })
      .click();
    await expect(page.locator("#chat-works")).toContainText("Execution stop unconfirmed");
    await page.getByLabel("Message", { exact: true }).fill("Still queued");
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await expect(page.locator("#chat-works article").nth(3)).toContainText("Execution: queued");
    await page.getByLabel("Bot name").fill("Writer");
    await page.getByLabel("Role instructions").fill("Write clear reports.");
    await page.getByLabel("Model", { exact: true }).selectOption("deepseek/deepseek-chat");
    await page.getByRole("button", { name: "Create Bot", exact: true }).click();
    await expect(page.locator("#selected-bot")).toContainText("Writer");
    await page.getByLabel("Message", { exact: true }).fill("Writer continues");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.locator("#chat-works")).toContainText("Execution: active");
    await page.getByRole("button", { name: "Refresh status" }).click();
    await expect(page.locator("#chat-works")).toContainText("Final: Writer continues");
    await page.getByRole("button", { name: "Select Personal", exact: true }).click();
    await expect(page.locator("#chat-works article").nth(3)).toContainText("Execution: queued");
    await expect(page.locator("#chat-works")).toContainText("Execution stop unconfirmed");
    expect(errors).toEqual([]);
  } finally {
    if (child) await stop();
    await rm(root, { recursive: true, force: true });
  }
});
