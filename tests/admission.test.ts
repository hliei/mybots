import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RunnerMailbox } from "@mybots/mailbox/node";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocketChannel } from "../packages/host/src/channels/websocket.ts";
import { loadHostSettings } from "../packages/host/src/config/host.ts";
import type { ObservingSessionDriver, SessionDriver } from "../packages/host/src/drivers/types.ts";
import type { HostConfiguration } from "../packages/host/src/host.ts";
import { Host } from "../packages/host/src/host.ts";
import { waitForCheckpoint } from "./checkpoint.ts";
import { MailboxDriver } from "./host-fixture.ts";

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

async function start(driver: SessionDriver, admission?: HostConfiguration["admission"]) {
  root = await mkdtemp(join(tmpdir(), "mybots-admission-"));
  const loaded = await loadHostSettings("examples/host/host.json");
  const configuration = {
    ...loaded.configuration,
    ...(admission ? { admission } : {}),
  };
  host = await Host.start({ root, configuration, driver });
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

async function createBot(name: string) {
  const response = await post("/api/bots", {
    requestId: `bot-${name}`,
    name,
    instructions: `${name} works.`,
    model: { provider: "deepseek", id: "deepseek-chat" },
    tools: [],
  });
  expect(response.status).toBe(201);
  const body = await response.json();
  return body.bot.id as string;
}

it("keeps a fifth Bot queued while four Attempts stay active and does not preempt them", async () => {
  const release = Promise.withResolvers<void>();
  const external = new MailboxDriver();
  external.respond = async (input, _material, signal) => {
    if (input.content === "Hold")
      await Promise.race([
        release.promise,
        new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      ]);
    return `Final: ${input.content}`;
  };
  try {
    await start(external);
    const bots: string[] = [];
    for (const name of ["Alpha", "Beta", "Gamma", "Delta"]) bots.push(await createBot(name));
    const active: { botId: string; runId: string }[] = [];
    for (const [index, botId] of bots.entries()) {
      const admitted = await (
        await post(`/api/bots/${botId}/thread/messages`, {
          requestId: `hold-${index}`,
          text: "Hold",
        })
      ).json();
      active.push({ botId, ...admitted });
    }
    for (const row of active)
      await vi.waitFor(async () =>
        expect((await get(`/api/bots/${row.botId}/thread`)).tasks[0].runs[0]).toMatchObject({
          id: row.runId,
          state: "active",
        }),
      );
    const firstAttempt = (await get(`/api/bots/${bots[0]}/thread`)).tasks[0].runs[0].attempts[0].id;
    const queuedSameBot = await (
      await post(`/api/bots/${bots[0]}/thread/tasks`, {
        requestId: "same-bot-later",
        text: "After Alpha",
      })
    ).json();
    const fifth = await createBot("Epsilon");
    const queuedFifth = await (
      await post(`/api/bots/${fifth}/thread/messages`, {
        requestId: "fifth",
        text: "Fifth",
      })
    ).json();
    await vi.waitFor(async () => {
      const alpha = await get(`/api/bots/${bots[0]}/thread`);
      const epsilon = await get(`/api/bots/${fifth}/thread`);
      expect(alpha.admission).toMatchObject({ activeLimit: 4, activeCount: 4 });
      expect(alpha.tasks[0].runs[0]).toMatchObject({
        id: active[0].runId,
        state: "active",
        attempts: [{ id: firstAttempt, endedAt: null }],
      });
      expect(alpha.tasks[1].runs[0]).toMatchObject({
        id: queuedSameBot.runId,
        state: "queued",
        admissionClass: "interactive",
        queuePosition: expect.any(Number),
        attempts: [],
      });
      expect(epsilon.tasks[0].runs[0]).toMatchObject({
        id: queuedFifth.runId,
        state: "queued",
        attempts: [],
      });
    });
    expect(external.launches.some((row) => row.material.key.sessionId === queuedFifth.runId)).toBe(
      false,
    );
    expect(
      external.launches.some((row) => row.material.key.sessionId === queuedSameBot.runId),
    ).toBe(false);
  } finally {
    release.resolve();
  }
});

it("admits a never-served Bot before the Bot that already holds a later task", async () => {
  const releaseAlpha = Promise.withResolvers<void>();
  const releaseBeta = Promise.withResolvers<void>();
  const releaseLater = Promise.withResolvers<void>();
  const releaseBetaNext = Promise.withResolvers<void>();
  const external = new MailboxDriver();
  external.respond = async (input, _material, signal) => {
    const gates: Record<string, typeof releaseAlpha> = {
      Hold: releaseAlpha,
      Beta: releaseBeta,
      Later: releaseLater,
      "Beta next": releaseBetaNext,
    };
    const gate = gates[input.content];
    if (gate)
      await Promise.race([
        gate.promise,
        new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      ]);
    return `Final: ${input.content}`;
  };
  try {
    await start(external, { activeExecutionLimit: 1 });
    const alpha = await createBot("Alpha");
    const held = await (
      await post(`/api/bots/${alpha}/thread/messages`, { requestId: "hold-alpha", text: "Hold" })
    ).json();
    await vi.waitFor(async () =>
      expect((await get(`/api/bots/${alpha}/thread`)).tasks[0].runs[0].state).toBe("active"),
    );
    const second = await (
      await post(`/api/bots/${alpha}/thread/tasks`, { requestId: "alpha-again", text: "Later" })
    ).json();
    const third = await (
      await post(`/api/bots/${alpha}/thread/tasks`, { requestId: "alpha-third", text: "Third" })
    ).json();
    const beta = await createBot("Beta");
    const waiting = await (
      await post(`/api/bots/${beta}/thread/messages`, { requestId: "beta-first", text: "Beta" })
    ).json();
    releaseAlpha.resolve();
    await vi.waitFor(async () =>
      expect((await get(`/api/bots/${beta}/thread`)).tasks[0].runs[0]).toMatchObject({
        id: waiting.runId,
        state: "active",
      }),
    );
    expect((await get(`/api/bots/${alpha}/thread`)).tasks[1].runs[0]).toMatchObject({
      id: second.runId,
      state: "queued",
    });
    expect((await get(`/api/bots/${alpha}/thread`)).tasks[0].runs[0]).toMatchObject({
      id: held.runId,
      state: "succeeded",
    });
    const betaNext = await (
      await post(`/api/bots/${beta}/thread/tasks`, { requestId: "beta-next", text: "Beta next" })
    ).json();
    releaseBeta.resolve();
    await vi.waitFor(async () =>
      expect((await get(`/api/bots/${alpha}/thread`)).tasks[1].runs[0].state).toBe("active"),
    );
    releaseLater.resolve();
    await vi.waitFor(async () =>
      expect((await get(`/api/bots/${beta}/thread`)).tasks[1].runs[0]).toMatchObject({
        id: betaNext.runId,
        state: "active",
      }),
    );
    expect((await get(`/api/bots/${alpha}/thread`)).tasks[2].runs[0]).toMatchObject({
      id: third.runId,
      state: "queued",
    });
  } finally {
    releaseAlpha.resolve();
    releaseBeta.resolve();
    releaseLater.resolve();
    releaseBetaNext.resolve();
  }
});

it("continues another Bot's output while durable-wait termination is unconfirmed", async () => {
  const stopping = Promise.withResolvers<void>();
  const confirmStop = Promise.withResolvers<void>();
  const external = new MailboxDriver();
  external.respond = async (input, material, signal) => {
    if (input.content === "Wait") {
      new RunnerMailbox(material.directory).requestDurableWait("owner question");
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    return `Final: ${input.content}`;
  };
  const driver: SessionDriver = {
    start: async (material, signal) => {
      const handle = await external.start(material, signal);
      return {
        wait: handle.wait,
        stop: async () => {
          if (material.key.agentGroupId === "personal") {
            stopping.resolve();
            await confirmStop.promise;
          }
          await handle.stop();
        },
      };
    },
  };
  try {
    await start(driver);
    const waiting = await (
      await post("/api/bots/personal/thread/messages", { requestId: "wait", text: "Wait" })
    ).json();
    await vi.waitFor(() => expect(external.launches).toHaveLength(1));
    await waitForCheckpoint(stopping.promise, "durable wait stop");
    const beta = await createBot("Beta");
    const outputs: string[] = [];
    const unsubscribe = host.observe((event) => {
      if (event.type === "output") outputs.push(event.sessionId);
    });
    try {
      const admitted = await (
        await post(`/api/bots/${beta}/thread/messages`, { requestId: "beta", text: "Beta" })
      ).json();
      await vi.waitFor(() => expect(outputs).toContain(admitted.runId));
      expect((await get("/api/bots/personal/thread")).tasks[0].runs[0]).toMatchObject({
        id: waiting.runId,
        state: "active",
      });
    } finally {
      unsubscribe();
    }
  } finally {
    confirmStop.resolve();
  }
});

it("alternates interactive and background work so neither class waits behind the other", async () => {
  const gates = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  const external = new MailboxDriver();
  external.respond = async (input, _material, signal) => {
    if (input.content.startsWith("Hold")) {
      const gate = Promise.withResolvers<void>();
      gates.set(input.content, gate);
      await Promise.race([
        gate.promise,
        new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      ]);
    }
    return `Final: ${input.content}`;
  };
  await start(external, { activeExecutionLimit: 1 });
  const alpha = await createBot("Alpha");
  const carol = await createBot("Carol");
  const bravo = await createBot("Bravo");
  await post(`/api/bots/${alpha}/thread/messages`, { requestId: "hold-a", text: "Hold A" });
  await vi.waitFor(() => expect(gates.has("Hold A")).toBe(true));
  const carolRun = await (
    await post(`/api/bots/${carol}/thread/messages`, { requestId: "hold-c", text: "Hold C" })
  ).json();
  const bravoRun = await (
    await post(`/api/bots/${bravo}/thread/messages`, { requestId: "hold-b", text: "Hold B" })
  ).json();
  const db = new DatabaseSync(join(root, "data", "host.db"));
  db.exec("PRAGMA busy_timeout = 5000");
  db.prepare("UPDATE admission_queue SET admission_class = 'background' WHERE run_id = ?").run(
    bravoRun.runId,
  );
  db.close();
  gates.get("Hold A")?.resolve();
  await vi.waitFor(async () =>
    expect((await get(`/api/bots/${bravo}/thread`)).tasks[0].runs[0]).toMatchObject({
      id: bravoRun.runId,
      state: "active",
      admissionClass: "background",
    }),
  );
  expect((await get(`/api/bots/${carol}/thread`)).tasks[0].runs[0]).toMatchObject({
    id: carolRun.runId,
    state: "queued",
    admissionClass: "interactive",
  });
  const echo = await createBot("Echo");
  const echoRun = await (
    await post(`/api/bots/${echo}/thread/messages`, { requestId: "hold-e", text: "Hold E" })
  ).json();
  const paused = new DatabaseSync(join(root, "data", "host.db"));
  paused.exec("PRAGMA busy_timeout = 5000");
  paused
    .prepare("UPDATE admission_queue SET admission_class = 'background' WHERE run_id = ?")
    .run(echoRun.runId);
  paused.close();
  gates.get("Hold B")?.resolve();
  await vi.waitFor(async () =>
    expect((await get(`/api/bots/${carol}/thread`)).tasks[0].runs[0]).toMatchObject({
      id: carolRun.runId,
      state: "active",
    }),
  );
  expect((await get(`/api/bots/${echo}/thread`)).tasks[0].runs[0]).toMatchObject({
    id: echoRun.runId,
    state: "queued",
    admissionClass: "background",
  });
  for (const gate of gates.values()) gate.resolve();
});

it("releases a slot after complete tool results and keeps it while a tool result is missing", async () => {
  const recorded = Promise.withResolvers<void>();
  const external = new MailboxDriver();
  external.respond = async (input, material, signal) => {
    if (input.content === "Wait") {
      const mailbox = new RunnerMailbox(material.directory);
      mailbox.recordExecution({
        id: "call-1",
        kind: "tool-call",
        text: "read file",
        toolName: "read",
        toolCallId: "call-1",
        createdAt: "2026-10-19T00:00:00.000Z",
      });
      mailbox.requestDurableWait("owner question");
      await Promise.race([
        recorded.promise,
        new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      ]);
      if (signal.aborted) return "Final: Wait";
      mailbox.recordExecution({
        id: "result-1",
        kind: "tool-result",
        text: "file text",
        toolName: "read",
        toolCallId: "call-1",
        createdAt: "2026-10-19T00:00:01.000Z",
      });
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    return `Final: ${input.content}`;
  };
  await start(external, { activeExecutionLimit: 1 });
  const alpha = await createBot("Alpha");
  const waiting = await (
    await post(`/api/bots/${alpha}/thread/messages`, { requestId: "wait", text: "Wait" })
  ).json();
  await vi.waitFor(async () =>
    expect((await get(`/api/bots/${alpha}/thread`)).tasks[0].runs[0].state).toBe("active"),
  );
  const beta = await createBot("Beta");
  const next = await (
    await post(`/api/bots/${beta}/thread/messages`, { requestId: "beta", text: "Beta" })
  ).json();
  expect((await get(`/api/bots/${alpha}/thread`)).tasks[0].runs[0]).toMatchObject({
    id: waiting.runId,
    state: "active",
  });
  expect((await get(`/api/bots/${beta}/thread`)).tasks[0].runs[0]).toMatchObject({
    id: next.runId,
    state: "queued",
  });
  recorded.resolve();
  await vi.waitFor(async () =>
    expect((await get(`/api/bots/${alpha}/thread`)).tasks[0].runs[0]).toMatchObject({
      id: waiting.runId,
      state: "waiting",
      waitReason: "owner question",
      attempts: [expect.objectContaining({ endedAt: expect.any(String) })],
    }),
  );
  await vi.waitFor(async () =>
    expect((await get(`/api/bots/${beta}/thread`)).tasks[0].runs[0]).toMatchObject({
      id: next.runId,
      state: "succeeded",
    }),
  );
  expect((await get(`/api/bots/${alpha}/thread`)).admission).toMatchObject({
    activeLimit: 1,
    activeCount: 0,
  });
  const held = Promise.withResolvers<void>();
  external.respond = async (input, _material, signal) => {
    await Promise.race([
      held.promise,
      new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    ]);
    return `Final: ${input.content}`;
  };
  const resumedSibling = await (
    await post(`/api/bots/${beta}/thread/tasks`, { requestId: "beta-again", text: "Hold beta" })
  ).json();
  await vi.waitFor(async () =>
    expect((await get(`/api/bots/${beta}/thread`)).tasks[1].runs[0].state).toBe("active"),
  );
  const directory = external.launches.find((row) => row.material.key.sessionId === waiting.runId)
    ?.material.directory;
  if (!directory) throw new Error("Missing waiting Run mailbox");
  new RunnerMailbox(directory).resumeDurableWait();
  await vi.waitFor(async () =>
    expect((await get(`/api/bots/${alpha}/thread`)).tasks[0].runs[0]).toMatchObject({
      id: waiting.runId,
      state: "queued",
    }),
  );
  expect((await get(`/api/bots/${beta}/thread`)).tasks[1].runs[0]).toMatchObject({
    id: resumedSibling.runId,
    state: "active",
  });
  held.resolve();
});

it("adopts fenced execution on restart without admitting queued work twice", async () => {
  const external = new MailboxDriver();
  const live = new Map<string, Awaited<ReturnType<MailboxDriver["start"]>>>();
  external.respond = async (input, _material, signal) => {
    if (input.content === "Hold")
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    return `Final: ${input.content}`;
  };
  const driver: ObservingSessionDriver = {
    start: async (material, signal) => {
      const handle = await external.start(material, signal);
      live.set(material.key.sessionId, handle);
      return handle;
    },
    list: () => external.list(),
    adopt: (observation, material, signal) => {
      const handle = live.get(observation.key.sessionId);
      if (!handle) return external.adopt(observation, material, signal);
      return Promise.resolve(handle);
    },
  };
  const configuration = await start(driver, { activeExecutionLimit: 1 });
  const alpha = await createBot("Alpha");
  const held = await (
    await post(`/api/bots/${alpha}/thread/messages`, { requestId: "hold", text: "Hold" })
  ).json();
  await vi.waitFor(async () =>
    expect((await get(`/api/bots/${alpha}/thread`)).tasks[0].runs[0].state).toBe("active"),
  );
  const beta = await createBot("Beta");
  const queued = await (
    await post(`/api/bots/${beta}/thread/messages`, { requestId: "queued", text: "Queued" })
  ).json();
  expect((await get(`/api/bots/${beta}/thread`)).tasks[0].runs[0].state).toBe("queued");
  const launches = external.launches.length;
  const adopted: string[] = [];
  driver.adopt = async (observation) => {
    adopted.push(observation.key.sessionId);
    const done = Promise.withResolvers<void>();
    return {
      ref: observation.ref,
      wait: () => done.promise,
      stop: async () => {
        done.resolve();
      },
    };
  };
  await channel.close();
  await host.stop();
  external.observations = [
    {
      key: { agentGroupId: alpha, sessionId: held.runId },
      ref: live.get(held.runId)?.ref ?? "live",
    },
  ];
  host = await Host.start({ root, configuration, driver });
  await listen(configuration);
  await vi.waitFor(async () =>
    expect((await get(`/api/bots/${alpha}/thread`)).tasks[0].runs[0]).toMatchObject({
      id: held.runId,
      state: "active",
    }),
  );
  expect((await get(`/api/bots/${beta}/thread`)).tasks[0].runs[0]).toMatchObject({
    id: queued.runId,
    state: "queued",
    attempts: [],
  });
  expect(external.launches).toHaveLength(launches);
  expect(adopted).toContain(held.runId);
});

it("keeps the global slot while stop is unconfirmed", async () => {
  const external = new MailboxDriver();
  external.respond = async (input, _material, signal) => {
    if (input.content === "Hold")
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    return `Final: ${input.content}`;
  };
  let stops = 0;
  const driver: SessionDriver = {
    start: async (material, signal) => {
      const handle = await external.start(material, signal);
      return {
        wait: handle.wait,
        stop: async () => {
          stops += 1;
          if (stops === 1) throw new Error("Controlled stop failure");
          await handle.stop();
        },
      };
    },
  };
  await start(driver, { activeExecutionLimit: 1 });
  const alpha = await createBot("Alpha");
  const held = await (
    await post(`/api/bots/${alpha}/thread/messages`, { requestId: "hold", text: "Hold" })
  ).json();
  await vi.waitFor(async () =>
    expect((await get(`/api/bots/${alpha}/thread`)).tasks[0].runs[0].state).toBe("active"),
  );
  expect(
    (await post(`/api/bots/${alpha}/runs/${held.runId}/stop`, { requestId: "stop" })).status,
  ).toBe(202);
  await vi.waitFor(async () =>
    expect((await get(`/api/bots/${alpha}/thread`)).tasks[0].runs[0]).toMatchObject({
      state: "stopping",
      stopError: "Execution stop unconfirmed; Bot capacity retained",
    }),
  );
  const beta = await createBot("Beta");
  const queued = await (
    await post(`/api/bots/${beta}/thread/messages`, { requestId: "beta", text: "Beta" })
  ).json();
  expect((await get(`/api/bots/${beta}/thread`)).tasks[0].runs[0]).toMatchObject({
    id: queued.runId,
    state: "queued",
    attempts: [],
  });
  expect((await get(`/api/bots/${alpha}/thread`)).admission).toMatchObject({
    activeCount: 1,
    activeLimit: 1,
  });
});

it("releases the global slot when the driver fails to start", async () => {
  const external = new MailboxDriver();
  external.fail = true;
  await start(external, { activeExecutionLimit: 1 });
  const alpha = await createBot("Alpha");
  await post(`/api/bots/${alpha}/thread/messages`, { requestId: "alpha", text: "Alpha" });
  await vi.waitFor(async () =>
    expect((await get(`/api/bots/${alpha}/thread`)).admission.activeCount).toBe(0),
  );
  const beta = await createBot("Beta");
  await post(`/api/bots/${beta}/thread/messages`, { requestId: "beta", text: "Beta" });
  await vi.waitFor(async () =>
    expect(
      (await get(`/api/bots/${beta}/thread`)).tasks[0].runs[0].attempts.length,
    ).toBeGreaterThan(0),
  );
});

it("upgrades a reset-enabled store without losing selected originals or Run boundaries", async () => {
  const configuration = await start(new MailboxDriver());
  const path = "/api/bots/personal/thread";
  const earlier = await (
    await post(`${path}/messages`, { requestId: "earlier", text: "Earlier evidence" })
  ).json();
  await vi.waitFor(async () => expect((await get(path)).tasks[0].runs[0].state).toBe("succeeded"));
  const reset = await (await post(`${path}/reset`, { requestId: "reset" })).json();
  const selected = await (
    await post(`${path}/tasks`, {
      requestId: "selected",
      text: "Use earlier evidence",
      selectedMessageIds: [earlier.messageId],
    })
  ).json();
  await vi.waitFor(async () => expect((await get(path)).tasks[1].runs[0].state).toBe("succeeded"));
  await channel.close();
  await host.stop();

  // Recreate the reset-enabled schema before admission tables and durable waits existed.
  const prior = new DatabaseSync(join(root, "data", "host.db"));
  prior.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE delegations; DROP TABLE collaboration_grants;
    DROP TABLE timezone_updates; DROP TABLE bot_timezones; DROP TABLE routine_occurrences; DROP TABLE routines; DROP TABLE owner_questions; DROP TABLE delivered_artifacts;
    DROP TABLE agent_publications;
    DROP TABLE execution_reservations;
    DROP TABLE admission_service;
    DROP TABLE admission_queue;
    DROP TABLE admission_scheduler;
    ALTER TABLE runs DROP COLUMN wait_reason;
    DROP TABLE task_attachments;
    ALTER TABLE runs DROP COLUMN active_ms;
    ALTER TABLE runs DROP COLUMN active_since;
    ALTER TABLE runs DROP COLUMN budget_exhausted_at;
    PRAGMA user_version = 11;
  `);
  prior.close();

  host = await Host.start({ root, configuration, driver: new MailboxDriver() });
  await listen(configuration);
  const restored = await get(path);
  expect(restored.thread.backgroundBoundary).toBe(reset.backgroundBoundary);
  expect(restored.tasks[0].runs[0].backgroundBoundary).toBe(0);
  expect(restored.tasks[1].runs[0]).toMatchObject({
    id: selected.runId,
    backgroundBoundary: reset.backgroundBoundary,
    references: [expect.objectContaining({ id: earlier.messageId, text: "Earlier evidence" })],
  });
  const upgraded = new DatabaseSync(join(root, "data", "host.db"));
  try {
    expect(upgraded.prepare("PRAGMA user_version").get()?.user_version).toBe(20);
    expect(upgraded.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      upgraded.prepare("SELECT selected_message_ids FROM runs WHERE id = ?").get(selected.runId),
    ).toEqual({ selected_message_ids: JSON.stringify([earlier.messageId]) });
  } finally {
    upgraded.close();
  }
  expect(
    (await post(`${path}/tasks`, { requestId: "after-upgrade", text: "Continue working" })).status,
  ).toBe(202);
  await vi.waitFor(async () => expect((await get(path)).tasks[2].runs[0].state).toBe("succeeded"));
});
