import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HostMailbox, RunnerMailbox } from "@mybots/mailbox/node";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocketChannel } from "../packages/host/src/channels/websocket.ts";
import { loadHostSettings } from "../packages/host/src/config/host.ts";
import type { SessionDriver } from "../packages/host/src/drivers/types.ts";
import type { HostConfiguration } from "../packages/host/src/host.ts";
import { Host } from "../packages/host/src/host.ts";
import { MailboxDriver } from "./host-fixture.ts";

let root: string;
let host: Host;
let channel: WebSocketChannel;
let base: string;
let now = Date.parse("2026-10-20T00:00:00Z");
let headers: Record<string, string>;

afterEach(async () => {
  await channel?.close();
  await host?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

async function start(driver: SessionDriver, admission?: HostConfiguration["admission"]) {
  root = await mkdtemp(join(tmpdir(), "mybots-admission-"));
  const loaded = await loadHostSettings("examples/host/host.json");
  const configuration = {
    ...loaded.configuration,
    ...(admission ? { admission } : {}),
  };
  host = await Host.start({ root, configuration, driver, now: () => now, reconcileMs: 36000000 });
  await listen(configuration);
  return configuration;
}

async function listen(configuration: HostConfiguration) {
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

it("exhausts one cumulative hour despite steering and retains capacity until confirmed stop", async () => {
  const external = new MailboxDriver();
  const confirm = Promise.withResolvers<void>();
  const stopping = Promise.withResolvers<void>();
  external.respond = async (input, _material, signal) => {
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return `Final: ${input.content}`;
  };
  const driver: SessionDriver = {
    start: async (material, signal) => {
      const handle = await external.start(material, signal);
      return {
        wait: handle.wait,
        stop: async () => {
          stopping.resolve();
          await confirm.promise;
          await handle.stop();
        },
      };
    },
  };
  try {
    await start(driver);
    const admitted = await (
      await post("/api/bots/personal/thread/messages", {
        requestId: "hold",
        text: "Hold",
      })
    ).json();
    await vi.waitFor(() => expect(external.launches).toHaveLength(1));
    now += 30 * 60000;
    await post("/api/bots/personal/thread/messages", { requestId: "steer", text: "Continue" });
    expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].budget).toMatchObject({
      limitMs: 3600000,
      activeMs: 1800000,
      exhaustedAt: null,
    });
    now += 30 * 60000;
    await vi.waitFor(async () =>
      expect((await get("/api/bots/personal/thread")).tasks[0].runs[0]).toMatchObject({
        id: admitted.runId,
        state: "stopping",
        budget: { activeMs: 3600000, exhaustedAt: new Date(now).toISOString() },
      }),
    );
    await stopping.promise;
    const queued = await (
      await post("/api/bots/personal/thread/tasks", { requestId: "later", text: "Later" })
    ).json();
    expect((await get("/api/bots/personal/thread")).admission.activeCount).toBe(1);
    expect((await get("/api/bots/personal/thread")).tasks[1].runs[0]).toMatchObject({
      id: queued.runId,
      state: "queued",
      budget: { activeMs: 0 },
    });
    confirm.resolve();
    await vi.waitFor(async () =>
      expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("closed"),
    );
    const retry = await (
      await post(`/api/bots/personal/runs/${admitted.runId}/retry`, { requestId: "retry" })
    ).json();
    const runs = (await get("/api/bots/personal/thread")).tasks[0].runs;
    expect(runs[0].budget.exhaustedAt).not.toBeNull();
    expect(runs[1]).toMatchObject({
      id: retry.runId,
      priorRunId: admitted.runId,
      budget: { activeMs: 0, exhaustedAt: null },
    });
  } finally {
    confirm.resolve();
  }
});

it("excludes a durable wait and restart downtime while preserving spending across Attempts", async () => {
  now = Date.parse("2026-10-20T00:00:00Z");
  const ready = Promise.withResolvers<void>();
  let requestWait = () => {};
  const external = new MailboxDriver();
  external.respond = async (input, material, signal) => {
    requestWait = () => new RunnerMailbox(material.directory).requestDurableWait("owner question");
    ready.resolve();
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return `Final: ${input.content}`;
  };
  const configuration = await start(external);
  const admitted = await (
    await post("/api/bots/personal/thread/messages", { requestId: "waiting", text: "Wait" })
  ).json();
  await vi.waitFor(() => expect(external.launches).toHaveLength(1));
  await ready.promise;
  now += 20 * 60000;
  requestWait();
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).tasks[0].runs[0]).toMatchObject({
      state: "waiting",
      budget: { activeMs: 1200000 },
    }),
  );
  await channel.close();
  await host.stop();
  now += 24 * 60 * 60000;
  host = await Host.start({
    root,
    configuration,
    driver: external,
    now: () => now,
    reconcileMs: 36000000,
  });
  await listen(configuration);
  expect((await get("/api/bots/personal/thread")).tasks[0].runs[0]).toMatchObject({
    state: "waiting",
    budget: { activeMs: 1200000, exhaustedAt: null },
  });
  new HostMailbox(external.launches[0].material.directory).retryInput(
    admitted.messageId,
    new Date(0).toISOString(),
  );
  new RunnerMailbox(external.launches[0].material.directory).resumeDurableWait();
  await vi.waitFor(() => expect(external.launches).toHaveLength(2));
  now += 39 * 60000;
  expect((await get("/api/bots/personal/thread")).tasks[0].runs[0]).toMatchObject({
    id: admitted.runId,
    state: "active",
    attempts: [expect.any(Object), expect.any(Object)],
    budget: { activeMs: 3540000, exhaustedAt: null },
  });
  now += 60000;
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).tasks[0].runs[0]).toMatchObject({
      state: "closed",
      budget: { activeMs: 3600000, exhaustedAt: new Date(now).toISOString() },
    }),
  );
});

