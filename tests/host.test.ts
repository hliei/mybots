import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Host, type HostConfiguration, type HostEvent } from "../src/host.ts";
import type { OutboundMessage } from "../src/mailbox/types.ts";
import { MailboxDriver } from "./host-fixture.ts";

const configuration: HostConfiguration = {
  owner: "cli:local",
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
let root: string;
let host: Host | undefined;
afterEach(async () => {
  await host?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

it("delivers persisted mailbox replies and explicitly continues the saved runner conversation after host restart", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-host-")));
  const driver = new MailboxDriver();
  const received: OutboundMessage[] = [];
  host = await Host.start({ root, configuration, driver });
  host.attachChannel({
    channelType: "cli",
    instance: "cli",
    async deliver(message) {
      received.push(message);
    },
  });
  const first = await host.accept({
    destinationId: "terminal",
    userId: "cli:local",
    text: "Remember Alice",
  });
  await vi.waitFor(() =>
    expect(received).toEqual([
      expect.objectContaining({
        content: "Reply: Remember Alice",
        in_reply_to: first.messageId,
        channel_type: "cli",
        platform_id: "local",
        thread_id: null,
      }),
    ]),
  );
  const material = driver.launches[0].material;
  expect(material.directory).toBe(join(root, "data", "sessions", "personal", first.sessionId));
  expect(material.workspace).toBe(join(root, "groups", "personal"));
  await host.stop();
  host = await Host.start({ root, configuration, driver });
  host.attachChannel({
    channelType: "cli",
    instance: "cli",
    async deliver(message) {
      received.push(message);
    },
  });
  const second = await host.accept({
    destinationId: "terminal",
    userId: "cli:local",
    text: "Continue",
  });
  expect(second.sessionId).toBe(first.sessionId);
  await vi.waitFor(() => expect(received).toHaveLength(2));
  expect(received[1]).toMatchObject({ content: "Reply: Continue", in_reply_to: second.messageId });
  expect(driver.launches[1].continuation).toBe(
    `pi:${join(material.directory, "pi", "sessions", "fixture.jsonl")}`,
  );
});

it("saves one conversation for simultaneous first inputs and restores its destination affinity", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-host-")));
  const options = {
    root,
    configuration,
    driver: {
      async start() {
        throw new Error("Driver held offline");
      },
    },
  };
  host = await Host.start(options);
  const [first, second] = await Promise.all([
    host.accept({ destinationId: "terminal", userId: "cli:local", text: "Remember Alice" }),
    host.accept({ destinationId: "terminal", userId: "cli:local", text: "Hello" }),
  ]);
  expect(second.sessionId).toBe(first.sessionId);
  expect(host.sessions()).toEqual([
    expect.objectContaining({
      id: first.sessionId,
      agent_group_id: "personal",
      messaging_group_id: "terminal",
    }),
  ]);
  await host.stop();
  host = await Host.start(options);
  const third = await host.accept({
    destinationId: "terminal",
    userId: "cli:local",
    text: "Continue",
  });
  expect(third.sessionId).toBe(first.sessionId);
  expect(host.sessions()).toHaveLength(1);
});

it("rejects a second host before it can own the same persisted state", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-host-")));
  const options = { root, configuration, driver: new MailboxDriver() };
  host = await Host.start(options);
  let second: Host | undefined;
  try {
    await expect(
      (async () => {
        second = await Host.start(options);
      })(),
    ).rejects.toThrow("Host state is already owned");
  } finally {
    await second?.stop();
  }
});

it("keeps configured destinations in separate conversations with one shared Agent workspace and denies unknown owners", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-host-")));
  const driver = new MailboxDriver();
  host = await Host.start({
    root,
    driver,
    configuration: {
      ...configuration,
      destinations: [
        ...configuration.destinations,
        { id: "notes", channelType: "cli", platformId: "notes", instance: "cli" },
      ],
    },
  });
  const received: OutboundMessage[] = [];
  host.attachChannel({
    channelType: "cli",
    instance: "cli",
    async deliver(message) {
      received.push(message);
    },
  });
  await expect(
    host.accept({ destinationId: "terminal", userId: "cli:unknown", text: "Unauthorized" }),
  ).rejects.toThrow("Owner identity required");
  expect(host.sessions()).toHaveLength(0);
  const a = await host.accept({ destinationId: "terminal", userId: "cli:local", text: "First" });
  const b = await host.accept({ destinationId: "notes", userId: "cli:local", text: "Second" });
  expect(a.sessionId).not.toBe(b.sessionId);
  await vi.waitFor(() => expect(received).toHaveLength(2));
  expect(received).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ platform_id: "local", in_reply_to: a.messageId }),
      expect.objectContaining({ platform_id: "notes", in_reply_to: b.messageId }),
    ]),
  );
  expect(driver.launches.map((launch) => launch.material.workspace)).toEqual([
    join(root, "groups", "personal"),
    join(root, "groups", "personal"),
  ]);
  expect(driver.launches[0].material.directory).not.toBe(driver.launches[1].material.directory);
});

