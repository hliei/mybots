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

test("disable a Bot, enable it without revival, and logically delete it while keeping a same-name replacement distinct", async ({
  page,
}) => {
  const root = await mkdtemp(join(tmpdir(), "mybots-browser-bot-lifecycle-"));
  let child: ChildProcess | undefined;
  let exited: Promise<number | null> | undefined;
  async function start(): Promise<Ready> {
    const hostProcess = fork(
      fileURLToPath(new URL("../../scripts/client-browser-host.mjs", import.meta.url)),
      [root, "0"],
      { silent: true },
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
    child?.send("complete");
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
    await page.getByRole("button", { name: "Select Personal", exact: true }).click();
    const original = (await page.locator("#selected-bot").textContent()) ?? "";
    const originalId = original.match(/Bot ID: (\S+)/)?.[1];
    expect(originalId).toBeTruthy();
    child?.send("fail-stop");
    await page.getByRole("button", { name: "Disable Bot", exact: true }).click();
    await expect(page.locator("#bot-lifecycle")).toContainText("This Bot is disabled");
    await expect(page.locator("#chat-works")).toContainText("Execution stop unconfirmed");
    await expect(page.getByLabel("Message", { exact: true })).toBeDisabled();
    child?.send("allow-stop");
    await page.getByRole("button", { name: "Retry cancellation", exact: true }).click();
    await expect(page.locator("#chat-works")).toContainText("Stopped before a final result.");
    await expect(page.locator("#chat-works")).toContainText("Inspect this session");
    await expect(page.locator("#bot-lifecycle")).toContainText("does not revive cancelled work");
    await page.getByRole("button", { name: "Enable Bot", exact: true }).click();
    await expect(page.locator("#bot-lifecycle")).toContainText("Disabling blocks new chat");
    await expect(page.locator("#chat-works")).toContainText("Execution: closed");
    await expect(page.locator("#chat-works")).toContainText("Stopped before a final result.");
    await expect(page.getByLabel("Message", { exact: true })).toBeEnabled();
    await page.getByLabel("Message", { exact: true }).fill("Fresh note");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.locator("#chat-works").getByText("Execution: active")).toBeVisible();
    child?.send("complete");
    await expect(page.locator("#chat-works")).toContainText("Final: Fresh note");
    await expect(page.locator("#chat-works")).toContainText("Stopped before a final result.");
    const retention =
      "Logical deletion keeps this Bot's configuration, history, results, workspace, memory, and materials, including copies held by other Bots. It does not restore the Bot or permanently purge retained data.";
    await expect(page.locator("#selected-bot")).toContainText(retention);
    await page.getByRole("button", { name: "Logically delete Bot", exact: true }).click();
    await expect(page.locator("#bot-lifecycle")).toHaveText(retention);
    await expect(page.locator("#bots")).toContainText("Availability: deleted");
    await expect(page.locator("#chat-works")).toContainText("Final: Fresh note");
    await expect(page.getByLabel("Message", { exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Enable Bot" })).toHaveCount(0);
    await page.getByLabel("Bot name").fill("Personal");
    await page.getByLabel("Role instructions").fill("A replacement role.");
    await page.getByLabel("Model", { exact: true }).selectOption("deepseek/deepseek-chat");
    await page.getByRole("button", { name: "Create Bot", exact: true }).click();
    await expect(page.locator("#selected-bot")).toContainText("A replacement role.");
    const replacement = (await page.locator("#selected-bot").textContent()) ?? "";
    const replacementId = replacement.match(/Bot ID: (\S+)/)?.[1];
    expect(replacementId).toBeTruthy();
    expect(replacementId).not.toBe(originalId);
    expect(replacement).not.toContain(`Workspace: groups/${originalId}`);
    await page.getByRole("button", { name: "Select Personal" }).first().click();
    await expect(page.locator("#bot-lifecycle")).toHaveText(retention);
    await expect(page.locator("#chat-works")).toContainText("Inspect this session");
    expect(errors).toEqual([]);
  } finally {
    if (child) await stop();
    await rm(root, { recursive: true, force: true });
  }
});
