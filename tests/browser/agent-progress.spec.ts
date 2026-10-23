import { type ChildProcess, fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { showFeature } from "./navigation.ts";

test("published progress and selected result stay distinct from the Run outcome", async ({
  page,
}) => {
  const root = await mkdtemp(join(tmpdir(), "mybots-progress-browser-"));
  let child: ChildProcess | undefined;
  let exit: Promise<number | null> | undefined;
  async function start(port = 0) {
    const process = fork(
      fileURLToPath(new URL("../../scripts/client-progress-host.mjs", import.meta.url)),
      [root, String(port)],
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
  let phase: "unpaired" | "connected" | "restarting" = "unpaired";
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (phase === "unpaired" && text.includes("401 (Unauthorized)")) return;
    if (phase === "restarting" && text.includes("ERR_CONNECTION_REFUSED")) return;
    errors.push(text);
  });
  try {
    const ready = await start();
    await page.goto(ready.url);
    await expect(page).toHaveTitle("Mybots · Bots");
    await page.getByLabel("Connection credential").fill(ready.credential);
    await page.getByRole("button", { name: "Pair with Host" }).click();
    await showFeature(page, "chat");
    await page.getByRole("button", { name: "Select Personal", exact: true }).click();
    phase = "connected";
    await showFeature(page, "chat");
    await page.getByLabel("Message", { exact: true }).fill("Publish archive progress");
    await showFeature(page, "chat");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    const work = page.locator("#chat-works article").last();
    await expect(work).toContainText("Progress · Attempt");
    await expect(work).toContainText("Reading shelf 3");
    await expect(work).toContainText("Selected result · Attempt");
    await expect(work).toContainText("Shelf 3 holds the 1962 ledger");
    await expect(work).toContainText("Outcome: unresolved");
    await page.reload();
    await expect(work).toContainText("Reading shelf 3");
    await expect(work).toContainText("Outcome: unresolved");
    child?.send("complete");
    await expect(work).toContainText("Outcome: succeeded");
    await expect(work).toContainText("Final: Authoritative archive reply");
    await expect(work).toContainText("Shelf 3 holds the 1962 ledger");
    await page.setViewportSize({ width: 1280, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.setViewportSize({ width: 1920, height: 1080 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    phase = "restarting";
    await stop();
    await start(Number(new URL(ready.url).port));
    await page.reload();
    await expect(work).toContainText("Selected result · Attempt");
    await expect(work).toContainText("Outcome: succeeded");
    phase = "connected";
    expect(errors).toEqual([]);
  } finally {
    if (child) await stop();
    await rm(root, { recursive: true, force: true });
  }
});
