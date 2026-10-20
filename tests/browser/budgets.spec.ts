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

test("inspect budget exhaustion, confirmed stop and an explicit new-Run retry", async ({
  page,
}) => {
  const root = await mkdtemp(join(tmpdir(), "mybots-browser-budgets-"));
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
  try {
    const ready = await start();
    await page.goto(ready.url);
    await page.getByLabel("Connection credential").fill(ready.credential);
    await page.getByRole("button", { name: "Pair with Host" }).click();
    await page.getByRole("button", { name: "Select Personal", exact: true }).click();
    child?.send("complete");
    await expect(page.locator("#chat-works")).toContainText("Execution: succeeded");
    await page.getByLabel("Message", { exact: true }).fill("Hold chat");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    const task = page.locator("#chat-works article").nth(1);
    await expect(task).toContainText("Execution: active");
    await expect(task).toContainText("Active budget: 0.0 / 60 minutes");
    child?.send("exhaust-budget");
    await expect(task).toContainText("Execution: stopping");
    await expect(task).toContainText("exhausted; completed effects are retained");
    await expect(task).toContainText("Stopping until termination is confirmed");
    child?.send("release-stop");
    await expect(task).toContainText("Execution: closed");
    await task.getByRole("button", { name: "Retry run", exact: true }).click();
    await expect(task).toContainText("Active budget: 0.0 / 60 minutes");
    await expect(task).toContainText("Execution: active");
    await page.reload();
    await expect(page.locator("#chat-works article").nth(1)).toContainText(
      "exhausted; completed effects are retained",
    );
    await expect(page.locator("#chat-works article").nth(1)).toContainText(
      "Active budget: 0.0 / 60 minutes",
    );
  } finally {
    if (child) await stop();
    await rm(root, { recursive: true, force: true });
  }
});
