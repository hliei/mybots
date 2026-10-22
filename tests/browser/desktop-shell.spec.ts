import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { captureDesktopState } from "./desktop-acceptance.ts";

test("desktop shell pairs, sends to a real Thread and returns focus from shared surfaces", async ({
  page,
}, info) => {
  test.setTimeout(60_000);
  const root = await mkdtemp(join(tmpdir(), "mybots-shell-"));
  const host = fork(
    fileURLToPath(new URL("../../scripts/client-browser-host.mjs", import.meta.url)),
    [root, "0"],
    { silent: true },
  );
  const exited = once(host, "exit");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const [ready] = (await once(host, "message", { signal: AbortSignal.timeout(10_000) })) as [
      { url: string; credential: string },
    ];
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(ready.url);
    await expect(page.getByLabel("Connection credential")).toBeVisible();
    await expect(page.getByLabel("Message", { exact: true })).toBeHidden();
    await page.getByLabel("Connection credential").fill(ready.credential);
    await page.getByRole("button", { name: "Pair with Host" }).click();
    await expect(page.locator("#shell-empty")).toBeVisible();
    await captureDesktopState(page, info, "no-selection");
    await expect(page.getByRole("button", { name: "Prototype", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Select Personal", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Bot details: Personal", exact: true }),
    ).toBeVisible();
    await page.getByLabel("Message", { exact: true }).fill("Desktop shell round trip");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    host.send("complete");
    await expect(page.locator("#thread-messages .assistant").last()).toContainText(
      "Final: Desktop shell round trip",
    );
    await expect(page.locator("#chat-message")).toHaveText("Message sent.");
    await captureDesktopState(page, info, "conversation");
    await expect(page.locator(".sidebar")).toHaveCSS("background-color", "rgb(13, 13, 13)");
    await expect(page.locator(".message.assistant").last()).toHaveCSS(
      "background-color",
      "rgb(27, 27, 27)",
    );
    await expect(page.locator(".message.user").last()).toHaveCSS(
      "background-color",
      "rgb(54, 54, 54)",
    );
    await expect(page.locator(".message-content").last()).toHaveCSS("font-size", "17px");
    await page.getByRole("button", { name: "Search conversation", exact: true }).press("Enter");
    await page.getByLabel("Search original history").fill("no-matching-desktop-original");
    await page.getByRole("button", { name: "Search history", exact: true }).click();
    await expect(page.getByRole("region", { name: "Conversation search results" })).toContainText(
      "No matching originals.",
    );
    await expect(page.locator("#thread-messages")).toContainText("Final: Desktop shell round trip");
    await captureDesktopState(page, info, "empty-search");
    await page.getByRole("button", { name: "Latest originals", exact: true }).click();
    await page.getByRole("button", { name: "Close details", exact: true }).click();
    await page.getByRole("button", { name: "Bot details: Personal", exact: true }).click();
    await expect(page.getByRole("complementary", { name: "Bot details" })).toBeVisible();
    await page.getByRole("button", { name: "Files", exact: true }).click();
    await expect(page.locator("#attachments")).toBeVisible();
    await captureDesktopState(page, info, "files");
    await page.getByRole("button", { name: "Tasks", exact: true }).click();
    await expect(page.locator("#chat-works")).toBeVisible();
    await expect(page.locator("#attachments")).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Tasks", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Settings" })).toContainText("Personal");
    await page.getByRole("button", { name: "Memory", exact: true }).click();
    await expect(page.getByLabel("Memory index", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeFocused();
    const longText = "A long desktop original with no page overflow. ".repeat(150);
    await page.getByLabel("Message", { exact: true }).fill(longText);
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.locator("#thread-messages .assistant").last()).toContainText(
      "Final: A long desktop original",
    );
    for (const viewport of [
      { width: 1280, height: 900 },
      { width: 1440, height: 900 },
      { width: 1920, height: 1080 },
    ]) {
      await page.setViewportSize(viewport);
      await page.getByRole("button", { name: "Bot details: Personal", exact: true }).click();
      const sidebar = await page.getByRole("navigation", { name: "Bots" }).boundingBox();
      const detail = await page.getByRole("complementary", { name: "Bot details" }).boundingBox();
      const composer = await page.locator("#message-form").boundingBox();
      expect(sidebar?.width).toBeGreaterThanOrEqual(300);
      expect(detail?.width).toBe(380);
      expect((composer?.x ?? 0) + (composer?.width ?? 0)).toBeLessThanOrEqual(detail?.x ?? 0);
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <= innerWidth &&
            document.documentElement.scrollHeight <= innerHeight,
        ),
      ).toBe(true);
      const history = page.getByLabel("Chat history", { exact: true });
      const composerBefore = await page.locator("#message-form").boundingBox();
      await history.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      expect(await history.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      expect(await page.locator("#message-form").boundingBox()).toEqual(composerBefore);
      await page.screenshot({ path: `/tmp/mybots-shell-${viewport.width}.png` });
      await page.getByRole("button", { name: "Close details", exact: true }).click();
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "Create a Bot", exact: true }).click();
    await page.getByLabel("Bot name", { exact: true }).fill("Shell test Bot");
    await page.getByLabel("Role instructions", { exact: true }).fill("Use real Host state.");
    await page.getByRole("button", { name: "Create Bot", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Create a Bot", exact: true })).toBeHidden();
    await expect(page.locator("#thread-messages")).toContainText("No messages yet");
    await captureDesktopState(page, info, "empty-thread");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.locator("#settings-bot")).toHaveText("Shell test Bot");
    await page.getByRole("button", { name: "Skills", exact: true }).click();
    await expect(page.locator("#skill-activation")).toContainText("Saved Skills: None");
    await expect(page.locator("#skill-activation")).toContainText("Effective Skills: None");
    await page.getByRole("button", { name: "Choose protected revisions", exact: true }).click();
    await expect(page.getByLabel("Bot role")).toBeVisible();
    await expect(page.getByRole("button", { name: "Configuration", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    for (const width of [1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: width === 1920 ? 1080 : 900 });
      const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
      const box = await dialog.boundingBox();
      expect(box?.width).toBe(width);
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      await page.screenshot({ path: `/tmp/mybots-settings-${width}.png` });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const section of ["Memory", "Skills", "Collaboration"]) {
      await page.getByRole("button", { name: section, exact: true }).click();
      await expect(page.locator("#settings-bot")).toHaveText("Shell test Bot");
      await captureDesktopState(page, info, `settings-${section.toLowerCase()}`);
    }
    await Promise.all([
      page.locator("#settings-surface").evaluate(
        (dialog) =>
          new Promise<void>((resolve) => {
            dialog.addEventListener("close", () => resolve(), { once: true });
          }),
      ),
      page.getByRole("button", { name: "Open Tasks and decisions", exact: true }).click(),
    ]);
    await expect(page.getByRole("complementary", { name: "Bot details" })).toBeVisible();
    await expect(page.locator("#detail-title")).toHaveText("Tasks and Runs");
    await expect(page.getByRole("button", { name: "Close details", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Back to conversation", exact: true }).click();
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeFocused();
    await expect(page.locator("#bot-identity-name")).toHaveText("Shell test Bot");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.getByLabel("Message", { exact: true }).fill("Keep this draft while offline");
    host.kill("SIGTERM");
    await exited;
    await page.getByRole("button", { name: "Refresh status", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Host unavailable");
    await expect(page.getByLabel("Message", { exact: true })).toBeEditable();
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Bot menu", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Reset chat background", exact: true }),
    ).toBeDisabled();
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
      "Keep this draft while offline",
    );
    await page.keyboard.press("Escape");
    await captureDesktopState(page, info, "host-unavailable");
    expect(errors).toEqual([]);
  } finally {
    if (host.exitCode === null) host.kill("SIGTERM");
    await exited;
    await rm(root, { recursive: true, force: true });
  }
});
