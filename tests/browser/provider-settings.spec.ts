import { fork } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { startDurableModel } from "../durable-model-fixture.ts";
import { fixtureEnvironment } from "../provider-fixture.ts";

test("fresh Web configures providers without requests or browser credential persistence", async ({
  page,
}) => {
  const root = await mkdtemp(join(tmpdir(), "mybots-provider-browser-"));
  const service = await startDurableModel(() => ({ text: "Unexpected request" }));
  const child = fork(
    new URL("../../apps/api/dist/index.js", import.meta.url),
    ["--root", root, "--port", "0"],
    {
      execArgv: ["--no-strip-types"],
      silent: true,
      env: Object.fromEntries(
        Object.entries(fixtureEnvironment(service)).filter(([key]) => key !== "NO_COLOR"),
      ),
    },
  );
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const errors: string[] = [];
  const publicRequests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (!request.url().startsWith("http://127.0.0.1:")) publicRequests.push(request.url());
  });
  try {
    const { url } = await Promise.race([
      new Promise<{ url: string }>((resolve) =>
        child.once("message", (value) => resolve(value as { url: string })),
      ),
      exited.then(() => {
        throw new Error("Compiled startup failed");
      }),
    ]);
    await page.goto(url);
    await expect(page).toHaveTitle("Mybots");
    await page
      .getByLabel("Connection credential")
      .fill((await readFile(join(root, "client-credential"), "utf8")).trim());
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("button", { name: "Provider settings", exact: true }).click();
    await expect(page.locator("#deepseek-status")).toHaveText("Not configured");
    await page.getByLabel("DeepSeek API key", { exact: true }).fill("browser-secret-deepseek");
    await page.getByRole("button", { name: "Save DeepSeek key", exact: true }).click();
    await expect(page.locator("#deepseek-status")).toHaveText(
      "Saved locally. Access is checked when you send a message.",
    );
    await expect(page.getByLabel("DeepSeek API key", { exact: true })).toHaveValue("");
    await page.getByLabel("OpenCode Go API key", { exact: true }).fill("browser-secret-go");
    await page.getByRole("button", { name: "Save OpenCode Go key", exact: true }).click();
    await expect(page.locator("#opencode-go-status")).toContainText("Saved locally");
    await page.getByRole("button", { name: "Close providers", exact: true }).click();
    await page.getByRole("button", { name: "Create Bot", exact: true }).click();
    await expect(page.getByLabel("Model", { exact: true })).toHaveValue("deepseek/deepseek-flash");
    await page.getByLabel("Bot name", { exact: true }).fill("Saved Bot");
    await page.getByRole("button", { name: "Save Bot", exact: true }).click();
    await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
    await page.reload();
    await page.getByRole("button", { name: "Provider settings", exact: true }).click();
    await expect(page.getByLabel("DeepSeek API key", { exact: true })).toHaveValue("");
    await page.getByRole("button", { name: "Save DeepSeek key", exact: true }).click();
    await expect(page.locator("#deepseek-status")).toContainText("Saved locally");
    await page.getByLabel("DeepSeek API key", { exact: true }).fill("browser-secret-replacement");
    await page.getByRole("button", { name: "Save DeepSeek key", exact: true }).click();
    await page.getByRole("button", { name: "Remove DeepSeek key", exact: true }).click();
    await expect(page.locator("#deepseek-status")).toHaveText("Not configured");
    await page.screenshot({ path: "/tmp/mybots-provider-settings-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "/tmp/mybots-provider-settings-mobile.png", fullPage: true });
    await page.getByRole("button", { name: "Close providers", exact: true }).click();
    await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
    await expect(page.locator("#chat-message")).toContainText("Provider settings");
    await page.getByRole("button", { name: "Bot settings", exact: true }).click();
    await expect(page.getByLabel("Model", { exact: true })).toHaveValue("deepseek/deepseek-flash");
    const storage = await page.evaluate(() =>
      JSON.stringify({
        local: { ...localStorage },
        session: { ...sessionStorage },
        text: document.body.innerText,
      }),
    );
    expect(storage).not.toContain("browser-secret");
    expect(publicRequests).toEqual([]);
    expect(service.requests).toHaveLength(0);
    expect(errors).toEqual([]);
  } finally {
    child.kill("SIGTERM");
    await exited;
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
