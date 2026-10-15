import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { HostStore } from "../src/db/index.ts";
import { schema } from "../src/db/migrations/001-initial.ts";
import { resourceSchema } from "../src/db/migrations/002-agent-resources.ts";
import type { SessionDriver } from "../src/drivers/types.ts";
import { Host, type HostConfiguration, type HostEvent } from "../src/host.ts";
import { HostMailbox, RunnerMailbox } from "../src/mailbox/node.ts";
import { CLAIM_STALL_MS, HEARTBEAT_CEILING_MS } from "../src/reconcile-session.ts";
import { waitForCheckpoint } from "./checkpoint.ts";
import { MailboxDriver } from "./host-fixture.ts";

const configuration: HostConfiguration = {
  owners: ["cli:local"],
  agent: {
    id: "personal",
    name: "Personal",
    folder: "personal",
    model: {
      provider: "deepseek",
      id: "deepseek-chat",
      baseUrl: "https://api.deepseek.com",
      contextWindow: 128000,
      maxTokens: 4096,
    },
  },
  destinations: [{ id: "terminal", channelType: "cli", platformId: "local", instance: "cli" }],
};

const hosts: Host[] = [];
let root: string | undefined;
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop().catch(() => {});
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function temporaryRoot(): Promise<string> {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-host-recovery-")));
  return root;
}

function sessionDirectory(current: string, sessionId: string): string {
  return join(current, "data", "sessions", "personal", sessionId);
}

it("adopts a container the runtime still reports instead of starting another", async () => {
  const current = await temporaryRoot();
  const first = new MailboxDriver();
  const host = await Host.start({ root: current, configuration, driver: first });
  hosts.push(host);
  const accepted = await host.accept({
    destinationId: "terminal",
    userId: "cli:local",
    text: "Work",
  });
  await vi.waitFor(async () =>
    expect((await host.inspect(accepted.sessionId))?.outputs).toHaveLength(1),
  );
  await host.stop();
  hosts.pop();

  const observation = {
    key: { agentGroupId: "personal", sessionId: accepted.sessionId },
    ref: "orphaned-container",
  };
  const second = new MailboxDriver();
  second.observations = [observation];
  const recovered = await Host.start({
    root: current,
    configuration,
    driver: second,
    reconcileMs: Number.MAX_SAFE_INTEGER,
  });
  hosts.push(recovered);
  expect(second.adopted).toEqual([observation]);
  expect(second.launches).toHaveLength(0);
  expect(await recovered.inspect(accepted.sessionId)).toMatchObject({
    session: { container_status: "running" },
    claim: { container_ref: "orphaned-container" },
  });
});

