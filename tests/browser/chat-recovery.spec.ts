import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { apiFixture } from "../durable-api-fixture.ts";

test("lost acknowledgements retain submission identity in-page and across reload", async ({
  page,
}) => {
  const fixture = await apiFixture();
  const ids: string[] = [];
  let loseAck = true;
  try {
    const bot = await fixture.request("bots", {
      name: "Delivery",
      instructions: "",
      model: "deepseek/deepseek-flash",
    });
    await page.goto(fixture.url);
    await page.getByLabel("Connection credential").fill(fixture.credential);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.route("**/api/bots/*/send", async (route) => {
      ids.push(route.request().postDataJSON().requestId);
      const response = await route.fetch();
      if (loseAck) await route.abort("failed");
      else await route.fulfill({ response });
    });
    const send = async () => {
      await page.getByLabel("Message", { exact: true }).fill("One intentional input");
      await page.getByRole("button", { name: "Send message" }).click();
    };
    await send();
    await expect(page.locator("#thread-messages article.user")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Retry delivery", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Retry delivery", exact: true }).click();
    await expect.poll(() => ids.length).toBe(2);
    expect(ids[1]).toBe(ids[0]);
    // A failed lookup must leave the identity available for an explicit retry after reload.
    await page.route("**/api/bots/*/submissions/*", (route) => route.abort("failed"));
    await page.reload();
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue("One intentional input");
    loseAck = false;
    await page.getByRole("button", { name: "Retry delivery", exact: true }).click();
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue("");
    expect(ids[2]).toBe(ids[0]);
    expect(fixture.service.requests).toHaveLength(1);
    await send();
    await expect(page.locator("#thread-messages article.user")).toHaveCount(2);
    expect(ids[3]).not.toBe(ids[0]);
    await expect.poll(() => fixture.service.requests.length).toBe(2);
    // Acknowledged execution is reconciled on reload without sending again.
    loseAck = true;
    await send();
    await expect.poll(() => ids.length).toBe(5);
    await page.unroute("**/api/bots/*/submissions/*");
    await page.reload();
    await expect(page.locator("#pending-delivery")).toBeHidden();
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue("");
    expect(ids).toHaveLength(5);
    expect(
      (await fixture.request(`bots/${bot.id}/chat`)).messages.filter(
        (item: { role: string }) => item.role === "user",
      ),
    ).toHaveLength(3);
  } finally {
    await fixture.close();
  }
});

test("readable narration, optional steps and final evidence survive recovery and reconnect", async ({
  page,
}) => {
  let calls = 0;
  let finish: () => void = () => {};
  const final = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let stopPartial: () => void = () => {};
  const partial = new Promise<void>((resolve) => {
    stopPartial = resolve;
  });
  const fixture = await apiFixture(() => {
    calls++;
    if (calls === 1)
      return {
        text: "Checking saved information.",
        tools: [
          { name: "memory_read", arguments: { scope: "bot" } },
          { name: "read_file", arguments: { path: "../private" } },
        ],
      };
    if (calls === 2)
      return {
        chunks: (async function* () {
          yield "Interrupted fragment";
          await partial;
        })(),
      };
    if (calls === 3)
      return {
        chunks: (async function* () {
          yield "Recovered";
          await final;
          yield " final answer";
        })(),
      };
    if (calls === 4) return { tool: "memory_read", arguments: { scope: "bot" } };
    return { status: 401 };
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await fixture.request("bots", {
      name: "Readable",
      instructions: "",
      model: "deepseek/deepseek-flash",
    });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(fixture.url);
    await expect(page).toHaveTitle("Mybots");
    await page.getByLabel("Connection credential").fill(fixture.credential);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByLabel("Message", { exact: true }).fill("Check the information");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.locator("#thread-messages")).toContainText("Interrupted fragment");
    await expect(page.locator(".tool-steps")).toHaveCount(0);
    await expect(page.locator("article.tool")).toHaveCount(0);
    await expect(
      page.locator("article.assistant").filter({ hasText: "Checking saved information." }),
    ).toContainText("Narration");
    await page.getByLabel("Tool activity", { exact: true }).check();
    const steps = page.locator(".tool-steps").first();
    await expect(steps).toHaveAttribute("open", "");
    await expect(steps).toContainText("memory_read · Completed");
    await expect(steps).toContainText("read_file · Failed · Path escapes");
    await steps.locator("summary").click();
    await expect(steps).not.toHaveAttribute("open", "");
    await page.reload();
    await expect(page.getByLabel("Tool activity", { exact: true })).toBeChecked();
    await expect(steps).toHaveAttribute("open", "");
    const { stdout } = await promisify(execFile)("pgrep", [
      "-P",
      String(process.pid),
      "-f",
      fixture.root,
    ]);
    const pids = stdout.trim().split(/\s+/).map(Number);
    expect(pids).toHaveLength(1);
    process.kill(pids[0] as number, "SIGKILL");
    await expect(page.locator("#connection")).toHaveText("Worker recovered");
    await expect(
      page.locator("article.assistant").filter({ hasText: "Interrupted fragment" }),
    ).toContainText("aborted");
    await expect(page.locator("article.assistant").filter({ hasText: "Recovered" })).toContainText(
      "In progress",
    );
    await page.context().setOffline(true);
    finish();
    await expect.poll(async () => (await fixture.request("bots")).worker.state).toBe("recovered");
    await page.context().setOffline(false);
    const answer = page.locator("article.assistant").filter({ hasText: "Recovered final answer" });
    await expect(answer).toHaveCount(1);
    await expect(answer).toContainText("Completed");
    await expect(steps).not.toHaveAttribute("open", "");
    await page.reload();
    await expect(answer).toHaveCount(1);
    await expect(answer).toContainText("Completed");
    await expect(page.locator("article.assistant")).toHaveCount(3);
    await steps.locator("summary").click();
    await page.screenshot({ path: "/tmp/mybots-chat-input-recovery-desktop.png", fullPage: true });
    await page.getByLabel("Tool activity", { exact: true }).uncheck();
    await page.getByLabel("Message", { exact: true }).fill("Tool-only failure");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.locator("#unprocessed")).toContainText("model_error");
    await expect(page.locator("article.assistant")).toHaveCount(3);
    await page.getByLabel("Tool activity", { exact: true }).check();
    await expect(page.locator("article.tool-activity")).toHaveCount(1);
    await expect(
      page.locator("#unprocessed").getByRole("button", { name: "Resend" }),
    ).toBeVisible();
    await page.setViewportSize({ width: 760, height: 900 });
    await page.screenshot({ path: "/tmp/mybots-chat-input-recovery-narrow.png", fullPage: true });
    expect(errors).toEqual([]);
  } finally {
    finish();
    stopPartial();
    await fixture.close();
  }
});

