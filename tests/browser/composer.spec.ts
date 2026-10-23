import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RunnerMailbox } from "@mybots/mailbox/node";
import { test as base, expect } from "@playwright/test";

interface Ready {
  url: string;
  credential: string;
  sessionId: string;
}
async function launch(root: string, port = 0) {
  const host = fork(
    fileURLToPath(new URL("../../scripts/client-browser-host.mjs", import.meta.url)),
    [root, String(port)],
    { silent: true },
  );
  const exited = once(host, "exit");
  try {
    const [ready] = (await once(host, "message", { signal: AbortSignal.timeout(10_000) })) as [
      Ready,
    ];
    return { host, exited, ready };
  } catch (error) {
    host.kill("SIGTERM");
    await exited;
    throw error;
  }
}
const test = base.extend<{
  runtime: {
    host: ReturnType<typeof fork>;
    ready: Ready;
    root: string;
    restart: () => Promise<void>;
  };
}>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires destructured fixture dependencies.
  runtime: async ({}, use) => {
    const root = await mkdtemp(join(tmpdir(), "mybots-composer-"));
    try {
      let running = await launch(root);
      try {
        await use({
          get host() {
            return running.host;
          },
          ready: running.ready,
          root,
          restart: async () => {
            running.host.kill("SIGTERM");
            await running.exited;
            running = await launch(root, Number(new URL(running.ready.url).port));
          },
        });
      } finally {
        running.host.kill("SIGTERM");
        await running.exited;
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
});

test("Tasks expose compact source cards, explicit additions and the active chat stop target", async ({
  page,
  runtime: { ready },
}) => {
  await page.goto(ready.url);
  await page.getByLabel("Connection credential").fill(ready.credential);
  await page.getByRole("button", { name: "Pair with Host" }).click();
  await page.getByRole("button", { name: "Select Personal", exact: true }).click();
  const stop = page.getByRole("button", { name: "Stop current chat Run", exact: true });
  await expect(stop).toBeVisible();
  await expect(stop).toHaveAttribute("data-run-id", ready.sessionId);
  await expect(page.locator("#work-cards article")).toHaveCount(0);
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await expect(page.locator("#chat-works")).toHaveAttribute("aria-busy", "false");
  const task = page.locator("#chat-works article").first();
  const taskId = await task.getAttribute("data-task-id");
  await expect(task.locator("summary").first()).toContainText("Chat · active");
  await expect(task.getByRole("button", { name: "Inspect Run evidence" })).toBeHidden();
  await task.locator("summary").first().click();
  await expect(task.getByRole("button", { name: "Inspect Run evidence" })).toBeVisible();
  await task.getByRole("button", { name: "Add instructions", exact: true }).click();
  await expect(page.locator("#composer-target")).toContainText("Add to Inspect this session");
  await expect(page.locator("#composer-target")).not.toContainText(taskId as string);
  await expect(stop).toBeHidden();
  await page.getByLabel("Message", { exact: true }).fill("Targeted active instructions");
  const added = page.waitForResponse((response) =>
    response.url().endsWith(`/tasks/${taskId}/inputs`),
  );
  await page.getByLabel("Message", { exact: true }).press("Enter");
  expect(await (await added).json()).toMatchObject({ taskId, runId: ready.sessionId });
  await page.getByRole("button", { name: "Return to Thread", exact: true }).click();
  await expect(stop).toBeVisible();
  const stopped = page.waitForResponse((response) =>
    response.url().endsWith(`/runs/${ready.sessionId}/stop`),
  );
  await stop.click();
  expect((await stopped).ok()).toBe(true);
  await expect(task).toContainText("Outcome: cancelled");
  await expect(stop).toBeHidden();
  await expect(page.locator("#work-cards article")).toHaveCount(1);
  await expect(page.locator("#work-cards")).toContainText("Chat · closed");
});

test("composer preserves isolated drafts and handles Enter, newlines and IME", async ({
  page,
  runtime: { ready },
}) => {
  await page.goto(ready.url);
  await page.getByLabel("Connection credential").fill(ready.credential);
  await page.getByRole("button", { name: "Pair with Host" }).click();
  await page.getByRole("button", { name: "Select Personal", exact: true }).click();
  const draft = page.getByLabel("Message", { exact: true });
  await draft.fill("Personal unsent draft");
  await page.getByRole("button", { name: "Create a Bot", exact: true }).click();
  await page.getByLabel("Bot name").fill("Writer");
  await page.getByLabel("Role instructions").fill("Write clearly.");
  await page.getByLabel("Model", { exact: true }).selectOption("deepseek/deepseek-chat");
  await page.getByRole("button", { name: "Create Bot", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Bot details: Writer", exact: true }),
  ).toBeVisible();
  await expect(draft).toHaveValue("");
  await draft.fill("Writer unsent draft");
  await page.getByRole("button", { name: "Select Personal", exact: true }).click();
  await expect(draft).toHaveValue("Personal unsent draft");
  await page.reload();
  await expect(draft).toHaveValue("Personal unsent draft");
  await page.getByRole("button", { name: "Select Writer", exact: true }).click();
  await expect(draft).toHaveValue("Writer unsent draft");
  const shortHeight = (await draft.boundingBox())?.height ?? 0;
  await draft.fill("Line one");
  await draft.press("Shift+Enter");
  await draft.press("End");
  await draft.press("Shift+Enter");
  await draft.press("Shift+Enter");
  await draft.press("Shift+Enter");
  await expect(draft).toHaveValue("Line one\n\n\n\n");
  expect((await draft.boundingBox())?.height).toBeGreaterThan(shortHeight);
  let submissions = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/thread/messages")) submissions++;
  });
  await draft.evaluate((node) => {
    node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    node.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
    );
    node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  });
  await expect(draft).toHaveValue("Line one\n\n\n\n");
  expect(submissions).toBe(0);
  await draft.press("Enter");
  await expect(page.locator("#thread-messages .user").last()).toContainText("Line one");
  await expect(draft).toHaveValue("");
  expect(submissions).toBe(1);
  await draft.fill("   ");
  await draft.press("Enter");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
  expect(submissions).toBe(1);
});

