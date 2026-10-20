import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerMailbox } from "@mybots/mailbox/node";
import { afterEach, expect, it, vi } from "vitest";
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
  root = await mkdtemp(join(tmpdir(), "mybots-progress-"));
  const { configuration } = await loadHostSettings("examples/host/host.json");
  host = await Host.start({ root, configuration, driver });
  channel = await WebSocketChannel.listen({ root, host, configuration, port: 0 });
  base = `http://127.0.0.1:${channel.address.port}`;
  headers = {
    Authorization: `Bearer ${(await readFile(join(root, "data", "client-credential"), "utf8")).trim()}`,
    "Content-Type": "application/json",
  };
  return configuration;
}
function post(path: string, body: unknown) {
  return fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}
async function get(path: string) {
  const response = await fetch(`${base}${path}`, { headers });
  expect(response.status).toBe(200);
  return response.json();
}
function ask(
  mailbox: RunnerMailbox,
  id: string,
  operation: string,
  input: unknown,
  incarnation = mailbox.executionIncarnation(),
) {
  mailbox.requestHistory({ id, operation, input, incarnation });
  return vi.waitFor(() => {
    const response = mailbox.historyResponse(id);
    expect(response).toBeDefined();
    return response as { result?: Record<string, unknown>; error?: string };
  });
}
async function holdRun() {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const driver = new MailboxDriver();
  driver.respond = async (_input, _material, signal) => {
    entered.resolve();
    await Promise.race([
      release.promise,
      new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      ),
    ]);
    return "Authoritative reply";
  };
  await start(driver);
  const sent = await (
    await post("/api/bots/personal/thread/messages", {
      requestId: "progress-source",
      text: "Inspect the archive",
    })
  ).json();
  await entered.promise;
  const mailbox = new RunnerMailbox(driver.launches[0]?.material.directory as string);
  return { driver, release, sent, mailbox };
}

it("publishes Attempt progress and a selected text result without deciding the Run outcome", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const driver = new MailboxDriver();
  driver.respond = async (_input, _material, signal) => {
    entered.resolve();
    await Promise.race([
      release.promise,
      new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      ),
    ]);
    return "Authoritative reply";
  };
  await start(driver);
  const sent = await (
    await post("/api/bots/personal/thread/messages", {
      requestId: "progress-source",
      text: "Inspect the archive",
    })
  ).json();
  await entered.promise;
  const mailbox = new RunnerMailbox(driver.launches[0]?.material.directory as string);
  const incarnation = mailbox.executionIncarnation();
  const request = async (id: string, operation: string, input: unknown) => {
    mailbox.requestHistory({ id, operation, input, incarnation });
    await vi.waitFor(() => expect(mailbox.historyResponse(id)).toBeDefined());
    return mailbox.historyResponse(id) as { result?: unknown; error?: string };
  };
  expect(
    (await request("note", "publish_progress", { requestId: "note", text: "Reading shelf 3" }))
      .result,
  ).toMatchObject({
    kind: "progress",
    text: "Reading shelf 3",
    botId: "personal",
    taskId: sent.taskId,
    runId: sent.runId,
  });
  expect(
    (
      await request("choice", "publish_result", {
        requestId: "choice",
        text: "Shelf 3 holds the 1962 ledger",
      })
    ).result,
  ).toMatchObject({
    kind: "result",
    text: "Shelf 3 holds the 1962 ledger",
    runId: sent.runId,
  });
  const run = (await get("/api/bots/personal/thread")).tasks[0].runs[0];
  expect(run.outcome).toBeNull();
  expect(run.state).toBe("active");
  expect(run.progress).toEqual([
    expect.objectContaining({
      id: "note",
      text: "Reading shelf 3",
      attemptId: expect.any(String),
    }),
  ]);
  expect(run.selectedResults).toEqual([
    expect.objectContaining({
      id: "choice",
      text: "Shelf 3 holds the 1962 ledger",
      attemptId: run.progress[0].attemptId,
    }),
  ]);
  expect(run.progress[0].attemptId).toBe(
    run.attempts.find((attempt: { endedAt: string | null }) => attempt.endedAt === null).id,
  );
  const searched = await get("/api/bots/personal/thread/history?query=Reading%20shelf");
  expect(searched.messages).toEqual([]);
  release.resolve();
});

