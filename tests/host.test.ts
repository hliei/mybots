import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutboundMessage } from "@mybots/mailbox";
import { afterEach, expect, it, vi } from "vitest";
import { Host, type HostConfiguration, type HostEvent } from "../packages/host/src/host.ts";
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
let root: string;
let host: Host | undefined;
afterEach(async () => {
  await host?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

it("another session writes shared materials and replies while execution and delivery are held", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-host-independent-")));
  const driver = new MailboxDriver();
  const heldExecution = Promise.withResolvers<void>();
  const heldDelivery = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const delivering = Promise.withResolvers<void>();
  driver.respond = async (input, material, signal) => {
    if (input.content === "Held execution") {
      started.resolve();
      const release = () => heldExecution.resolve();
      signal.addEventListener("abort", release, { once: true });
      try {
        await heldExecution.promise;
      } finally {
        signal.removeEventListener("abort", release);
      }
    } else if (input.content === "Independent") {
      await writeFile(join(material.workspace, "shared.txt"), "Independent work");
    }
    return `Reply: ${input.content}`;
  };
  host = await Host.start({
    root,
    driver,
    configuration: {
      ...configuration,
      destinations: [
        ...configuration.destinations,
        { id: "notes", channelType: "cli", platformId: "notes", instance: "cli" },
        { id: "other", channelType: "cli", platformId: "other", instance: "cli" },
      ],
    },
  });
  const received: OutboundMessage[] = [];
  host.attachChannel({
    channelType: "cli",
    instance: "cli",
    async deliver(message, signal) {
      if (message.content === "Reply: Held delivery") {
        delivering.resolve();
        const release = () => heldDelivery.resolve();
        signal.addEventListener("abort", release, { once: true });
        try {
          await heldDelivery.promise;
        } finally {
          signal.removeEventListener("abort", release);
        }
      }
      received.push(message);
    },
  });
  try {
    const held = await host.accept({
      destinationId: "terminal",
      userId: "cli:local",
      text: "Held execution",
    });
    await vi.waitFor(() => expect(driver.launches).toHaveLength(1));
    await waitForCheckpoint(started.promise, "held session execution");
    await host.accept({ destinationId: "notes", userId: "cli:local", text: "Held delivery" });
    await vi.waitFor(async () =>
      expect((await host?.inspect(host.sessions()[1].id))?.outputs).toHaveLength(1),
    );
    await waitForCheckpoint(delivering.promise, "held session delivery");
    const independent = await host.accept({
      destinationId: "other",
      userId: "cli:local",
      text: "Independent",
    });
    await vi.waitFor(() =>
      expect(received).toContainEqual(
        expect.objectContaining({
          content: "Reply: Independent",
          in_reply_to: independent.messageId,
          platform_id: "other",
        }),
      ),
    );
    expect((await host.inspect(held.sessionId)).outputs).toEqual([]);
    expect(await readFile(join(root, "groups", "personal", "shared.txt"), "utf8")).toBe(
      "Independent work",
    );
    expect(driver.launches.map((launch) => launch.material.workspace)).toEqual([
      join(root, "groups", "personal"),
      join(root, "groups", "personal"),
      join(root, "groups", "personal"),
    ]);
  } finally {
    heldExecution.resolve();
    heldDelivery.resolve();
  }
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
  const accepted = await host.accept({
    destinationId: "terminal",
    userId: "cli:local",
    text: "Blocked delivery",
  });
  await started.promise;
  await host.stop({ timeoutMs: 1000 });
  await cancelled.promise;
  await expect(
    host.accept({ destinationId: "terminal", userId: "cli:local", text: "After stop" }),
  ).rejects.toThrow("Host is stopped");
  host = await Host.start({ root, configuration, driver });
  expect(host.sessions()).toHaveLength(1);
  expect((await host.inspect(accepted.sessionId)).deliveries).toEqual([
    expect.objectContaining({ status: undefined }),
  ]);
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

it("materializes the selected Agent resources for every routed session after restart", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-host-resources-")));
  const driver = new MailboxDriver();
  const selected = {
    ...configuration,
    agent: {
      ...configuration.agent,
      resources: { skills: ["brief"], tools: ["read", "web_search"] as const },
      web: {
        search: {
          provider: "brave" as const,
          endpoint: "https://api.search.brave.test/res/v1/web/search",
        },
      },
    },
    destinations: [
      ...configuration.destinations,
      { id: "notes", channelType: "cli", platformId: "notes", instance: "cli" },
    ],
  };
  host = await Host.start({ root, configuration: selected, driver });
  const first = await host.accept({
    destinationId: "terminal",
    userId: "cli:local",
    text: "First",
  });
  await vi.waitFor(async () =>
    expect((await host?.inspect(first.sessionId))?.outputs).toHaveLength(1),
  );
  await host.stop();
  host = await Host.start({ root, configuration: selected, driver });
  const second = await host.accept({ destinationId: "notes", userId: "cli:local", text: "Second" });
  await vi.waitFor(async () =>
    expect((await host?.inspect(second.sessionId))?.outputs).toHaveLength(1),
  );
  for (const launch of driver.launches) {
    const context = JSON.parse(await readFile(launch.material.contextFile, "utf8"));
    expect(context.resources).toEqual({ skills: ["brief"], tools: ["read", "web_search"] });
    expect(context.web).toEqual({
      search: { provider: "brave", endpoint: "https://api.search.brave.test/res/v1/web/search" },
    });
    expect(JSON.stringify(context)).not.toContain("api_key");
    expect(context).not.toHaveProperty("owner");
    expect(context).not.toHaveProperty("gateway");
  }
});