for (const operation of ["message", "new-task", "task"] as const) {
  test(`lost ${operation} admission recovers exact identity without clearing newer drafts`, async ({
    page,
    runtime: { ready, restart },
  }) => {
    await page.goto(ready.url);
    await page.getByLabel("Connection credential").fill(ready.credential);
    await page.getByRole("button", { name: "Pair with Host" }).click();
    await page.getByRole("button", { name: "Select Personal", exact: true }).click();
    await page.getByRole("button", { name: "Create a Bot", exact: true }).click();
    await page.getByLabel("Bot name").fill("Writer");
    await page.getByLabel("Role instructions").fill("Write clearly.");
    await page.getByLabel("Model", { exact: true }).selectOption("deepseek/deepseek-chat");
    await page.getByRole("button", { name: "Create Bot", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Bot details: Writer", exact: true }),
    ).toBeVisible();
    const draft = page.getByLabel("Message", { exact: true });
    if (operation === "new-task") {
      await page.getByRole("button", { name: "Message actions", exact: true }).click();
      await page.getByRole("button", { name: "New task", exact: true }).click();
    } else if (operation === "task") {
      await draft.fill("Original objective");
      const first = page.waitForResponse((response) => response.url().endsWith("/thread/messages"));
      await draft.press("Enter");
      const { taskId } = await (await first).json();
      await expect(draft).toHaveValue("");
      await page.getByRole("button", { name: "Message actions", exact: true }).click();
      await page.getByLabel("Input target").selectOption(taskId);
    }
    await draft.fill("Admit just once");
    const admitted = Promise.withResolvers<{
      taskId: string;
      runId: string;
      messageId: string;
      requestId: string;
    }>();
    const release = Promise.withResolvers<void>();
    let originalPath = "";
    let originalBody = "";
    await page.route(
      operation === "task"
        ? "**/tasks/*/inputs"
        : `**/thread/${operation === "new-task" ? "tasks" : "messages"}`,
      async (route) => {
        originalPath = route.request().url();
        originalBody = route.request().postData() ?? "";
        const response = await route.fetch();
        admitted.resolve(await response.json());
        await release.promise;
        await route.abort("failed");
      },
      { times: 1 },
    );
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    const association = await admitted.promise;
    await expect(draft).toBeEditable();
    await draft.fill("Newer Writer draft");
    release.resolve();
    await expect(page.locator("#chat-message")).toContainText("response unconfirmed");
    await expect(draft).toHaveValue("Newer Writer draft");
    await page.getByRole("button", { name: "Select Personal", exact: true }).click();
    await draft.fill("Newer Personal draft");
    await restart();
    await page.reload();
    await expect(draft).toHaveValue("Newer Personal draft");
    let recoveryPosts = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url() === originalPath) recoveryPosts++;
    });
    await draft.press("Enter");
    await expect(
      page.getByRole("button", { name: "Retry chat request", exact: true }),
    ).toBeVisible();
    expect(recoveryPosts).toBe(0);
    const recovered = page.waitForResponse(
      (response) => response.request().method() === "POST" && response.url() === originalPath,
    );
    await page.getByRole("button", { name: "Retry chat request", exact: true }).click();
    const response = await recovered;
    expect(response.request().postData()).toBe(originalBody);
    expect(await response.json()).toEqual({ ...association, replayed: true });
    await expect(
      page.getByRole("button", { name: "Retry chat request", exact: true }),
    ).toBeHidden();
    await expect(draft).toHaveValue("Newer Personal draft");
    await page.getByRole("button", { name: "Select Writer", exact: true }).click();
    await expect(draft).toHaveValue("Newer Writer draft");
    await expect(
      page.locator("#thread-messages .user").filter({ hasText: "Admit just once" }),
    ).toHaveCount(1);
    const detail = await page.evaluate(
      async (url) =>
        (await fetch(`${new URL(url).pathname.split("/").slice(0, 4).join("/")}/thread`)).json(),
      originalPath,
    );
    expect(detail.tasks).toHaveLength(1);
    expect(detail.tasks[0].id).toBe(association.taskId);
    expect(detail.tasks[0].runs).toHaveLength(1);
    expect(detail.tasks[0].runs[0].id).toBe(association.runId);
  });
}

