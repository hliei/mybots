import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerMailbox } from "@mybots/mailbox/node";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { PiProvider } from "../packages/agent-runner/src/providers/pi.ts";
import { WebSocketChannel } from "../packages/host/src/channels/websocket.ts";
import { loadHostSettings } from "../packages/host/src/config/host.ts";
import type { SessionDriver } from "../packages/host/src/drivers/types.ts";
import { Host } from "../packages/host/src/host.ts";
import { MailboxDriver } from "./host-fixture.ts";
import { startPiService } from "./pi-fixture.ts";
import { piRunDriver } from "./pi-run-driver.ts";

let root: string;
let host: Host;
let channel: WebSocketChannel;
let base: string;
let headers: Record<string, string>;
afterEach(async () => {
  await channel?.close();
  await host?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});
async function start(driver: SessionDriver = new MailboxDriver()) {
  root = await mkdtemp(join(tmpdir(), "mybots-chat-"));
  const { configuration } = await loadHostSettings("examples/host/host.json");
  host = await Host.start({ root, configuration, driver });
  await listen(configuration);
  return configuration;
}
async function listen(
  configuration: Awaited<ReturnType<typeof loadHostSettings>>["configuration"],
) {
  channel = await WebSocketChannel.listen({ root, host, configuration, port: 0 });
  base = `http://127.0.0.1:${channel.address.port}`;
  headers = {
    Authorization: `Bearer ${(await readFile(join(root, "data", "client-credential"), "utf8")).trim()}`,
    "Content-Type": "application/json",
  };
}
function post(path: string, body: unknown) {
  return fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}
async function get(path: string) {
  const response = await fetch(`${base}${path}`, { headers });
  expect(response.status).toBe(200);
  return response.json();
}

it("pages original Chinese history with stable cursors, complete text offsets and scoped anchors", async () => {
  await start();
  const path = "/api/bots/personal/thread";
  let anchor = "";
  for (let index = 0; index < 4; index++) {
    const sent = await (
      await post(`${path}/tasks`, {
        requestId: `history-${index}`,
        text: `项目 火星 更正 ${index} ${"原文😀".repeat(2200)}`,
      })
    ).json();
    anchor ||= sent.messageId;
    await vi.waitFor(async () =>
      expect((await get(path)).tasks[index].runs[0].state).toBe("succeeded"),
    );
  }
  const page = await get(`${path}/history?query=${encodeURIComponent("项目 火星")}`);
  expect(page.messages).toHaveLength(5);
  expect(page.coverage.status).toBe("partial");
  expect(page.nextBeforeSeq).toEqual(expect.any(Number));
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(10000);
  expect(page.messages[0]).toMatchObject({ truncated: true, nextTextOffset: expect.any(Number) });
  const older = await get(
    `${path}/history?query=${encodeURIComponent("项目 火星")}&beforeSeq=${page.nextBeforeSeq}`,
  );
  expect(older.messages).toHaveLength(3);
  expect(older.coverage.status).toBe("exhausted");
  const read = await get(`${path}/history?messageId=${anchor}&textOffset=2000`);
  expect(read.messages[0]).toMatchObject({ id: anchor, textOffset: 2000 });
  expect(read.runs[0]).toMatchObject({ state: "succeeded" });
  expect((await fetch(`${base}${path}/history?messageId=foreign`, { headers })).status).toBe(404);
  expect((await fetch(`${base}${path}/history?beforeSeq=-1`, { headers })).status).toBe(400);
  expect((await fetch(`${base}${path}/history`)).status).toBe(401);
});