it("keeps spent execution through Host replacement and excludes the stopped interval", async () => {
  now = Date.now();
  const external = new MailboxDriver();
  const ready: (() => void)[] = [];
  external.respond = async (input, _material, signal) => {
    ready.shift()?.();
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return `Final: ${input.content}`;
  };
  const first = Promise.withResolvers<void>();
  ready.push(first.resolve);
  const configuration = await start(external);
  const admitted = await (
    await post("/api/bots/personal/thread/messages", { requestId: "replacement", text: "Hold" })
  ).json();
  await first.promise;
  now += 25 * 60000;
  await channel.close();
  await host.stop();
  now += 10 * 60 * 60000;
  const second = Promise.withResolvers<void>();
  ready.push(second.resolve);
  host = await Host.start({
    root,
    configuration,
    driver: external,
    now: () => now,
    reconcileMs: 36000000,
  });
  await listen(configuration);
  // Advance the external runner's recovery checkpoint independently of the Host clock.
  new HostMailbox(external.launches[0].material.directory).retryInput(
    admitted.messageId,
    new Date(0).toISOString(),
  );
  await second.promise;
  expect((await get("/api/bots/personal/thread")).tasks[0].runs[0]).toMatchObject({
    id: admitted.runId,
    budget: { activeMs: 1500000, exhaustedAt: null },
    attempts: [
      expect.objectContaining({ endedAt: expect.any(String) }),
      expect.objectContaining({ endedAt: null }),
    ],
  });
  now += 35 * 60000;
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).tasks[0].runs[0]).toMatchObject({
      state: "closed",
      budget: { activeMs: 3600000, exhaustedAt: new Date(now).toISOString() },
    }),
  );
});