test("composer shows independent work and preserves a stale explicit target", async ({
  page,
  runtime: { ready, host },
}) => {
  await page.goto(ready.url);
  await page.getByLabel("Connection credential").fill(ready.credential);
  await page.getByRole("button", { name: "Pair with Host" }).click();
  await page.getByRole("button", { name: "Select Personal", exact: true }).click();
  const draft = page.getByLabel("Message", { exact: true });
  await draft.fill("Independent objective");
  await page.getByRole("button", { name: "Message actions", exact: true }).click();
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await expect(page.locator("#composer-target")).toContainText("New independent task");
  const admission = page.waitForResponse((response) => response.url().endsWith("/thread/tasks"));
  await draft.press("Enter");
  const { taskId, runId } = await (await admission).json();
  await expect(draft).toHaveValue("");
  await page.getByRole("button", { name: "Message actions", exact: true }).click();
  await page.getByLabel("Input target").selectOption(taskId);
  await expect(page.locator("#composer-target")).toContainText("Add to Independent objective");
  await expect(page.locator("#composer-target")).not.toContainText(taskId);
  await draft.fill("Specific queued addition");
  const added = page.waitForResponse((response) =>
    response.url().endsWith(`/tasks/${taskId}/inputs`),
  );
  await draft.press("Enter");
  expect(await (await added).json()).toMatchObject({ taskId, runId });
  await draft.fill("Keep this stale addition");
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(viewport);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <= innerWidth &&
          document.documentElement.scrollHeight <= innerHeight,
      ),
    ).toBe(true);
    await page.screenshot({ path: `/tmp/mybots-composer-${viewport.width}.png` });
  }
  host.send("complete");
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await expect(page.locator(`#chat-works article[data-task-id="${taskId}"]`)).toContainText(
    "Execution: succeeded",
  );
  await expect(page.getByLabel("Input target")).toHaveValue(taskId);
  await expect(page.locator("#composer-target")).toContainText("unavailable");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
  await page.reload();
  await expect(draft).toHaveValue("Keep this stale addition");
  await expect(page.getByLabel("Input target")).toHaveValue(taskId);
  await page.getByRole("button", { name: "Return to Thread", exact: true }).click();
  await expect(page.getByLabel("Input target")).toHaveValue("");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
});