it("recovers an abandoned claim through five bounded waits and fails it without redelivering completed input", async () => {
  const current = await temporaryRoot();
  const first = new MailboxDriver();
  const host = await Host.start({ root: current, configuration, driver: first });
  hosts.push(host);
  const completed = await host.accept({
    destinationId: "terminal",
    userId: "cli:local",
    text: "Completed",
  });
  await vi.waitFor(async () =>
    expect(await host?.inspect(completed.sessionId)).toMatchObject({
      inputs: [expect.objectContaining({ status: "completed" })],
      outputs: [expect.objectContaining({ content: "Reply: Completed" })],
    }),
  );
  await host.stop();
  hosts.pop();

  // A container claimed new work and died before finishing it.
  const directory = sessionDirectory(current, completed.sessionId);
  const mailbox = new HostMailbox(directory);
  const runner = new RunnerMailbox(directory);
  const crashed = mailbox.submit({
    id: "crashed",
    content: "Continue",
    channel_type: "cli",
    platform_id: "local",
    thread_id: null,
  });
  runner.acknowledge(crashed.id, "processing");

  let now = Date.parse("2026-02-01T00:00:00.000Z");
  const driver = new MailboxDriver();
  const events: HostEvent[] = [];
  const recovered = await Host.start({
    root: current,
    configuration,
    driver,
    now: () => now,
    reconcileMs: Number.MAX_SAFE_INTEGER,
  });
  hosts.push(recovered);
  recovered.observe((event) => events.push(event));

  const retry = async (waitMs: number, tries: number) => {
    now += waitMs;
    runner.acknowledge(crashed.id, "processing");
    await recovered.reconcile();
    expect(await recovered.inspect(completed.sessionId)).toMatchObject({
      inputs: [
        expect.objectContaining({ id: completed.messageId, status: "completed", tries: 0 }),
        expect.objectContaining({ id: crashed.id, status: "pending", tries }),
      ],
    });
  };
  expect(await recovered.inspect(completed.sessionId)).toMatchObject({
    inputs: [expect.anything(), expect.objectContaining({ id: crashed.id, tries: 1 })],
  });
  await retry(5000, 2);
  await retry(10000, 3);
  await retry(20000, 4);
  await retry(40000, 5);
  now += 80000;
  runner.acknowledge(crashed.id, "processing");
  await recovered.reconcile();
  expect(await recovered.inspect(completed.sessionId)).toMatchObject({
    inputs: [expect.anything(), expect.objectContaining({ id: crashed.id, status: "failed" })],
  });
  expect(events).toContainEqual(
    expect.objectContaining({ type: "failure", sessionId: completed.sessionId }),
  );
  // Completed input is never redelivered, and exhausted recovery never starts a container.
  expect(driver.launches).toHaveLength(0);
  expect(driver.stopped).toHaveLength(0);
});

it("replaces a container whose claim went silent and recovers its unfinished input", async () => {
  const current = await temporaryRoot();
  let now = Date.parse("2026-02-01T00:00:00.000Z");
  const driver = new MailboxDriver();
  const started = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  driver.respond = async (input, _material, signal) => {
    if (input.content === "Stuck") {
      started.resolve();
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            stopped.resolve();
            resolve();
          },
          { once: true },
        ),
      );
      return "";
    }
    return `Reply: ${input.content}`;
  };
  const host = await Host.start({
    root: current,
    configuration,
    driver,
    now: () => now,
    reconcileMs: Number.MAX_SAFE_INTEGER,
  });
  hosts.push(host);
  const events: HostEvent[] = [];
  host.observe((event) => events.push(event));
  const accepted = await host.accept({
    destinationId: "terminal",
    userId: "cli:local",
    text: "Stuck",
  });
  await waitForCheckpoint(started.promise, "silent claim");
  now = Date.now() + CLAIM_STALL_MS + 1;
  await host.reconcile();
  await waitForCheckpoint(stopped.promise, "container replacement");
  expect(driver.stopped).toContain(driver.launches[0].ref);
  expect(events).toContainEqual(
    expect.objectContaining({ type: "failure", sessionId: accepted.sessionId }),
  );
  expect(await host.inspect(accepted.sessionId)).toMatchObject({
    session: { container_status: "stopped" },
    inputs: [expect.objectContaining({ status: "pending", tries: 1 })],
  });
  expect(driver.launches).toHaveLength(1);
});

it("ignores a superseded container's late exit and keeps the newer incarnation running", async () => {
  const current = await temporaryRoot();
  let now = Date.parse("2026-02-01T00:00:00.000Z");
  const handles: { ref: string; stopped: boolean; resolve: () => void }[] = [];
  const driver: SessionDriver = {
    async start() {
      const done = Promise.withResolvers<void>();
      const entry = {
        ref: `container-${handles.length + 1}`,
        stopped: false,
        resolve: done.resolve,
      };
      handles.push(entry);
      return {
        ref: entry.ref,
        wait: () => done.promise,
        stop: async () => {
          entry.stopped = true;
        },
      };
    },
  };
  const host = await Host.start({
    root: current,
    configuration,
    driver,
    now: () => now,
    reconcileMs: Number.MAX_SAFE_INTEGER,
  });
  hosts.push(host);
  const accepted = await host.accept({
    destinationId: "terminal",
    userId: "cli:local",
    text: "Work",
  });
  await vi.waitFor(() => expect(handles).toHaveLength(1));
  now += HEARTBEAT_CEILING_MS + 1;
  await host.reconcile();
  await vi.waitFor(() => expect(handles).toHaveLength(2));
  expect((await host.inspect(accepted.sessionId))?.session?.container_status).toBe("running");
  handles[0].resolve();
  await setTimeout(20);
  expect(handles[0].stopped).toBe(true);
  expect((await host.inspect(accepted.sessionId))?.session?.container_status).toBe("running");
  handles[1].resolve();
});