it("observes immediate reclamation of completed containers separately from active capacity", async () => {
  now = Date.parse("2026-10-20T00:00:00Z");
  const external = new MailboxDriver();
  await start(external);
  for (let index = 0; index < 6; index += 1) {
    const admitted = await (
      await post("/api/bots/personal/thread/tasks", {
        requestId: `done-${index}`,
        text: `Complete ${index}`,
      })
    ).json();
    await vi.waitFor(async () =>
      expect((await get("/api/bots/personal/thread")).tasks[index].runs[0]).toMatchObject({
        id: admitted.runId,
        state: "succeeded",
        attempts: [expect.objectContaining({ endedAt: expect.any(String) })],
      }),
    );
    const launch = external.launches.find((row) => row.material.key.sessionId === admitted.runId);
    expect(external.stopped).toContain(launch?.ref);
  }
  expect(new Set(external.stopped).size).toBe(6);
  expect((await get("/api/bots/personal/thread")).admission.activeCount).toBe(0);
});

it.each([true, false])(
  "preserves crash checkpoints when the old executor survives: %s",
  async (survives) => {
    now = Date.now();
    const external = new MailboxDriver();
    const started = Promise.withResolvers<void>();
    external.respond = async (input, _material, signal) => {
      started.resolve();
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return `Final: ${input.content}`;
    };
    const configuration = await start(external);
    const admitted = await (
      await post("/api/bots/personal/thread/messages", { requestId: "crash", text: "Hold" })
    ).json();
    await started.promise;
    now += 20 * 60000;
    // Make the last active observation durable before recreating the crash window.
    await vi.waitFor(async () =>
      expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].budget.activeMs).toBe(
        1200000,
      ),
    );
    await channel.close();
    await host.stop();
    const db = new DatabaseSync(join(root, "data", "host.db"));
    try {
      db.prepare("UPDATE runs SET active_since = ? WHERE id = ?").run(
        new Date(now).toISOString(),
        admitted.runId,
      );
      db.prepare("UPDATE attempts SET ended_at = NULL WHERE run_id = ?").run(admitted.runId);
      if (survives) {
        // Recreate the preceding schema to verify that adoption also starts budget accounting on upgrade.
        db.exec(
          "DROP INDEX thread_messages_latest; DROP INDEX tasks_thread; DROP INDEX runs_task_state; DROP TABLE IF EXISTS notices; ALTER TABLE runs DROP COLUMN collaboration_waited; DROP TABLE IF EXISTS question_notices; DROP TABLE IF EXISTS telegram_topics; DROP TABLE bot_lifecycle_requests; ALTER TABLE agent_groups DROP COLUMN availability; DROP TABLE action_approvals; DROP TABLE delegation_files; DROP TABLE delegations; DROP TABLE collaboration_grants; DROP TABLE timezone_updates; DROP TABLE bot_timezones; DROP TABLE routine_commands; DROP TABLE routine_occurrences; DROP TABLE routines; DROP TABLE owner_questions; DROP TABLE delivered_artifacts; DROP TABLE agent_publications; DROP TABLE task_attachments; ALTER TABLE runs DROP COLUMN active_ms; ALTER TABLE runs DROP COLUMN active_since; ALTER TABLE runs DROP COLUMN budget_exhausted_at; PRAGMA user_version = 12;",
        );
      }
    } finally {
      db.close();
    }
    if (survives)
      external.observations = [
        { key: { agentGroupId: "personal", sessionId: admitted.runId }, ref: "surviving-executor" },
      ];
    now += 30 * 60000;
    host = await Host.start({
      root,
      configuration,
      driver: external,
      now: () => now,
      reconcileMs: 36000000,
    });
    await listen(configuration);
    const recovered = (await get("/api/bots/personal/thread")).tasks[0].runs[0];
    expect(recovered.budget).toMatchObject({
      activeMs: survives ? 3000000 : 1200000,
      exhaustedAt: null,
    });
    if (survives) {
      expect(external.adopted).toHaveLength(1);
      now += 10 * 60000;
      await vi.waitFor(async () =>
        expect((await get("/api/bots/personal/thread")).tasks[0].runs[0]).toMatchObject({
          state: "closed",
          budget: { activeMs: 3600000 },
        }),
      );
    } else {
      expect(recovered.state).toBe("queued");
      expect(recovered.attempts[0].endedAt).toBe(new Date(now - 30 * 60000).toISOString());
    }
  },
);