test("offline drafts remain editable and observer loss does not disable HTTP admission", async ({
  page,
  runtime: { ready, host, restart },
}) => {
  const socketOpened = Promise.withResolvers<void>();
  const closeObserver = Promise.withResolvers<() => void>();
  await page.routeWebSocket("**/ws", (socket) => {
    const server = socket.connectToServer();
    closeObserver.resolve(() => {
      server.close();
      socket.close();
    });
    socketOpened.resolve();
  });
  await page.goto(ready.url);
  await page.getByLabel("Connection credential").fill(ready.credential);
  await page.getByRole("button", { name: "Pair with Host" }).click();
  await page.getByRole("button", { name: "Select Personal", exact: true }).click();
  const draft = page.getByLabel("Message", { exact: true });
  await socketOpened.promise;
  (await closeObserver.promise)();
  await draft.fill("HTTP still admits without observation");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
  await draft.press("Enter");
  await expect(page.locator("#thread-messages .user").last()).toContainText("HTTP still admits");
  const stopped = once(host, "exit");
  host.kill("SIGTERM");
  await stopped;
  await page.getByRole("button", { name: "Refresh status", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Host unavailable");
  await draft.fill("Offline unsent draft");
  await expect(draft).toBeEditable();
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
  let posts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST") posts++;
  });
  await draft.press("Enter");
  await page.getByRole("button", { name: "Refresh status", exact: true }).click();
  await expect(draft).toHaveValue("Offline unsent draft");
  expect(posts).toBe(0);
  await restart();
  await page.reload();
  await expect(draft).toHaveValue("Offline unsent draft");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
  expect(posts).toBe(0);
});

test("explicit additions to a waiting Task retain its Run and do not answer its question", async ({
  page,
  runtime: { root, ready },
}) => {
  const mailbox = new RunnerMailbox(join(root, "data", "sessions", "personal", ready.sessionId));
  mailbox.requestHistory({
    id: "composer-question",
    operation: "ask_question",
    incarnation: mailbox.executionIncarnation(),
    input: { requestId: "composer-question", text: "Which city?" },
  });
  await expect
    .poll(() => mailbox.historyResponse("composer-question"))
    .toMatchObject({ result: { state: "pending" } });
  mailbox.requestDurableWait("owner-question");
  await page.goto(ready.url);
  await page.getByLabel("Connection credential").fill(ready.credential);
  await page.getByRole("button", { name: "Pair with Host" }).click();
  await page.getByRole("button", { name: "Select Personal", exact: true }).click();
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await expect(page.locator("#chat-works")).toContainText("Execution: waiting");
  const taskId = await page.locator("#chat-works article").first().getAttribute("data-task-id");
  await page
    .locator("#chat-works article")
    .first()
    .getByRole("button", { name: "Add instructions", exact: true })
    .click();
  await expect(page.getByLabel("Input target")).toHaveValue(taskId as string);
  await page.getByLabel("Message", { exact: true }).fill("Additional waiting instructions");
  const admitted = page.waitForResponse((response) =>
    response.url().endsWith(`/tasks/${taskId}/inputs`),
  );
  await page.getByLabel("Message", { exact: true }).press("Enter");
  expect(await (await admitted).json()).toMatchObject({ taskId, runId: ready.sessionId });
  await expect(page.locator("#chat-works")).toContainText("Additional waiting instructions");
  await expect(page.locator("#chat-works")).toContainText("Execution: waiting");
  await expect(page.locator("#chat-works").getByLabel("Answer to Which city?")).toBeVisible();
  await expect(page.locator("#chat-works")).not.toContainText("Owner answer:");
});