it("streams real Pi activity before completion and retrieves originals through fenced production mailboxes", async () => {
  const configuration = await start();
  const path = "/api/bots/personal/thread";
  const old = await (
    await post(`${path}/messages`, { requestId: "old", text: "火星项目 原定星期一" })
  ).json();
  await vi.waitFor(async () => expect((await get(path)).tasks[0].runs[0].state).toBe("succeeded"));
  await channel.close();
  await host.stop();
  const release = Promise.withResolvers<void>();
  let toolResult = "";
  const service = await startPiService(async (request) => {
    const tools = request.messages.filter((row) => row.role === "tool");
    if (!tools.length)
      return { tool: "search_history", arguments: { query: "火星项目" }, text: "正在查找原文" };
    toolResult = JSON.stringify(tools[0]?.content);
    if (tools.length === 1)
      return { tool: "read_history", arguments: { messageId: old.messageId } };
    await release.promise;
    return { text: "查阅原文后完成" };
  });
  const provider = new PiProvider({ modelRuntime: service.runtime, model: service.model });
  const frames: Record<string, unknown>[] = [];
  let socket: WebSocket | undefined;
  try {
    host = await Host.start({ root, configuration, driver: piRunDriver(provider) });
    await listen(configuration);
    socket = new WebSocket(`${base.replace("http", "ws")}/ws`, { headers });
    socket.on("message", (data) => frames.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => {
      socket?.once("open", resolve);
      socket?.once("error", reject);
    });
    const sent = await (
      await post(`${path}/messages`, {
        requestId: "search",
        text: "查火星项目；不要把这个源请求搜索回来",
      })
    ).json();
    await service.waitForRequest(3);
    expect(toolResult).toContain(old.messageId);
    expect(toolResult).not.toContain("不要把这个源请求搜索回来");
    await vi.waitFor(() =>
      expect(
        frames.some(
          (row) => row.type === "execution" && JSON.stringify(row).includes("正在查找原文"),
        ),
      ).toBe(true),
    );
    expect((await get(path)).tasks.at(-1).runs[0].state).toBe("active");
    const evidencePath = `/api/bots/personal/runs/${sent.runId}/history`;
    let evidence = await get(evidencePath);
    expect(JSON.stringify(evidence)).toContain("search_history");
    release.resolve();
    await vi.waitFor(async () =>
      expect((await get(path)).tasks.at(-1).runs[0].state).toBe("succeeded"),
    );
    socket.close();
    await channel.close();
    await host.stop();
    host = await Host.start({ root, configuration, driver: new MailboxDriver() });
    await listen(configuration);
    evidence = await get(evidencePath);
    const records = [...evidence.records];
    while (evidence.nextAfter) {
      evidence = await get(`${evidencePath}?after=${evidence.nextAfter}`);
      records.push(...evidence.records);
    }
    expect(records.some((row: { text: string }) => row.text === "查阅原文后完成")).toBe(true);
    expect(
      (await fetch(`${base}/api/bots/foreign/runs/${sent.runId}/history`, { headers })).status,
    ).toBe(404);
  } finally {
    release.resolve();
    socket?.close();
    await channel.close();
    await host.stop();
    await service.close();
  }
});

