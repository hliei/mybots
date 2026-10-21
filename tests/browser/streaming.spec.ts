import { type ChildProcess, fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

async function historyHost() {
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
  return {
    start,
    stop,
    get child() {
      return child;
    },
    close: async () => {
      if (child) await stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("streamed replies grow in one correlated bubble and recover as one original", async ({
  page,
}) => {
  const runtime = await historyHost();
  const { start, stop } = runtime;
  try {
    const ready = await start();
    let drop = false;
    await page.routeWebSocket("**/ws", (socket) => {
      const server = socket.connectToServer();
      server.onMessage((data) => {
        if (!drop) socket.send(data);
      });
    });
    await page.goto(ready.url);
    await page.getByLabel("Connection credential").fill(ready.credential);
    await page.getByRole("button", { name: "Pair with Host" }).click();
    await page.getByRole("button", { name: "Select Personal", exact: true }).click();
    await page.getByLabel("Message", { exact: true }).fill("Stream reply");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    const reply = page
      .locator("#thread-messages article.assistant")
      .filter({ hasText: "A growing reply" });
    await expect(reply).toHaveCount(1);
    await expect(reply).toContainText("In progress");
    const identity = await reply.getAttribute("data-message-id");
    await reply.evaluate((element) => Reflect.set(element, "streamBubble", true));
    drop = true;
    runtime.child?.send("stream-more");
    await expect(reply).toContainText("with original text 🪐");
    await expect(reply).toHaveAttribute("data-message-id", identity as string);
    expect(await reply.evaluate((element) => Reflect.get(element, "streamBubble"))).toBe(true);
    await page.reload();
    await expect(reply).toContainText("with original text 🪐");
    await reply.evaluate((element) => Reflect.set(element, "streamBubble", true));
    runtime.child?.send("stream-end");
    await expect(reply).not.toContainText("In progress");
    await expect(reply).toHaveCount(1);
    await expect(reply).toHaveAttribute("data-message-id", identity as string);
    expect(await reply.evaluate((element) => Reflect.get(element, "streamBubble"))).toBe(true);
    const original = await page.evaluate(async () =>
      (await fetch("/api/bots/personal/thread/history")).json(),
    );
    expect(original.messages.filter((message: { id: string }) => message.id === identity)).toEqual([
      expect.objectContaining({ role: "assistant", text: "A growing reply with original text 🪐" }),
    ]);
    await stop();
    await start(Number(new URL(ready.url).port));
    await page.reload();
    await expect(reply).toHaveCount(1);
    await expect(reply).toHaveAttribute("data-message-id", identity as string);
    await expect(reply).not.toContainText("In progress");
  } finally {
    await runtime.close();
  }
});

test("history anchors survive live output, Bot switching and panel reflow", async ({ page }) => {
  const runtime = await historyHost();
  const { start } = runtime;
  try {
    const ready = await start();
    let disconnect: (() => Promise<void>) | undefined;
    await page.routeWebSocket("**/ws", (socket) => {
      socket.connectToServer();
      disconnect = () => socket.close({ code: 1012, reason: "Controlled observer reconnect" });
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(ready.url);
    await page.getByLabel("Connection credential").fill(ready.credential);
    await page.getByRole("button", { name: "Pair with Host" }).click();
    await page.getByRole("button", { name: "Select Personal", exact: true }).click();
    const region = page.locator(".timeline");
    await page.getByLabel("Message", { exact: true }).fill("Read long original");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.locator("#thread-messages")).toContainText("Long original begins");
    await expect
      .poll(() => region.evaluate((e) => e.scrollHeight - e.scrollTop - e.clientHeight))
      .toBeLessThan(2);
    await region.evaluate((e) => {
      e.scrollTop = 200;
    });
    await expect(page.getByRole("button", { name: "Back to latest" })).toBeVisible();
    const anchor = page
      .locator("#thread-messages article")
      .filter({ hasText: "Long original begins" });
    const offset = () => anchor.evaluate((e) => e.getBoundingClientRect().top);
    await anchor.evaluate((e) => {
      const region = e.closest(".timeline") as HTMLElement;
      region.scrollTop += e.getBoundingClientRect().top - region.getBoundingClientRect().top + 100;
    });
    await expect.poll(() => region.evaluate((e) => e.scrollTop)).toBeGreaterThan(200);
    const before = await offset();
    await page.getByLabel("Message", { exact: true }).fill("Stream reply");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.locator("#thread-messages")).toContainText("A growing reply");
    await expect.poll(async () => Math.abs((await offset()) - before)).toBeLessThan(5);
    runtime.child?.send("stream-more");
    await expect(page.locator("#thread-messages")).toContainText("with original text 🪐");
    await expect.poll(async () => Math.abs((await offset()) - before)).toBeLessThan(5);
    await page.getByRole("button", { name: "Bot details: Personal" }).click();
    await expect(page.getByRole("button", { name: "Close details" })).toBeVisible();
    await expect.poll(async () => Math.abs((await offset()) - before)).toBeLessThan(5);
    await page.getByRole("button", { name: "Close details" }).click();
    await expect.poll(async () => Math.abs((await offset()) - before)).toBeLessThan(5);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect.poll(async () => Math.abs((await offset()) - before)).toBeLessThan(5);
    await page.getByRole("button", { name: "Create a Bot", exact: true }).click();
    await page.getByLabel("Bot name").fill("Reader");
    await page.getByLabel("Role instructions").fill("Read carefully.");
    await page.getByLabel("Model", { exact: true }).selectOption("deepseek/deepseek-chat");
    await page.getByRole("button", { name: "Create Bot", exact: true }).click();
    await expect(page.getByRole("button", { name: "Bot details: Reader" })).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 940 });
    await page.getByLabel("Message", { exact: true }).fill("Panel reflow reply");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.locator("#thread-messages")).toContainText("A line of conversation");
    await page.getByRole("button", { name: "Bot details: Reader" }).click();
    await expect
      .poll(() => region.evaluate((e) => e.scrollHeight - e.clientHeight))
      .toBeGreaterThan(100);
    await region.evaluate((e) => {
      e.scrollTop = 100;
    });
    await expect(page.getByRole("button", { name: "Back to latest" })).toBeVisible();
    const readingTop = await region.evaluate((e) => e.scrollTop);
    await page.getByRole("button", { name: "Close details" }).click();
    await expect
      .poll(() => region.evaluate((e) => e.scrollHeight - e.clientHeight))
      .toBeLessThan(2);
    await expect(page.getByRole("button", { name: "Back to latest" })).toBeVisible();
    await page.getByRole("button", { name: "Bot details: Reader" }).click();
    await expect
      .poll(async () => Math.abs((await region.evaluate((e) => e.scrollTop)) - readingTop))
      .toBeLessThan(2);
    await page.getByRole("button", { name: "Back to latest" }).click();
    await expect
      .poll(() => region.evaluate((e) => e.scrollHeight - e.scrollTop - e.clientHeight))
      .toBeLessThan(2);
    await page.getByRole("button", { name: "Close details" }).click();
    await page.getByRole("button", { name: "Bot details: Reader" }).click();
    await expect
      .poll(() => region.evaluate((e) => e.scrollHeight - e.scrollTop - e.clientHeight))
      .toBeLessThan(2);
    await page.getByRole("button", { name: "Close details" }).click();
    await page.getByRole("button", { name: "Select Personal", exact: true }).click();
    await expect(anchor).toBeVisible();
    await expect.poll(async () => Math.abs((await offset()) - before)).toBeLessThan(5);
    runtime.child?.send("stream-end");
    await expect(page.locator("article.live-message")).toHaveCount(0);
    await expect.poll(async () => Math.abs((await offset()) - before)).toBeLessThan(5);
    const latestRead = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith("/thread/history") &&
        !new URL(response.url()).search,
    );
    await page.getByRole("button", { name: "Back to latest" }).click();
    await (await latestRead).finished();
    await expect(page.locator("#thread-messages article")).toHaveCount(5);
    await expect
      .poll(() => region.evaluate((e) => e.scrollHeight - e.scrollTop - e.clientHeight))
      .toBeLessThan(2);
    await expect(page.getByRole("button", { name: "Back to latest" })).toBeHidden();
    await region.evaluate((e) => {
      e.scrollTop = 0;
    });
    await expect(page.getByRole("button", { name: "Back to latest" })).toBeVisible();
    const first = page.locator("#thread-messages article").first();
    const firstId = await first.getAttribute("data-message-id");
    const firstTop = await first.evaluate((e) => e.getBoundingClientRect().top);
    await page
      .getByRole("button", { name: "Older originals", exact: true })
      .evaluate((e) => (e as HTMLButtonElement).click());
    await expect(page.locator("#thread-messages")).toContainText("original 0");
    const retained = page.locator(`[data-message-id="${firstId}"]`);

    await expect
      .poll(async () =>
        Math.abs((await retained.evaluate((e) => e.getBoundingClientRect().top)) - firstTop),
      )
      .toBeLessThan(5);
    const repaired = page.waitForResponse(
      (response) =>
        response.url().includes("/thread/history?") && response.url().includes("beforeSeq="),
    );
    await disconnect?.();
    await (await repaired).finished();
    await expect(retained).toHaveCount(1);
    await expect
      .poll(async () =>
        Math.abs((await retained.evaluate((e) => e.getBoundingClientRect().top)) - firstTop),
      )
      .toBeLessThan(5);
    for (const viewport of [
      { width: 1280, height: 900 },
      { width: 1440, height: 900 },
      { width: 1920, height: 1080 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(page.getByRole("button", { name: "Back to latest" })).toBeVisible();
      await expect
        .poll(async () =>
          Math.abs((await retained.evaluate((e) => e.getBoundingClientRect().top)) - firstTop),
        )
        .toBeLessThan(5);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: `/tmp/mybots-stream-reading-${viewport.width}.png` });
    }
  } finally {
    await runtime.close();
  }
});