test("confirmed admission preserves newer text even when browser draft storage fails", async ({
  page,
  runtime: { ready },
}) => {
  await page.goto(ready.url);
  await page.getByLabel("Connection credential").fill(ready.credential);
  await page.getByRole("button", { name: "Pair with Host" }).click();
  await page.getByRole("button", { name: "Select Personal", exact: true }).click();
  const draft = page.getByLabel("Message", { exact: true });
  await draft.fill("Earlier submission");
  const admitted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route(
    "**/thread/messages",
    async (route) => {
      const response = await route.fetch();
      admitted.resolve();
      await release.promise;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  await draft.press("Enter");
  await admitted.promise;
  const original = await page.evaluateHandle(() => Storage.prototype.setItem);
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("Storage is full", "QuotaExceededError");
    };
  });
  await draft.fill("Newer unsaved draft");
  await expect(page.locator("#chat-message")).toContainText("Could not save this draft");
  await page.evaluate((method) => {
    Storage.prototype.setItem = method;
  }, original);
  await original.dispose();
  release.resolve();
  await expect(page.locator("#chat-message")).toHaveText("Message sent.");
  await expect(draft).toHaveValue("Newer unsaved draft");
});

test("repeated Task instructions remain distinguishable in chat and attachment destinations", async ({
  page,
  runtime: { ready },
}) => {
  const tasks: string[] = [];
  for (const requestId of ["repeated-first", "repeated-second"]) {
    const response = await page.request.post(`${ready.url}/api/bots/personal/thread/tasks`, {
      headers: { Authorization: `Bearer ${ready.credential}` },
      data: { requestId, text: "Repeated objective" },
    });
    expect(response.status()).toBe(202);
    tasks.push(((await response.json()) as { taskId: string }).taskId);
  }
  await page.goto(ready.url);
  await page.getByLabel("Connection credential").fill(ready.credential);
  await page.getByRole("button", { name: "Pair with Host" }).click();
  await page.getByRole("button", { name: "Select Personal", exact: true }).click();
  await page.getByRole("button", { name: "Message actions", exact: true }).click();
  const labels = await Promise.all(
    tasks.map((id) => page.locator(`#input-target option[value="${id}"]`).textContent()),
  );
  expect(labels[0]).toContain("Repeated objective");
  expect(labels[1]).toContain("Repeated objective");
  expect(labels[0]).not.toBe(labels[1]);
  await page.getByLabel("Input target", { exact: true }).selectOption(tasks[0] as string);
  await expect(page.locator("#composer-target")).toContainText(labels[0] as string);
  await page.getByLabel("Message", { exact: true }).fill("Only the first occurrence");
  const admitted = page.waitForResponse((response) =>
    response.url().endsWith(`/tasks/${tasks[0]}/inputs`),
  );
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  expect(await (await admitted).json()).toMatchObject({ taskId: tasks[0] });
  await page.getByRole("button", { name: "Bot details: Personal", exact: true }).click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  for (const [index, id] of tasks.entries()) {
    await expect(page.locator(`#attachment-task option[value="${id}"]`)).toHaveText(
      labels[index] as string,
    );
  }
  await page.getByLabel("Attachment Task", { exact: true }).selectOption(tasks[1] as string);
  await expect(page.locator("#attachment-scope")).toContainText(labels[1] as string);
});
