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
    await expect(page.getByRole("button", { name: /create|chat/i })).toHaveCount(0);
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
    await expect(page.getByLabel("Connection credential")).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    if (child) await stop();
    await rm(root, { recursive: true, force: true });
  }
});