it("derives history scope from the running mailbox, rejects widening and stale execution, and reads later corrections", async () => {
  const driver = new MailboxDriver();
  let runner: import("@mybots/mailbox").RunnerMailbox | undefined;
  const hold = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  driver.respond = async (input, material, signal) => {
    if (input.content.startsWith("Current")) {
      runner = new RunnerMailbox(material.directory);
      entered.resolve();
      await Promise.race([
        hold.promise,
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
      ]);
    }
    return `Reply ${input.content}`;
  };
  await start(driver);
  const path = "/api/bots/personal/thread";
  const old = await (
    await post(`${path}/messages`, { requestId: "old", text: "火星项目：星期一" })
  ).json();
  await vi.waitFor(async () => expect((await get(path)).tasks[0].runs[0].state).toBe("succeeded"));
  const other = await (
    await post("/api/bots", {
      requestId: "other",
      name: "Other",
      instructions: "Other Bot",
      model: { provider: "deepseek", id: "deepseek-chat" },
      tools: ["read"],
    })
  ).json();
  const secret = await (
    await post(`/api/bots/${other.bot.id}/thread/messages`, {
      requestId: "secret",
      text: "火星项目 secret",
    })
  ).json();
  const current = await (
    await post(`${path}/messages`, { requestId: "current", text: "Current 火星项目" })
  ).json();
  await entered.promise;
  const correction = await (
    await post(`${path}/messages`, { requestId: "correction", text: "火星项目更正：星期二" })
  ).json();
  const mailbox = runner as unknown as RunnerMailbox;
  const incarnation = mailbox.executionIncarnation();
  const request = async (
    id: string,
    operation: "search_history" | "read_history",
    input: unknown,
    fence = incarnation,
  ) => {
    mailbox.requestHistory({ id, operation, input, incarnation: fence });
    await vi.waitFor(() => expect(mailbox.historyResponse(id)).toBeDefined());
    return mailbox.historyResponse(id) as {
      result: { messages: { id: string }[] };
      error?: string;
    };
  };
  try {
    const found = await request("search", "search_history", { query: "火星项目" });
    expect(found.result.messages.map((row) => row.id)).toContain(old.messageId);
    expect(found.result.messages.map((row) => row.id)).not.toContain(current.messageId);
    expect(found.result.messages.map((row) => row.id)).not.toContain(secret.messageId);
    const read = await request("read", "read_history", { messageId: current.messageId });
    expect(read.result.messages.map((row) => row.id)).toContain(correction.messageId);
    expect(read.result.messages.map((row) => row.id)).toContain(old.messageId);
    expect(
      (await request("foreign", "read_history", { messageId: secret.messageId })).error,
    ).toContain("not found");
    expect(
      (await request("widen", "search_history", { query: "火星", botId: other.bot.id })).error,
    ).toContain("Unknown history field");
    expect(
      (await request("stale", "search_history", { query: "火星" }, incarnation - 1)).error,
    ).toContain("no longer active");
  } finally {
    hold.resolve();
  }
});

it("retains complete original evidence across real SDK compaction and reads without changing the ledger", async () => {
  const long = "Original 火星😀 ".repeat(16000);
  const service = await startPiService((request) => {
    if (JSON.stringify(request.messages[0]?.content).includes("summar"))
      return { text: "Retained original topic: 火星." };
    return { text: long };
  });
  try {
    await start(
      piRunDriver(new PiProvider({ modelRuntime: service.runtime, model: service.model })),
    );
    const sent = await (
      await post("/api/bots/personal/thread/messages", {
        requestId: "compact",
        text: "Long discussion",
      })
    ).json();
    await vi.waitFor(
      async () =>
        expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("succeeded"),
      { timeout: 10000 },
    );
    const continuation = (await host.inspect(sent.runId)).continuation as string;
    const before = await readFile(continuation.slice(3), "utf8");
    expect(before).toContain('"type":"compaction"');
    const path = `/api/bots/personal/runs/${sent.runId}/history`;
    const page = await get(path);
    const original = page.records.find((row: { kind: string }) => row.kind === "assistant");
    expect(original).toBeDefined();
    let restored = original.text;
    let next = original.nextTextOffset;
    while (next !== null) {
      const response = await get(`${path}?recordId=${original.id}&textOffset=${next}`);
      expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(10000);
      restored += response.records[0].text;
      next = response.records[0].nextTextOffset;
    }
    expect(restored).toBe(long);
    expect(await readFile(continuation.slice(3), "utf8")).toBe(before);
    const inputs = await get(`${path}?kind=inputs`);
    expect(inputs.records).toMatchObject([
      { id: sent.messageId, kind: "input", text: "Long discussion" },
    ]);
    const attempts = await get(`${path}?kind=attempts`);
    expect(attempts.records).toMatchObject([{ kind: "attempt", incarnation: expect.any(Number) }]);
  } finally {
    await channel.close();
    await host.stop();
    await service.close();
  }
}, 20000);
