import { type ChildProcess, fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { showFeature } from "./navigation.ts";

test("real Pi history, lost live frames, reload and Host restart preserve usable originals", async ({
  page,
}) => {
  const root = await mkdtemp(join(tmpdir(), "mybots-history-browser-"));
  let child: ChildProcess | undefined;
  let exit: Promise<number | null> | undefined;
  async function start(port = 0) {
    const process = fork(
      fileURLToPath(new URL("../../scripts/client-history-host.mjs", import.meta.url)),
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
    // Intentionally discard observer frames. Public snapshots must repair them.
    await page.routeWebSocket("**/ws", (socket) => {
      const server = socket.connectToServer();
      server.onMessage(() => {});
    });
    await page.goto(ready.url);
    await expect(page).toHaveTitle("Mybots · Bots");
    await page.getByLabel("Connection credential").fill(ready.credential);
    await page.getByRole("button", { name: "Pair with Host" }).click();
    await showFeature(page, "chat");
    await page.getByRole("button", { name: "Select Personal", exact: true }).click();
    await expect(page.locator("#selected-chat")).toContainText("Thread ID:");
    phase = "connected";
    await showFeature(page, "chat");
    await page.getByLabel("Message", { exact: true }).fill("Inspect original history");
    await showFeature(page, "chat");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.locator("#live-execution")).toContainText("Live original lookup");
    await expect(page.locator("#chat-works article").last()).toContainText("Outcome: unresolved");
    await page.reload();
    await expect(page.locator("#live-execution")).toContainText("Live original lookup");
    await showFeature(page, "tasks");
    await page
      .locator("#chat-works article")
      .last()
      .getByRole("button", { name: "Inspect Run evidence" })
      .click();
    await expect(page.locator("#run-history")).toContainText("search_history");
    await page.getByRole("button", { name: "Run inputs", exact: true }).click();
    await expect(page.locator("#run-history")).toContainText("Inspect original history");
    child?.send("complete");
    await expect(page.locator("#chat-works article").last()).toContainText("Outcome: succeeded");
    await expect(page.locator("#thread-messages")).toContainText("Original evidence recovered");
    await page.getByRole("button", { name: "Older originals", exact: true }).click();
    await expect(page.locator("#thread-messages")).toContainText("original 0");
    await showFeature(page, "search");
    await page.getByLabel("Search original history").fill("火星项目");
    await showFeature(page, "search");
    await page.getByRole("button", { name: "Search history", exact: true }).click();
    await expect(page.locator("#thread-messages")).toContainText("火星项目");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator("#chat-heading").scrollIntoViewIfNeeded();
    await page.screenshot({ path: "/tmp/mybots-history-desktop.png" });
    await page.setViewportSize({ width: 1920, height: 1080 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.locator("#chat-heading").scrollIntoViewIfNeeded();
    await page.screenshot({ path: "/tmp/mybots-history-wide.png" });
    phase = "restarting";
    await stop();
    await start(Number(new URL(ready.url).port));
    await page.reload();
    await expect(page.locator("#thread-messages")).toContainText("Original evidence recovered");
    await showFeature(page, "tasks");
    await page
      .locator("#chat-works article")
      .last()
      .getByRole("button", { name: "Inspect Run evidence" })
      .click();
    await expect(page.locator("#run-history")).toContainText("search_history");
    phase = "connected";
    expect(errors).toEqual([]);
  } finally {
    if (child) await stop();
    await rm(root, { recursive: true, force: true });
  }
});
