import { execFile, fork } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { startDurableModel } from "../durable-model-fixture.ts";
import { configureFixture, fixtureEnvironment } from "../provider-fixture.ts";

test("built Web distinguishes worker recovery, reconstructed interruption and exhausted recovery", async ({
  page,
}) => {
  const root = await mkdtemp(join(tmpdir(), "mybots-worker-browser-"));
  let calls = 0;
  const service = await startDurableModel(() => {
    calls++;
    return calls === 1
      ? { hold: true }
      : calls === 2
        ? { text: "Recovered final answer" }
        : { status: 401 };
  });
  configureFixture(root);
  const child = fork(
    new URL("../../apps/api/dist/index.js", import.meta.url),
    ["--root", root, "--port", "0"],
    {
      execArgv: ["--no-strip-types"],
      silent: true,
      env: Object.fromEntries(
        Object.entries(fixtureEnvironment(service, true)).filter(([key]) => key !== "NO_COLOR"),
      ),
    },
  );
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  async function crash(): Promise<void> {
    const { stdout } = await promisify(execFile)("pgrep", ["-P", String(child.pid), "-f", root]);
    const pids = stdout.trim().split(/\s+/).map(Number);
    expect(pids).toHaveLength(1);
    process.kill(pids[0] as number, "SIGKILL");
  }
  try {
    const { url } = await Promise.race([
      new Promise<{ url: string }>((resolve) =>
        child.once("message", (value) => resolve(value as { url: string })),
      ),
      exited.then(() => {
        throw new Error("API startup failed");
      }),
    ]);
    const credential = (await readFile(join(root, "client-credential"), "utf8")).trim();
    await page.goto(url);
    await page.getByLabel("Connection credential").fill(credential);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("button", { name: "Create Bot", exact: true }).click();
    await page.getByLabel("Bot name", { exact: true }).fill("Recover");
    await page.getByRole("button", { name: "Save Bot", exact: true }).click();
    await page.getByLabel("Message", { exact: true }).fill("Admit this only once");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect.poll(() => service.requests.length).toBe(1);
    await writeFile(join(root, "worker-fault"), "hold");
    await crash();
    await expect(page.locator("#connection")).toContainText("Worker recovering");
    await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
    await page.reload();
    await expect(page.locator("#connection")).toContainText("Worker recovering");
    await writeFile(join(root, "worker-fault"), "");
    await expect(page.locator("#connection")).toHaveText("Worker recovered");
    await expect(page.locator("article.assistant")).toContainText("Recovered final answer");
    await expect(page.locator("article.user")).toHaveCount(1);
    expect(service.requests).toHaveLength(2);
    await page.reload();
    await expect(page.locator("#connection")).toHaveText("Worker recovered");
    await expect(page.locator("article.assistant")).toContainText("Recovered final answer");
    // Recovered transport must still expose a real subsequent model failure.
    await page.getByLabel("Message", { exact: true }).fill("Fail this request");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.locator("#unprocessed")).toContainText("Unprocessed");
    await expect(page.locator("#stop")).toBeDisabled();
    await page.reload();
    await expect(page.locator("#unprocessed")).toContainText("Unprocessed");
    expect(service.requests).toHaveLength(3);
    await writeFile(join(root, "worker-fault"), "crash");
    await crash();
    await expect(page.locator("#connection")).toContainText("Automatic recovery stopped", {
      timeout: 15000,
    });
    await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
    await page.reload();
    await expect(page.locator("#connection")).toContainText("Automatic recovery stopped");
    await page.screenshot({ path: "test-results/worker-recovery-failed.png", fullPage: true });
    expect(pageErrors).toEqual([]);
  } finally {
    child.kill("SIGTERM");
    await exited;
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