it("adopts the data directory after an abnormal host exit", async () => {
  const current = await temporaryRoot();
  const lock = join(current, "data", "host.lock");
  await mkdir(lock, { recursive: true });
  await writeFile(
    join(lock, "owner.json"),
    `${JSON.stringify({ instanceId: "abandoned", pid: 999999999, startedAt: "t" })}\n`,
  );
  const host = await Host.start({
    root: current,
    configuration,
    driver: new MailboxDriver(),
    reconcileMs: Number.MAX_SAFE_INTEGER,
  });
  hosts.push(host);
  expect(host.sessions()).toEqual([]);
});

it.each([false, true])(
  "admits only one concurrent host when the lock is stale: %s",
  async (stale) => {
    const current = await temporaryRoot();
    if (stale) {
      const lock = join(current, "data", "host.lock");
      await mkdir(lock, { recursive: true });
      await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: 999999999 }));
    }
    const results = await Promise.allSettled(
      [1, 2].map(() => Host.start({ root: current, configuration, driver: new MailboxDriver() })),
    );
    for (const result of results) if (result.status === "fulfilled") hosts.push(result.value);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  },
);

it("preserves live claims when container termination fails", async () => {
  const current = await temporaryRoot();
  let now = Date.now();
  const done = Promise.withResolvers<void>();
  let launches = 0;
  let rejectStop = true;
  const driver: SessionDriver = {
    async start(material) {
      launches++;
      const runner = new RunnerMailbox(material.directory);
      runner.acknowledge(runner.pending()[0].id, "processing");
      return {
        ref: "still-running",
        wait: () => done.promise,
        async stop() {
          if (rejectStop) throw new Error("Controlled stop failure");
          done.resolve();
        },
      };
    },
  };
  const host = await Host.start({ root: current, configuration, driver, now: () => now });
  hosts.push(host);
  const accepted = await host.accept({
    destinationId: "terminal",
    userId: "cli:local",
    text: "Work",
  });
  await vi.waitFor(async () =>
    expect((await host.inspect(accepted.sessionId)).session?.container_status).toBe("running"),
  );
  now += HEARTBEAT_CEILING_MS + 1;
  try {
    await host.reconcile();
    await host.accept({ destinationId: "terminal", userId: "cli:local", text: "Later" });
    expect(launches).toBe(1);
    expect(
      new HostMailbox(sessionDirectory(current, accepted.sessionId)).processingClaims(),
    ).toHaveLength(1);
    expect((await host.inspect(accepted.sessionId)).inputs[0].tries).toBe(0);
  } finally {
    rejectStop = false;
  }
});

it("waits for replacement termination before admitting another container", async () => {
  const current = await temporaryRoot();
  let now = Date.now();
  const stopping = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const done = Promise.withResolvers<void>();
  let launches = 0;
  const driver: SessionDriver = {
    async start() {
      launches++;
      return {
        ref: `runner-${launches}`,
        wait: () => done.promise,
        async stop() {
          stopping.resolve();
          await release.promise;
          done.resolve();
        },
      };
    },
  };
  const host = await Host.start({ root: current, configuration, driver, now: () => now });
  hosts.push(host);
  await host.accept({ destinationId: "terminal", userId: "cli:local", text: "Work" });
  await vi.waitFor(() => expect(launches).toBe(1));
  now += HEARTBEAT_CEILING_MS + 1;
  const replacement = host.reconcile();
  try {
    await waitForCheckpoint(stopping.promise, "replacement stop");
    await host.accept({ destinationId: "terminal", userId: "cli:local", text: "Later" });
    expect(launches).toBe(1);
  } finally {
    release.resolve();
    await replacement;
  }
});

