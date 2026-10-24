import { fork } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { startDurableModel } from "../durable-model-fixture.ts";

test("built Web retains withdrawn and failed inputs, resends and reconstructs missed output", async ({
  page,
}) => {
  const root = await mkdtemp(join(tmpdir(), "mybots-control-browser-"));
  let release: () => void = () => {};
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let count = 0;
  const service = await startDurableModel(() => {
    count++;
    if (count === 1)
      return {
        chunks: (async function* () {
          yield "Working partial";
          await barrier;
          yield " final";
        })(),
      };
    if (count === 2) return { status: 400 };
    return { text: "Committed after reconnect" };
  });
  let child: ReturnType<typeof fork> | undefined;
  let exited: Promise<unknown> | undefined;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !/401|ERR_INTERNET_DISCONNECTED/.test(message.text()))
      errors.push(message.text());
  });
  try {
    await writeFile(join(root, "models.json"), JSON.stringify([service.config]), { mode: 0o600 });
    child = fork(
      new URL("../../apps/api/dist/index.js", import.meta.url),
      ["--root", root, "--port", "0"],
      {
        execArgv: ["--no-strip-types"],
        silent: true,
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NO_COLOR")),
      },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    exited = new Promise((resolve, reject) => {
      child?.once("exit", resolve);
      child?.once("error", reject);
    });
    const { url } = await Promise.race([
      new Promise<{ url: string }>((resolve) =>
        child?.once("message", (value) => resolve(value as { url: string })),
      ),
      exited.then(() => {
        throw new Error(`Compiled startup failed: ${stderr}`);
      }),
    ]);
    const credential = (await readFile(join(root, "data/client-credential"), "utf8")).trim();
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(url);
    await expect(page).toHaveTitle("Mybots");
    await page.getByLabel("Connection credential").fill(credential);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("button", { name: "Create Bot", exact: true }).click();
    await page.getByLabel("Bot name", { exact: true }).fill("Controlled Bot");
    await page.getByRole("button", { name: "Save Bot", exact: true }).click();
    const send = async (text: string) => {
      await page.getByLabel("Message", { exact: true }).fill(text);
      await page.getByRole("button", { name: "Send message" }).click();
      await expect(page.getByLabel("Message", { exact: true })).toHaveValue("");
    };
    await send("Begin work");
    await expect(page.locator("article.assistant")).toContainText("Working partial");
    await send("Queued instruction");
    await expect(page.locator("#unprocessed")).toContainText("Queued for steering");
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.locator("#stop")).toBeDisabled();
    await page.reload();
    const withdrawn = page
      .locator("#unprocessed article")
      .filter({ hasText: "Queued instruction" });
    await expect(withdrawn).toContainText("Unprocessed · aborted");
    await withdrawn.getByRole("button", { name: "Resend", exact: true }).click();
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Queued instruction");
    await page.getByRole("button", { name: "Send message" }).click();
    const failure = page.locator("#unprocessed article").filter({ hasText: "model_error" });
    await expect(failure).toContainText("Controlled model failure");
    await page.reload();
    await expect(failure).toContainText("Queued instruction");
    await page.screenshot({ path: "/tmp/mybots-control-model-failure.png", fullPage: true });
    await failure.getByRole("button", { name: "Resend", exact: true }).click();
    await page.context().setOffline(true);
    // Admit via HTTP while this browser misses every stream fragment.
    const response = await page.request.get(`${url}api/bots`, {
      headers: { Authorization: `Bearer ${credential}` },
    });
    const { bots } = await response.json();
    const sent = await page.request.post(`${url}api/bots/${bots[0].id}/send`, {
      headers: { Authorization: `Bearer ${credential}` },
      data: { text: "Queued instruction", requestId: "reconnect-final" },
    });
    expect(sent.status()).toBe(202);
    await service.waitForRequest(3);
    await page.context().setOffline(false);
    await expect(page.locator("#thread-messages")).toContainText("Committed after reconnect");
    await page.reload();
    await expect(page.locator("#thread-messages")).toContainText("Committed after reconnect");
    await expect(
      page.locator("article.assistant").filter({ hasText: "Committed after reconnect" }),
    ).toHaveCount(1);
    await expect(page.locator("#stop")).toBeDisabled();
    expect(count).toBe(3);
    expect(errors).toEqual([]);
  } finally {
    release();
    child?.kill("SIGTERM");
    await exited;
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