it("exposes driver configuration failure without losing accepted input or leaking diagnostics", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-host-")));
  const driver = new MailboxDriver();
  driver.fail = true;
  host = await Host.start({ root, configuration, driver });
  const events: HostEvent[] = [];
  host.observe((event) => {
    events.push(event);
  });
  const accepted = await host.accept({
    destinationId: "terminal",
    userId: "cli:local",
    text: "Persist before waking",
  });
  await vi.waitFor(() =>
    expect(events).toContainEqual(
      expect.objectContaining({ type: "failure", sessionId: accepted.sessionId }),
    ),
  );
  expect(events[0]).toMatchObject({ type: "input", messageId: accepted.messageId });
  expect(await host.inspect(accepted.sessionId)).toMatchObject({
    session: { container_status: "failed" },
    inputs: [
      expect.objectContaining({
        id: accepted.messageId,
        content: "Persist before waking",
        status: "pending",
      }),
    ],
    outputs: [],
  });
});

it("cancels blocked channel delivery and stops owned session resources within a bounded shutdown", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-host-")));
  const driver = new MailboxDriver();
  host = await Host.start({ root, configuration, driver });
  const started = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  host.attachChannel({
    channelType: "cli",
    instance: "cli",
    async deliver(_message, signal) {
      started.resolve();
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            cancelled.resolve();
            resolve();
          },
          { once: true },
        );
      });
    },
  });
  await host.accept({ destinationId: "terminal", userId: "cli:local", text: "Blocked delivery" });
  await started.promise;
  await host.stop({ timeoutMs: 1000 });
  await cancelled.promise;
  await expect(
    host.accept({ destinationId: "terminal", userId: "cli:local", text: "After stop" }),
  ).rejects.toThrow("Host is stopped");
  host = await Host.start({ root, configuration, driver });
  expect(host.sessions()).toHaveLength(1);
});

it("reports bounded shutdown failure for a driver that ignores cancellation", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-host-")));
  const started = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  host = await Host.start({
    root,
    configuration,
    driver: {
      async start() {
        started.resolve();
        return { wait: () => released.promise, stop: () => released.promise };
      },
    },
  });
  await host.accept({ destinationId: "terminal", userId: "cli:local", text: "Held driver" });
  await started.promise;
  await expect(host.stop({ timeoutMs: 30 })).rejects.toThrow("Host shutdown timed out");
  released.resolve();
  host = undefined;
});

it("discovers persisted output after a fresh host opens and keeps delivery separate from completion", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-host-")));
  const driver = new MailboxDriver();
  host = await Host.start({ root, configuration, driver });
  const accepted = await host.accept({
    destinationId: "terminal",
    userId: "cli:local",
    text: "Offline terminal",
  });
  await vi.waitFor(async () =>
    expect(await host?.inspect(accepted.sessionId)).toMatchObject({
      inputs: [expect.objectContaining({ status: "completed" })],
      outputs: [expect.objectContaining({ content: "Reply: Offline terminal" })],
      deliveries: [expect.objectContaining({ status: undefined })],
    }),
  );
  await host.stop();
  host = await Host.start({ root, configuration, driver });
  const received: OutboundMessage[] = [];
  host.attachChannel({
    channelType: "cli",
    instance: "cli",
    async deliver(message) {
      received.push(message);
    },
  });
  await vi.waitFor(() =>
    expect(received).toEqual([
      expect.objectContaining({
        content: "Reply: Offline terminal",
        in_reply_to: accepted.messageId,
      }),
    ]),
  );
  expect((await host.inspect(accepted.sessionId)).deliveries).toEqual([
    expect.objectContaining({ status: "delivered" }),
  ]);
  expect(driver.launches).toHaveLength(1);
});