it("rejects forged identity, stale Attempts, cross-Bot administration, owner changes and self-grants", async () => {
  const { release, mailbox } = await holdRun();
  const incarnation = mailbox.executionIncarnation();
  expect(
    (
      await ask(mailbox, "forged", "publish_progress", {
        requestId: "forged",
        text: "x",
        botId: "other",
      })
    ).error,
  ).toBe("Forged execution identity is rejected.");
  expect(
    (
      await ask(
        mailbox,
        "stale",
        "publish_progress",
        { requestId: "stale", text: "x" },
        incarnation + 1,
      )
    ).error,
  ).toBe("Execution scope is no longer active.");
  expect((await ask(mailbox, "admin", "administer_bot", { name: "Other" })).error).toBe(
    "Cross-Bot administration is rejected.",
  );
  expect((await ask(mailbox, "owner", "configure_bot", { instructions: "Take over" })).error).toBe(
    "Bot administration is owner-only.",
  );
  expect((await ask(mailbox, "grant", "grant_privilege", {})).error).toBe(
    "Privilege grants are owner-only.",
  );
  expect(
    (
      await ask(mailbox, "hidden-grant", "publish_result", {
        requestId: "hidden-grant",
        text: "x",
        privileges: ["owner"],
      })
    ).error,
  ).toBe("Privilege grants are owner-only.");
  const run = (await get("/api/bots/personal/thread")).tasks[0].runs[0];
  expect(run.progress).toEqual([]);
  expect(run.selectedResults).toEqual([]);
  expect(run.outcome).toBeNull();
  release.resolve();
});

it("returns the original publication for a repeated request and a later lookup", async () => {
  const { release, mailbox } = await holdRun();
  await ask(mailbox, "note", "publish_progress", { requestId: "note", text: "Reading shelf 3" });
  const repeated = await ask(mailbox, "note", "publish_progress", {
    requestId: "note",
    text: "A different shelf",
  });
  expect(repeated.result).toMatchObject({ kind: "progress", text: "Reading shelf 3" });
  const lookup = await ask(mailbox, "lookup-note", "read_operation", { requestId: "note" });
  expect(lookup.result).toMatchObject({
    state: "recorded",
    publication: { id: "note", text: "Reading shelf 3" },
  });
  expect((await ask(mailbox, "missing", "read_operation", { requestId: "absent" })).result).toEqual(
    {
      state: "absent",
    },
  );
  const run = (await get("/api/bots/personal/thread")).tasks[0].runs[0];
  expect(run.progress).toEqual([expect.objectContaining({ id: "note", text: "Reading shelf 3" })]);
  release.resolve();
});

it("keeps a cancelled Run unresolved when a late result arrives", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const driver = new MailboxDriver();
  driver.respond = async (_input, _material, signal) => {
    entered.resolve();
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    await release.promise;
    return "Should not become the outcome";
  };
  await start(driver);
  await (
    await post("/api/bots/personal/thread/messages", {
      requestId: "cancel-source",
      text: "Stop before the result",
    })
  ).json();
  await entered.promise;
  const mailbox = new RunnerMailbox(driver.launches[0]?.material.directory as string);
  await ask(mailbox, "choice", "publish_result", {
    requestId: "choice",
    text: "Shelf 3 holds the 1962 ledger",
  });
  expect(
    (
      await post(
        "/api/bots/personal/runs/" +
          encodeURIComponent((await get("/api/bots/personal/thread")).tasks[0].runs[0].id) +
          "/stop",
        { requestId: "stop-archive" },
      )
    ).status,
  ).toBe(202);
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("stopping"),
  );
  expect(
    (await ask(mailbox, "late", "publish_result", { requestId: "late", text: "False success" }))
      .error,
  ).toBe("Cancelled work cannot be revived.");
  const stopping = (await get("/api/bots/personal/thread")).tasks[0].runs[0];
  expect(stopping.state).toBe("stopping");
  expect(stopping.outcome).toBeNull();
  expect(stopping.selectedResults).toEqual([
    expect.objectContaining({ id: "choice", text: "Shelf 3 holds the 1962 ledger" }),
  ]);
  release.resolve();
});

