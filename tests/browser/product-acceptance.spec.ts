import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RunnerMailbox } from "@mybots/mailbox/node";
import { expect, test } from "@playwright/test";
import type { Host } from "../../packages/host/src/host.ts";
import { captureDesktopState } from "./desktop-acceptance.ts";
import { showFeature } from "./navigation.ts";

type ThreadDetail = Awaited<ReturnType<Host["threadDetail"]>>;

test("Researcher and Writer restore a Routine, owned decisions, report and independent topic delivery", async ({
  page,
}, info) => {
  test.setTimeout(60_000);
  const root = await mkdtemp(join(tmpdir(), "mybots-product-browser-"));
  const calls: { method: string; body: Record<string, unknown>; failed: boolean }[] = [];
  const topics = new Map<string, number>();
  let failReports = true;
  const telegram = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const method = request.url?.split("/").at(-1) ?? "";
    const failed =
      method === "sendMessage" && failReports && String(body.text).includes("Work succeeded.");
    calls.push({ method, body, failed });
    let result: unknown = { message_id: 1 };
    if (method === "getMe") result = { id: 1, has_topics_enabled: true };
    if (method === "getChat") result = { id: 123456789, type: "private" };
    if (method === "createForumTopic") {
      const id = topics.size + 70;
      topics.set(String(body.name), id);
      result = { message_thread_id: id, name: body.name };
    }
    response.writeHead(failed ? 503 : 200, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        failed ? { ok: false, description: "Controlled outage" } : { ok: true, result },
      ),
    );
  });
  let child: ChildProcess | undefined;
  let exited: Promise<number | null> | undefined;
  let ready!: { url: string; credential: string };
  async function start(port = 0, now = "2026-10-21T00:00:00Z") {
    const address = telegram.address();
    if (!address || typeof address === "string") throw new Error("Telegram fixture not listening");
    const process = fork(
      fileURLToPath(new URL("../../scripts/client-acceptance-host.mjs", import.meta.url)),
      [root, String(port), now, `http://127.0.0.1:${address.port}`],
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
    ready = await Promise.race([
      once(process, "message", { signal: AbortSignal.timeout(10_000) }).then(
        ([message]) => message as typeof ready,
      ),
      exited.then(() => {
        throw new Error(`Acceptance Host stopped before ready: ${stderr}`);
      }),
    ]);
  }
  async function stop() {
    try {
      if (child?.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit", { signal: AbortSignal.timeout(10_000) });
      }
      expect(await exited).toBe(0);
    } finally {
      if (child?.exitCode === null && child.signalCode === null) {
        const killed = once(child, "exit", { signal: AbortSignal.timeout(10_000) });
        child.kill("SIGKILL");
        await killed;
      }
      child = undefined;
    }
  }
  async function detail(botId: string): Promise<ThreadDetail> {
    const response = await page.request.get(`${ready.url}/api/bots/${botId}/thread`);
    expect(response.status()).toBe(200);
    return response.json();
  }
  async function createBot(name: string, role: string, memory: string) {
    await showFeature(page, "create");
    await page.getByLabel("Bot name", { exact: true }).fill(name);
    await page.getByLabel("Role instructions", { exact: true }).fill(role);
    await page.getByLabel("Model", { exact: true }).selectOption("deepseek/deepseek-chat");
    await page.getByRole("button", { name: "Create Bot", exact: true }).click();
    await expect(page.locator("#selected-bot")).toContainText(role);
    await showFeature(page, "overview");
    const id = await page.locator("#selected-bot").getAttribute("data-bot-id");
    if (!id) throw new Error("Created Bot identity missing");
    await showFeature(page, "Memory");
    await page.getByLabel("Memory index", { exact: true }).fill(memory);
    await showFeature(page, "Memory");
    await page.getByRole("button", { name: "Save memory index", exact: true }).click();
    await expect(page.locator("#memory-message")).toContainText("Saved");
    return id;
  }
  async function operation(mailbox: RunnerMailbox, id: string, operation: string, input: unknown) {
    mailbox.requestHistory({ id, operation, input, incarnation: mailbox.executionIncarnation() });
    await expect
      .poll(() => mailbox.historyResponse(id))
      .toMatchObject({ result: expect.anything() });
  }
  const errors: string[] = [];
  let phase: "pairing" | "connected" | "restarting" = "pairing";
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (phase === "pairing" && text.includes("401 (Unauthorized)")) return;
    if (
      phase === "restarting" &&
      /ERR_CONNECTION_REFUSED|ERR_INTERNET_DISCONNECTED|WebSocket/.test(text)
    )
      return;
    errors.push(text);
  });
  try {
    telegram.listen(0, "127.0.0.1");
    await once(telegram, "listening");
    await start();
    await page.goto(ready.url);
    await expect(page).toHaveTitle("Mybots · Bots");
    await page.getByLabel("Connection credential").fill(ready.credential);
    await page.getByRole("button", { name: "Pair with Host" }).click();
    const researcher = await createBot(
      "Researcher",
      "Collect evidence and commission a report.",
      "Keep source citations.",
    );
    const writer = await createBot(
      "Writer",
      "Write concise reports from selected evidence.",
      "Use short paragraphs.",
    );
    expect(writer).not.toBe(researcher);
    phase = "connected";
    await showFeature(page, "chat");
    await page.getByRole("button", { name: "Select Researcher", exact: true }).click();
    await expect(page.getByLabel("Memory index", { exact: true })).toHaveValue(
      "Keep source citations.",
    );
    await showFeature(page, "Collaboration");
    await page.getByLabel("Target Bot", { exact: true }).selectOption(writer);
    await showFeature(page, "Collaboration");
    await page.getByLabel("Permission", { exact: true }).selectOption("ask-each-time");
    await showFeature(page, "Collaboration");
    await page.getByRole("button", { name: "Save delegation permission" }).click();
    await expect(page.locator("#collaboration-notice")).toContainText("ask-each-time");
    await showFeature(page, "Routines");
    await page
      .getByLabel("Routine instructions", { exact: true })
      .fill("Research and commission a report");
    await showFeature(page, "Routines");
    await page
      .getByLabel("Run at (ISO instant with offset)", { exact: true })
      .fill("2026-10-21T09:00:00+08:00");
    await showFeature(page, "Routines");
    await page.getByLabel("Schedule timezone", { exact: true }).fill("Asia/Shanghai");
    await showFeature(page, "Routines");
    await page.getByRole("button", { name: "Create one-shot Routine", exact: true }).click();
    await expect(page.locator("#routine-list article")).toHaveCount(1);
    await expect(page.locator("#chat-works article")).toHaveCount(0);

    const port = Number(new URL(ready.url).port);
    phase = "restarting";
    await page.context().setOffline(true);
    await stop();
    await start(port, "2026-10-21T02:00:00Z");
    await page.context().setOffline(false);
    await page.reload();
    await expect(page.locator("#chat-works article")).toHaveCount(1);
    const parent = (await detail(researcher)).tasks[0];
    const parentRun = parent?.runs[0];
    if (!parent || !parentRun) throw new Error("Routine occurrence missing");
    const parentCard = page.locator(`#chat-works [data-task-id="${parent.id}"]`);
    await expect(parentCard).toContainText("Execution: active");
    await expect(parentCard).toContainText("Origin: routine");
    await expect(parentCard).toContainText("Run background: none");
    phase = "connected";
    const parentMailbox = new RunnerMailbox(
      join(root, "data", "sessions", researcher, parentRun.id),
    );
    await operation(parentMailbox, "report-delegation", "delegate", {
      requestId: "report-delegation",
      targetBotId: writer,
      text: "Draft the approved report",
    });
    parentMailbox.requestDurableWait("delegation");
    await expect(parentCard).toContainText("Execution: waiting");
    const approval = page.locator('#chat-works [data-approval-id="report-delegation"]');
    await expect(approval).toContainText(`Target Bot: ${writer}`);
    await expect(approval).toContainText("Draft the approved report");
    await expect(parentCard).toContainText("Telegram notice: delivered");
    expect((await detail(writer)).tasks).toEqual([]);
    await captureDesktopState(page, info, "routine-approval");

    phase = "restarting";
    await stop();
    await start(port, "2026-10-21T02:00:00Z");
    await page.reload();
    await expect(approval).toContainText("pending");
    phase = "connected";
    await showFeature(page, "tasks");
    await approval.getByRole("button", { name: "Approve action", exact: true }).click();
    await expect(approval).toContainText("executed");
    await showFeature(page, "chat");
    await page.getByRole("button", { name: "Select Writer", exact: true }).click();
    await expect(page.getByLabel("Memory index", { exact: true })).toHaveValue(
      "Use short paragraphs.",
    );
    await expect(page.locator("#chat-works")).toContainText("Execution: active");
    const childTask = (await detail(writer)).tasks[0];
    const childRun = childTask?.runs[0];
    if (!childTask || !childRun) throw new Error("Owned child missing");
    const childCard = page.locator(`#chat-works [data-task-id="${childTask.id}"]`);
    await expect(childCard).toContainText(`Parent Task ${parent.id} · Parent Run ${parentRun.id}`);
    await expect(childCard).toContainText(`Child Task ${childTask.id} · Child Run ${childRun.id}`);
    const writerMailbox = new RunnerMailbox(join(root, "data", "sessions", writer, childRun.id));
    await operation(writerMailbox, "report-style", "ask_question", {
      requestId: "report-style",
      text: "Which report style?",
    });
    writerMailbox.requestDurableWait("owner-question");
    await expect(childCard).toContainText("Execution: waiting");
    await expect(childCard).toContainText("Telegram notice: delivered");
    const questionNotice = calls.find(
      (call) =>
        call.method === "sendMessage" && String(call.body.text).includes("Which report style?"),
    );
    const approvalNotice = calls.find(
      (call) =>
        call.method === "sendMessage" &&
        String(call.body.text).includes("Request: report-delegation"),
    );
    expect(questionNotice?.body.message_thread_id).toBe(topics.get("Writer"));
    expect(approvalNotice?.body.message_thread_id).toBe(topics.get("Researcher"));
    expect(questionNotice?.body.message_thread_id).not.toBe(approvalNotice?.body.message_thread_id);
    expect(questionNotice?.body.chat_id).toBe("123456789");

    phase = "restarting";
    await stop();
    await start(port, "2026-10-21T02:00:00Z");
    await page.reload();
    await showFeature(page, "tasks");
    await expect(
      page.locator("#chat-works").getByLabel("Answer to Which report style?", { exact: true }),
    ).toBeVisible();
    phase = "connected";
    await captureDesktopState(page, info, "child-question-restored");
    await showFeature(page, "tasks");
    await page
      .locator("#chat-works")
      .getByLabel("Answer to Which report style?", { exact: true })
      .fill("Concise with citations");
    await showFeature(page, "tasks");
    await page
      .locator("#chat-works")
      .getByRole("button", { name: "Answer question", exact: true })
      .click();
    await expect(childCard).toContainText("Owner answer: Concise with citations");
    await expect(childCard).toContainText("Execution: active");
    await expect
      .poll(async () => (await detail(writer)).tasks[0]?.runs[0]?.attempts.length)
      .toBe(2);
    const original = Buffer.from("# Report\nSelected evidence with citations.\n");
    const workingFile = join(root, "groups", writer, "report.md");
    await writeFile(workingFile, original);
    await operation(writerMailbox, "report-result", "publish_result", {
      requestId: "report-result",
      text: "Report ready",
      files: ["report.md"],
    });
    const downloadLink = page.getByRole("link", {
      name: `Download report.md (${original.length} bytes)`,
      exact: true,
    });
    await expect(downloadLink).toBeVisible();
    await writeFile(workingFile, "# Later working revision\n");
    child?.send("complete");
    await expect(childCard).toContainText("Outcome: succeeded");
    await showFeature(page, "chat");
    await page.getByRole("button", { name: "Select Researcher", exact: true }).click();
    await expect(parentCard).toContainText("Outcome: succeeded");
    await expect(parentCard).toContainText("Telegram notice: pending");
    const settled = (await detail(researcher)).tasks;
    expect(settled).toHaveLength(1);
    expect(settled[0]?.runs).toHaveLength(1);
    expect(settled[0]?.runs[0]).toMatchObject({
      id: parentRun.id,
      attempts: [{ endedAt: expect.any(String) }, { endedAt: expect.any(String) }],
      delegations: [{ state: "succeeded", childTaskId: childTask.id, childRunId: childRun.id }],
    });
    await expect(page.locator("#routine-list")).toContainText("none — one-shot admitted");
    expect(calls.some((call) => call.failed)).toBe(true);

    phase = "restarting";
    await stop();
    failReports = false;
    await start(port, "2026-10-22T02:00:00Z");
    await page.reload();
    await expect(parentCard).toContainText("Outcome: succeeded");
    phase = "connected";
    await expect(parentCard).toContainText("Telegram notice: delivered");
    expect((await detail(researcher)).tasks).toHaveLength(1);
    await showFeature(page, "tasks");
    await parentCard.getByRole("button", { name: "Inspect Run evidence" }).click();
    await page.getByRole("button", { name: "Run Attempts", exact: true }).click();
    await expect(page.locator("#run-history")).toContainText(parentRun.attempts[0]?.id as string);
    await expect(page.locator("#run-history")).toContainText(
      settled[0]?.runs[0]?.attempts[1]?.id as string,
    );
    await showFeature(page, "chat");
    await page.getByRole("button", { name: "Select Writer", exact: true }).click();
    await expect(childCard).toContainText("Report ready");
    await expect(childCard).toContainText(
      `Bot: ${writer} · Task: ${childTask.id} · Run: ${childRun.id}`,
    );
    await showFeature(page, "tasks");
    const [download] = await Promise.all([page.waitForEvent("download"), downloadLink.click()]);
    const saved = join(root, "downloaded-report.md");
    await download.saveAs(saved);
    expect(await readFile(saved)).toEqual(original);
    await showFeature(page, "tasks");
    await childCard.getByRole("button", { name: "Inspect Run evidence" }).click();
    await page.getByRole("button", { name: "Run inputs", exact: true }).click();
    await expect(page.locator("#run-history")).toContainText("Draft the approved report");
    const sends = calls.filter((call) => call.method === "sendMessage" && !call.failed);
    expect(
      sends.some(
        (call) =>
          String(call.body.text).includes("Work succeeded.") &&
          call.body.message_thread_id === topics.get("Researcher"),
      ),
    ).toBe(true);
    expect(
      sends.some(
        (call) =>
          String(call.body.text).includes("Work succeeded.") &&
          call.body.message_thread_id === topics.get("Writer"),
      ),
    ).toBe(false);
    await page.setViewportSize({ width: 1280, height: 900 });
    await showFeature(page, "tasks");
    await childCard.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "/tmp/mybots-product-acceptance-desktop.png" });
    await page.setViewportSize({ width: 1920, height: 1080 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: "/tmp/mybots-product-acceptance-wide.png" });
    expect(errors).toEqual([]);
  } finally {
    try {
      if (child) await stop();
    } finally {
      telegram.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        telegram.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
    }
  }
});