test("unadmitted delivery stays manual after reload and isolated by Bot", async ({ page }) => {
  const fixture = await apiFixture();
  const ids: string[] = [];
  try {
    await fixture.request("bots", {
      name: "Pending",
      instructions: "",
      model: "deepseek/deepseek-flash",
    });
    await fixture.request("bots", {
      name: "Other",
      instructions: "",
      model: "deepseek/deepseek-flash",
    });
    await page.goto(fixture.url);
    await page.getByLabel("Connection credential").fill(fixture.credential);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("button", { name: "Select Pending", exact: true }).click();
    await page.route("**/api/bots/*/send", async (route) => {
      ids.push(route.request().postDataJSON().requestId);
      await route.abort("failed");
    });
    await page.getByLabel("Message", { exact: true }).fill("Not yet admitted");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByRole("button", { name: "Retry delivery", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Select Other", exact: true }).click();
    await expect(page.locator("#pending-delivery")).toBeHidden();
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue("");
    await page.getByRole("button", { name: "Select Pending", exact: true }).click();
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Not yet admitted");
    await page.reload();
    await expect(page.locator("#pending-delivery")).toBeVisible();
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Not yet admitted");
    expect(fixture.service.requests).toHaveLength(0);
    expect(ids).toHaveLength(1);
    await page.getByRole("button", { name: "Discard pending delivery", exact: true }).click();
    await page.unroute("**/api/bots/*/send");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue("");
    await expect.poll(() => fixture.service.requests.length).toBe(1);
  } finally {
    await fixture.close();
  }
});

test("explicit Resend of unanswered input creates new work after a lost acknowledgement", async ({
  page,
}) => {
  const fixture = await apiFixture(() => ({ status: 401 }));
  const ids: string[] = [];
  try {
    await fixture.request("bots", {
      name: "Resend",
      instructions: "",
      model: "deepseek/deepseek-flash",
    });
    await page.goto(fixture.url);
    await page.getByLabel("Connection credential").fill(fixture.credential);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.route("**/api/bots/*/send", async (route) => {
      ids.push(route.request().postDataJSON().requestId);
      const response = await route.fetch();
      if (ids.length === 1) await route.abort("failed");
      else await route.fulfill({ response });
    });
    await page.getByLabel("Message", { exact: true }).fill("Try this input");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByRole("button", { name: "Retry delivery", exact: true })).toBeEnabled();
    await expect(page.locator("#unprocessed")).toContainText("model_error");
    await page.locator("#unprocessed").getByRole("button", { name: "Resend", exact: true }).click();
    await page.getByRole("button", { name: "Send message" }).click();
    await expect.poll(() => fixture.service.requests.length).toBe(2);
    expect(ids).toHaveLength(2);
    expect(ids[1]).not.toBe(ids[0]);
  } finally {
    await fixture.close();
  }
});
