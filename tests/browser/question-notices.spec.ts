import { type ChildProcess, fork } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RunnerMailbox } from "@mybots/mailbox/node";
import { expect, test } from "@playwright/test";

test("repairs a Bot topic and resends the question notice without changing the Run", async ({
  page,
}) => {
  const root = await mkdtemp(join(tmpdir(), "mybots-notice-browser-"));
  let child: ChildProcess | undefined;
  let exited: Promise<number | null> | undefined;
  async function start(port = 0) {
    const childProcess = fork(
      fileURLToPath(new URL("../../scripts/client-browser-host.mjs", import.meta.url)),
      [root, String(port)],
      { silent: true, env: { ...process.env, MYBOTS_TELEGRAM_FIXTURE: "1" } },
    );
    child = childProcess;
    let stderr = "";
    childProcess.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    exited = new Promise<number | null>((resolve, reject) => {
      childProcess.once("exit", resolve);
      childProcess.once("error", reject);
    });
    return Promise.race([
      new Promise<{ url: string; credential: string; sessionId: string }>((resolve) =>
        childProcess.once("message", (message) =>
          resolve(message as { url: string; credential: string; sessionId: string }),
        ),
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
    const mailbox = new RunnerMailbox(join(root, "data", "sessions", "personal", ready.sessionId));
    mailbox.requestHistory({
      id: "browser-city",
      operation: "ask_question",
      incarnation: mailbox.executionIncarnation(),
      input: { requestId: "browser-city", text: "Which city?" },
    });
    await expect
      .poll(() => mailbox.historyResponse("browser-city"))
      .toMatchObject({ result: { state: "pending" } });
    mailbox.requestDurableWait("owner-question");
    await page.goto(ready.url);
    await page.getByLabel("Connection credential").fill(ready.credential);
    await page.getByRole("button", { name: "Pair with Host" }).click();
    await page.getByRole("button", { name: "Select Personal" }).click();
    const works = page.locator("#chat-works");
    await expect(works).toContainText("Execution: waiting");
    await expect(works).toContainText("Telegram topic: repairable");
    await expect(works).toContainText("Private topic mode is unavailable.");
    await expect(works).toContainText("Telegram notice: failed · 0 of 3 attempts");
    await expect(works).toContainText(
      `Local client: /bots/personal/runs/${ready.sessionId}/questions/browser-city`,
    );
    child?.send("telegram-mode:ready");
    await page.getByRole("button", { name: "Repair Telegram topic" }).click();
    await expect(works).toContainText("Telegram topic: mapped · 71");
    await page.getByRole("button", { name: "Resend Telegram notice" }).click();
    await expect(works).toContainText("Telegram notice: delivered · 1 of 3 attempts");
    await expect(works).toContainText("This is not a read receipt");
    await expect(works).toContainText("Bot: personal · Task:");
    await expect(works).toContainText(`Run: ${ready.sessionId} · Request: browser-city`);
    await expect(works).toContainText("Execution: waiting");
    const sent = JSON.parse(await readFile(join(root, "data", "telegram-sends.json"), "utf8")) as {
      method: string;
      text?: string;
      topicId?: string;
    }[];
    const notice = sent.find((entry) => entry.method === "sendMessage");
    expect(notice?.topicId).toBe("71");
    expect(notice?.text).toContain("Bot: Personal (personal)");
    expect(notice?.text).toContain(`Run: ${ready.sessionId}`);
    expect(notice?.text).toContain("Request: browser-city");
    expect(notice?.text).toContain("Which city?");
    const beforeRestart = sent.length;
    await stop();
    await start(Number(new URL(ready.url).port));
    await page.reload();
    await page.getByRole("button", { name: "Select Personal" }).click();
    await expect(works).toContainText("Telegram notice: delivered · 1 of 3 attempts");
    await expect(works).toContainText("Execution: waiting");
    expect(
      JSON.parse(await readFile(join(root, "data", "telegram-sends.json"), "utf8")),
    ).toHaveLength(beforeRestart);
    expect(errors).toEqual([]);
  } finally {
    if (child) await stop();
    await rm(root, { recursive: true, force: true });
  }
});
