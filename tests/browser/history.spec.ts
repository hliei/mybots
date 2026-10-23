import { type ChildProcess, fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  codeOriginal,
  longCodeOriginal,
  longOriginal,
  markdownOriginal,
} from "../message-content.ts";
import { showFeature } from "./navigation.ts";

test("real Pi history, lost live frames, reload and Host restart preserve usable originals", async ({
  page,
  context,
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
  const remoteRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).hostname === "example.com") remoteRequests.push(request.url());
  });
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
    const toolActivity = page.locator("#live-execution details").first();
    const toolSummary = toolActivity.locator("summary");
    await toolSummary.focus();
    await toolSummary.press("Space");
    await expect(toolActivity).toHaveAttribute("open", "");
    // Refresh without deliberately moving focus away from the live disclosure.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const observer = new MutationObserver(() => {
            observer.disconnect();
            requestAnimationFrame(() => resolve());
          });
          observer.observe(document.getElementById("live-execution") as HTMLElement, {
            childList: true,
            subtree: true,
          });
          document.getElementById("refresh")?.click();
        }),
    );
    await expect(toolSummary).toBeFocused();
    await expect(toolActivity).toHaveAttribute("open", "");
    await toolSummary.press("Space");
    await expect(toolActivity).not.toHaveAttribute("open");
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
    const reply = page.locator("#thread-messages article.assistant").last();
    await expect(reply.locator("strong")).toHaveText("bold");
    await expect(reply.locator("em")).toHaveText("emphasis");
    await expect(reply.locator("ol")).toHaveAttribute("start", "3");
    await expect(reply.locator("ul ul")).toContainText("Nested item");
    await expect(reply.locator("table")).toContainText("Enabled");
    await expect(reply.getByRole("link", { name: "documentation", exact: true })).toHaveAttribute(
      "href",
      "https://example.com/docs",
    );
    await expect(reply.locator("script, img, iframe, object, embed, svg")).toHaveCount(0);
    await expect(reply.locator('a:not([href^="https://"])')).toHaveCount(0);
    expect(await page.evaluate(() => Reflect.get(globalThis, "markdownExecuted"))).toBeUndefined();
    expect(remoteRequests).toEqual([]);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await reply.getByRole("button", { name: "Copy code", exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(codeOriginal);
    await reply.getByRole("button", { name: "Copy message", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(markdownOriginal);
    await page.getByRole("button", { name: "Older originals", exact: true }).click();
    await expect(page.locator("#thread-messages")).toContainText("original 0");
    await showFeature(page, "search");
    await page.getByLabel("Search original history").fill("火星项目");
    await showFeature(page, "search");
    await page.getByRole("button", { name: "Search history", exact: true }).click();
    await expect(page.getByRole("region", { name: "Conversation search results" })).toContainText(
      "火星项目",
    );
    const boundedResults = page.getByRole("region", { name: "Conversation search results" });
    await expect(boundedResults.locator("article")).toHaveCount(5);
    await page.getByRole("button", { name: "More search results" }).click();
    await expect(boundedResults.locator("article")).toHaveCount(1);
    await expect(boundedResults).toContainText("original 0");
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
    await showFeature(page, "chat");
    await page.getByLabel("Message", { exact: true }).fill("Read long original");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.locator("#thread-messages")).toContainText("Long original begins");
    const longReply = page.locator("#thread-messages article.assistant").last();
    const originalId = await longReply.getAttribute("data-message-id");
    expect(originalId).toBeTruthy();
    await longReply.evaluate((element) => {
      const timeline = element.closest(".timeline") as HTMLElement;
      timeline.scrollTop +=
        element.getBoundingClientRect().top - timeline.getBoundingClientRect().top + 80;
    });
    await expect(page.getByRole("button", { name: "Back to latest" })).toBeVisible();
    const readingOffset = await longReply.evaluate(
      (element) => element.getBoundingClientRect().top,
    );
    await showFeature(page, "search");
    await page.getByLabel("Search original history").fill("original 0");
    await page.getByRole("button", { name: "Search history", exact: true }).click();
    const results = page.getByRole("region", { name: "Conversation search results" });
    await expect(results).toContainText("original 0");
    await expect(page.locator("#thread-messages")).toContainText("Long original begins");
    await results.getByRole("button", { name: "Read surrounding originals" }).first().click();
    await expect(page.locator("#thread-messages")).toContainText("original 0");
    await page.getByRole("button", { name: "Close details" }).click();
    await expect(page.locator("#thread-messages")).toContainText("Long original begins");
    await expect
      .poll(async () =>
        Math.abs(
          (await longReply.evaluate((element) => element.getBoundingClientRect().top)) -
            readingOffset,
        ),
      )
      .toBeLessThan(5);

    for (const viewport of [
      { width: 1280, height: 900 },
      { width: 1440, height: 900 },
      { width: 1920, height: 1080 },
    ]) {
      await page.setViewportSize(viewport);
      expect(
        await longReply.evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
    const time = longReply.locator("time");
    const recorded = await page.evaluate(async () => {
      const response = await fetch("/api/bots/personal/thread/history");
      return response.json();
    });
    const original = recorded.messages.find((message: { id: string }) => message.id === originalId);
    await expect(time).toHaveAttribute("datetime", original.createdAt);
    await expect(page.locator(".date-group").last()).toHaveText(
      new Date(original.createdAt).toLocaleDateString(undefined, { dateStyle: "long" }),
    );
    await longReply.getByRole("button", { name: "Copy message", exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(longOriginal);
    await longReply.getByRole("button", { name: "Copy code", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(longCodeOriginal);
    let visibleLength = (await longReply.locator(".message-content").innerText()).length;
    while (
      await page.getByRole("button", { name: "Continue original text", exact: true }).isVisible()
    ) {
      const segment = page.locator(`#thread-messages article[data-message-id="${originalId}"]`);
      const text = await segment.locator(".message-content").innerText();
      expect(text).toContain("Long original begins");
      await segment.getByRole("button", { name: "Continue original text", exact: true }).click();
      await expect
        .poll(async () => (await segment.locator(".message-content").innerText()).length)
        .toBeGreaterThan(visibleLength);
      visibleLength = (await segment.locator(".message-content").innerText()).length;
    }
    await expect(page.locator("#thread-messages")).toContainText("Long original ends 🪐");
    await expect(page.locator("#thread-messages pre code")).toHaveText(longCodeOriginal);
    await showFeature(page, "search");
    await page.getByLabel("Search original history").fill("Long original begins");
    await page.getByRole("button", { name: "Search history", exact: true }).click();
    await expect(page.getByRole("region", { name: "Conversation search results" })).toContainText(
      "Long original begins",
    );
    await page
      .getByRole("region", { name: "Conversation search results" })
      .getByRole("button", { name: "Read surrounding originals" })
      .click();
    await longReply.getByRole("button", { name: "Continue original text", exact: true }).click();
    await expect
      .poll(async () => (await longReply.locator(".message-content").innerText()).length)
      .toBeGreaterThan(3000);
    await expect(longReply.locator(".message-content")).not.toContainText("Long original ends 🪐");
    await page.getByRole("button", { name: "Close details" }).click();
    await expect(longReply.locator(".message-content")).toContainText(
      /Long original begins[\s\S]*Long original ends 🪐/,
    );

    const afterCopy = await page.evaluate(async () =>
      (await fetch("/api/bots/personal/thread/history")).json(),
    );
    expect(afterCopy).toEqual(recorded);
    await showFeature(page, "search");
    await page.getByRole("button", { name: "Latest originals", exact: true }).click();
    const user = page.locator("#thread-messages article.user").last();
    await user.getByRole("button", { name: "Copy message", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("Read long original");
    await page.getByLabel("Message", { exact: true }).fill("Read wide original");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.locator("#thread-messages")).toContainText("Wide content");
    const wideReply = page.locator("#thread-messages article.assistant").last();
    await expect(wideReply.getByRole("table")).toContainText("Column 14");
    for (const viewport of [
      { width: 1280, height: 900 },
      { width: 1440, height: 900 },
      { width: 1920, height: 1080 },
    ]) {
      await page.setViewportSize(viewport);
      for (const region of [
        wideReply.locator("pre"),
        wideReply.getByRole("region", { name: "Message table" }),
      ]) {
        expect(await region.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
          true,
        );
        await region.evaluate((element) => {
          element.scrollLeft = element.scrollWidth;
        });
        expect(await region.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
      }
      expect(
        await wideReply.evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await wideReply.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `/tmp/mybots-markdown-${viewport.width}.png` });
    }
    await wideReply.getByText("Message evidence", { exact: true }).click();
    await wideReply.getByRole("button", { name: "Inspect Run evidence", exact: true }).click();
    await expect(page.locator("#run-history")).toContainText("Column 14");
    expect(errors).toEqual([]);
  } finally {
    if (child) await stop();
    await rm(root, { recursive: true, force: true });
  }
});