it("preserves progress and the selected result across Host restart", async () => {
  const { release, mailbox } = await holdRun();
  const configuration = await loadHostSettings("examples/host/host.json").then(
    (loaded) => loaded.configuration,
  );
  await ask(mailbox, "note", "publish_progress", { requestId: "note", text: "Reading shelf 3" });
  await ask(mailbox, "choice", "publish_result", {
    requestId: "choice",
    text: "Shelf 3 holds the 1962 ledger",
  });
  release.resolve();
  await channel.close();
  await host.stop();
  host = await Host.start({ root, configuration, driver: new MailboxDriver() });
  channel = await WebSocketChannel.listen({ root, host, configuration, port: 0 });
  base = `http://127.0.0.1:${channel.address.port}`;
  headers = {
    Authorization: `Bearer ${(await readFile(join(root, "data", "client-credential"), "utf8")).trim()}`,
    "Content-Type": "application/json",
  };
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("succeeded"),
  );
  const run = (await get("/api/bots/personal/thread")).tasks[0].runs[0];
  expect(run.outcome.reply).toBe("Authoritative reply");
  expect(run.progress).toEqual([expect.objectContaining({ text: "Reading shelf 3" })]);
  expect(run.selectedResults).toEqual([
    expect.objectContaining({ text: "Shelf 3 holds the 1962 ledger" }),
  ]);
});

it("publishes through the production runner and real SDK without a second result", async () => {
  const release = Promise.withResolvers<void>();
  const service = await startPiService(async (request) => {
    const tools = request.messages.filter((row) => row.role === "tool");
    if (tools.length === 0)
      return {
        tool: "publish_progress",
        arguments: { requestId: "sdk-note", text: "Reading shelf 3" },
        text: "Recording progress",
      };
    if (tools.length === 1)
      return {
        tool: "publish_result",
        arguments: { requestId: "sdk-result", text: "Shelf 3 holds the 1962 ledger" },
        text: "Recording result",
      };
    if (tools.length === 2)
      return {
        tool: "read_operation",
        arguments: { requestId: "sdk-result" },
        text: "Checking result",
      };
    if (tools.length === 3)
      return {
        tool: "publish_result",
        arguments: { requestId: "sdk-result", text: "A different ledger" },
        text: "Retrying the same request",
      };
    await release.promise;
    return { text: "Authoritative archive reply" };
  });
  try {
    await start(
      piRunDriver(new PiProvider({ modelRuntime: service.runtime, model: service.model })),
    );
    await (
      await post("/api/bots/personal/thread/messages", {
        requestId: "sdk-source",
        text: "Publish the archive result",
      })
    ).json();
    await vi.waitFor(async () => {
      const run = (await get("/api/bots/personal/thread")).tasks[0].runs[0];
      expect(run.progress).toEqual([expect.objectContaining({ text: "Reading shelf 3" })]);
      expect(run.selectedResults).toEqual([
        expect.objectContaining({ id: "sdk-result", text: "Shelf 3 holds the 1962 ledger" }),
      ]);
      expect(run.outcome).toBeNull();
    });
    release.resolve();
    await vi.waitFor(async () =>
      expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].outcome.reply).toBe(
        "Authoritative archive reply",
      ),
    );
    const finished = (await get("/api/bots/personal/thread")).tasks[0].runs[0];
    expect(finished.selectedResults).toHaveLength(1);
    expect(finished.outcome.kind).toBe("succeeded");
  } finally {
    release.resolve();
    await service.close();
  }
}, 20000);