it.each(["list", "adopt"] as const)(
  "does not recover claims when runtime %s is uncertain",
  async (operation) => {
    const current = await temporaryRoot();
    const first = await Host.start({ root: current, configuration, driver: new MailboxDriver() });
    hosts.push(first);
    const accepted = await first.accept({
      destinationId: "terminal",
      userId: "cli:local",
      text: "Work",
    });
    await vi.waitFor(async () =>
      expect((await first.inspect(accepted.sessionId)).outputs).toHaveLength(1),
    );
    await first.stop();
    const directory = sessionDirectory(current, accepted.sessionId);
    const mailbox = new HostMailbox(directory);
    const input = mailbox.submit({
      id: "live",
      content: "Still working",
      channel_type: "cli",
      platform_id: "local",
      thread_id: null,
    });
    new RunnerMailbox(directory).acknowledge(input.id, "processing");
    const driver = new MailboxDriver();
    driver.observations = [
      { key: { agentGroupId: "personal", sessionId: accepted.sessionId }, ref: "live-container" },
    ];
    driver[operation] = async () => {
      throw new Error("Controlled observation failure");
    };
    let recovered: Host | undefined;
    try {
      await expect(
        Host.start({ root: current, configuration, driver }).then((host) => {
          recovered = host;
          hosts.push(host);
          return host;
        }),
      ).rejects.toThrow();
      expect(mailbox.processingClaims()).toHaveLength(1);
      expect(mailbox.inputs().find((message) => message.id === input.id)?.tries).toBe(0);
      expect(driver.launches).toHaveLength(0);
    } finally {
      await recovered?.stop();
    }
  },
);

it("upgrades an existing host store to the recovery schema", async () => {
  const current = await temporaryRoot();
  const file = join(current, "data", "host.db");
  await mkdir(join(current, "data"), { recursive: true });
  const previous = new DatabaseSync(file);
  previous.exec(schema);
  previous.exec(resourceSchema);
  previous.close();
  const store = new HostStore(file, configuration);
  store.close();
  const upgraded = new DatabaseSync(file);
  expect(
    (upgraded.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
  ).toBe(3);
  expect(
    upgraded
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('host_instances', 'session_claims') ORDER BY name",
      )
      .all(),
  ).toEqual([{ name: "host_instances" }, { name: "session_claims" }]);
  upgraded.close();
});

it("bounds repeated container crashes that happen before any claim", async () => {
  const current = await temporaryRoot();
  let now = Date.parse("2026-02-01T00:00:00.000Z");
  let launches = 0;
  const driver: SessionDriver = {
    async start() {
      launches += 1;
      return {
        ref: `crasher-${launches}`,
        stop: async () => {},
        wait: async () => {
          throw new Error("Controlled crash before claiming input");
        },
      };
    },
  };
  const host = await Host.start({
    root: current,
    configuration,
    driver,
    now: () => now,
    reconcileMs: Number.MAX_SAFE_INTEGER,
  });
  hosts.push(host);
  const accepted = await host.accept({
    destinationId: "terminal",
    userId: "cli:local",
    text: "Crash loop",
  });
  await vi.waitFor(() => expect(launches).toBe(1));
  for (const [index, wait] of [5000, 10000, 20000, 40000, 80000].entries()) {
    await vi.waitFor(async () =>
      expect((await host.inspect(accepted.sessionId))?.inputs[0].tries).toBe(index + 1),
    );
    now += wait;
    await host.reconcile();
    await vi.waitFor(() => expect(launches).toBe(index + 2));
  }
  await vi.waitFor(async () =>
    expect((await host.inspect(accepted.sessionId))?.inputs[0].status).toBe("failed"),
  );
  expect(launches).toBe(6);
  // Exhausted work is not restarted indefinitely, even after a long wait.
  now += 3600000;
  await host.reconcile();
  expect(launches).toBe(6);
});
