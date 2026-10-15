import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { HostStore } from "../src/db/index.ts";
import { Host, type HostConfiguration } from "../src/host.ts";
import type { OutboundMessage } from "../src/mailbox/types.ts";
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

/** Read or seed the host-coordination store outside the running host instance. */
function withStore<T>(run: (store: HostStore) => T): T {
  const store = new HostStore(join(root, "data", "host.db"), configuration);
  try {
    return run(store);
  } finally {
    store.close();
  }
}

function heldUntilAbort(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** Run one reply through a host whose channel never settles, leaving output undelivered. */
async function produceUndelivered(
  driver: MailboxDriver,
): Promise<{ sessionId: string; output: OutboundMessage }> {
  let blocked: OutboundMessage | undefined;
  host = await Host.start({ root, configuration, driver });
  host.attachChannel({
    channelType: "cli",
    instance: "cli",
    async deliver(message, signal) {
      blocked = message;
      await heldUntilAbort(signal);
      throw new Error("Delivery cancelled");
    },
  });
  const accepted = await host.accept({
    destinationId: "terminal",
    userId: "cli:local",
    text: "Hello",
  });
  await vi.waitFor(() => expect(blocked).toBeDefined());
  await host.stop();
  return { sessionId: accepted.sessionId, output: blocked as OutboundMessage };
}

function seedAttempts(output: OutboundMessage, sessionId: string, count: number): void {
  withStore((store) => {
    for (let attempt = 0; attempt < count; attempt++) {
      store.recordDeliveryAttempt({
        messageId: output.id,
        sessionId,
        at: new Date().toISOString(),
        nextAttemptAt: null,
        error: "Failure from a previous host instance",
      });
    }
  });
}

it("delivers a persisted outbound reply once and records terminal acknowledgement", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-delivery-")));
  const driver = new MailboxDriver();
  host = await Host.start({ root, configuration, driver });
  const received: OutboundMessage[] = [];
  host.attachChannel({
    channelType: "cli",
    instance: "cli",
    async deliver(message) {
      received.push(message);
    },
  });
  const accepted = await host.accept({
    destinationId: "terminal",
    userId: "cli:local",
    text: "Hello",
  });
  await vi.waitFor(() => expect(received).toHaveLength(1));
  expect((await host.inspect(accepted.sessionId)).deliveries).toEqual([
    expect.objectContaining({ id: received[0].id, status: "delivered" }),
  ]);
  expect(withStore((store) => store.deliveryAttempt(received[0].id))).toBeUndefined();
});

it("retries a failed platform send a finite number of times and records terminal failure", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-delivery-")));
  const driver = new MailboxDriver();
  host = await Host.start({ root, configuration, driver });
  const sent: OutboundMessage[] = [];
  host.attachChannel({
    channelType: "cli",
    instance: "cli",
    async deliver(message) {
      sent.push(message);
      throw new Error("Platform rejected the send");
    },
  });
  const accepted = await host.accept({
    destinationId: "terminal",
    userId: "cli:local",
    text: "Hello",
  });
  await vi.waitFor(async () =>
    expect((await host?.inspect(accepted.sessionId))?.deliveries).toEqual([
      expect.objectContaining({ status: "failed" }),
    ]),
  );
  expect(sent).toHaveLength(3);
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(sent).toHaveLength(3);
  const output = sent[0];
  await host.stop();
  host = undefined;
  expect(withStore((store) => store.deliveryAttempt(output.id))).toBeUndefined();
});

it("restores prior failure attempts in a fresh host and delivers without another model run", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-delivery-")));
  const driver = new MailboxDriver();
  const { sessionId, output } = await produceUndelivered(driver);
  seedAttempts(output, sessionId, 2);
  host = await Host.start({ root, configuration, driver });
  const received: OutboundMessage[] = [];
  host.attachChannel({
    channelType: "cli",
    instance: "cli",
    async deliver(message) {
      received.push(message);
    },
  });
  await vi.waitFor(() => expect(received).toHaveLength(1));
  expect(received[0].id).toBe(output.id);
  expect(driver.launches).toHaveLength(1);
  expect((await host.inspect(sessionId)).deliveries).toEqual([
    expect.objectContaining({ id: output.id, status: "delivered" }),
  ]);
  expect(withStore((store) => store.deliveryAttempt(output.id))).toBeUndefined();
});

it("exhausts a retried message across host restarts and never sends a terminal failure again", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-delivery-")));
  const driver = new MailboxDriver();
  const { sessionId, output } = await produceUndelivered(driver);
  seedAttempts(output, sessionId, 2);
  host = await Host.start({ root, configuration, driver });
  const failed = vi.fn(async () => {
    throw new Error("Still failing");
  });
  host.attachChannel({ channelType: "cli", instance: "cli", deliver: failed });
  await vi.waitFor(async () =>
    expect((await host?.inspect(sessionId))?.deliveries).toEqual([
      expect.objectContaining({ id: output.id, status: "failed" }),
    ]),
  );
  expect(failed).toHaveBeenCalledTimes(1);
  await host.stop();
  host = await Host.start({ root, configuration, driver });
  const resent = vi.fn(async () => undefined);
  host.attachChannel({ channelType: "cli", instance: "cli", deliver: resent });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(resent).not.toHaveBeenCalled();
  expect((await host.inspect(sessionId)).deliveries).toEqual([
    expect.objectContaining({ id: output.id, status: "failed" }),
  ]);
});

it("treats an already exhausted attempt count as terminal without another send", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-delivery-")));
  const driver = new MailboxDriver();
  const { sessionId, output } = await produceUndelivered(driver);
  seedAttempts(output, sessionId, 3);
  host = await Host.start({ root, configuration, driver });
  const delivered = vi.fn(async () => undefined);
  host.attachChannel({ channelType: "cli", instance: "cli", deliver: delivered });
  await vi.waitFor(async () =>
    expect((await host?.inspect(sessionId))?.deliveries).toEqual([
      expect.objectContaining({ id: output.id, status: "failed" }),
    ]),
  );
  expect(delivered).not.toHaveBeenCalled();
  expect(withStore((store) => store.deliveryAttempt(output.id))).toBeUndefined();
});

it("duplicates a platform-accepted message when the host stops before acknowledgement", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-delivery-")));
  const driver = new MailboxDriver();
  const platform: string[] = [];
  let calls = 0;
  host = await Host.start({ root, configuration, driver });
  host.attachChannel({
    channelType: "cli",
    instance: "cli",
    async deliver(message, signal) {
      calls++;
      if (calls === 1) {
        platform.push(message.content);
        throw new Error("Platform accepted the message but acknowledgement was lost");
      }
      await heldUntilAbort(signal);
      throw new Error("Delivery cancelled");
    },
  });
  const accepted = await host.accept({
    destinationId: "terminal",
    userId: "cli:local",
    text: "Hello",
  });
  await vi.waitFor(() => expect(calls).toBe(2));
  const output = (await host.inspect(accepted.sessionId)).outputs[0];
  expect(withStore((store) => store.deliveryAttempt(output.id)?.attempts)).toBe(1);
  await host.stop();
  host = await Host.start({ root, configuration, driver });
  host.attachChannel({
    channelType: "cli",
    instance: "cli",
    async deliver(message) {
      platform.push(message.content);
    },
  });
  await vi.waitFor(() => expect(platform).toHaveLength(2));
  expect(platform).toEqual(["Reply: Hello", "Reply: Hello"]);
  expect((await host.inspect(accepted.sessionId)).deliveries).toEqual([
    expect.objectContaining({ id: output.id, status: "delivered" }),
  ]);
});

it("keeps delivering later replies while an earlier reply in the same session keeps failing", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-delivery-")));
  const driver = new MailboxDriver();
  host = await Host.start({ root, configuration, driver });
  const delivered: string[] = [];
  host.attachChannel({
    channelType: "cli",
    instance: "cli",
    async deliver(message) {
      if (message.content === "Reply: First") throw new Error("Poison message");
      delivered.push(message.content);
    },
  });
  const accepted = await host.accept({
    destinationId: "terminal",
    userId: "cli:local",
    text: "First",
  });
  await host.accept({ destinationId: "terminal", userId: "cli:local", text: "Second" });
  await vi.waitFor(() => expect(delivered).toEqual(["Reply: Second"]));
  await vi.waitFor(async () =>
    expect(
      (await host?.inspect(accepted.sessionId))?.deliveries.map((delivery) => delivery.status),
    ).toEqual(["failed", "delivered"]),
  );
  expect(driver.launches).toHaveLength(1);
});

it("does not let a failed destination hold back an independent session", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-delivery-")));
  const driver = new MailboxDriver();
  host = await Host.start({
    root,
    driver,
    configuration: {
      ...configuration,
      destinations: [
        ...configuration.destinations,
        { id: "notes", channelType: "cli", platformId: "notes", instance: "notes" },
      ],
    },
  });
  host.attachChannel({
    channelType: "cli",
    instance: "cli",
    async deliver() {
      throw new Error("Destination unavailable");
    },
  });
  const received: OutboundMessage[] = [];
  host.attachChannel({
    channelType: "cli",
    instance: "notes",
    async deliver(message) {
      received.push(message);
    },
  });
  const broken = await host.accept({
    destinationId: "terminal",
    userId: "cli:local",
    text: "Broken",
  });
  const working = await host.accept({
    destinationId: "notes",
    userId: "cli:local",
    text: "Working",
  });
  await vi.waitFor(() => expect(received).toHaveLength(1));
  expect(received[0].content).toBe("Reply: Working");
  await vi.waitFor(async () =>
    expect((await host?.inspect(broken.sessionId))?.deliveries).toEqual([
      expect.objectContaining({ status: "failed" }),
    ]),
  );
  expect((await host.inspect(working.sessionId)).deliveries).toEqual([
    expect.objectContaining({ status: "delivered" }),
  ]);
});

it("does not replay a destination whose delivery was accepted with no connected client", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-delivery-")));
  const driver = new MailboxDriver();
  host = await Host.start({ root, configuration, driver });
  host.attachChannel({
    channelType: "cli",
    instance: "cli",
    async deliver() {
      // A disconnected owner-local client: the channel accepts without sending.
    },
  });
  const accepted = await host.accept({
    destinationId: "terminal",
    userId: "cli:local",
    text: "Offline",
  });
  await vi.waitFor(async () =>
    expect((await host?.inspect(accepted.sessionId))?.deliveries).toEqual([
      expect.objectContaining({ status: "delivered" }),
    ]),
  );
  await host.stop();
  host = await Host.start({ root, configuration, driver });
  const replayed = vi.fn(async () => undefined);
  host.attachChannel({ channelType: "cli", instance: "cli", deliver: replayed });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(replayed).not.toHaveBeenCalled();
});

it("keeps a pending output eligible after restart when its destination has no channel", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-delivery-")));
  const driver = new MailboxDriver();
  host = await Host.start({ root, configuration, driver });
  const accepted = await host.accept({
    destinationId: "terminal",
    userId: "cli:local",
    text: "Hello",
  });
  await vi.waitFor(async () =>
    expect((await host?.inspect(accepted.sessionId))?.outputs).toHaveLength(1),
  );
  await host.stop();
  host = await Host.start({ root, configuration, driver });
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect((await host.inspect(accepted.sessionId)).deliveries).toEqual([
    expect.objectContaining({ status: undefined }),
  ]);
  const received: OutboundMessage[] = [];
  host.attachChannel({
    channelType: "cli",
    instance: "cli",
    async deliver(message) {
      received.push(message);
    },
  });
  await vi.waitFor(() => expect(received).toHaveLength(1));
  expect((await host.inspect(accepted.sessionId)).deliveries).toEqual([
    expect.objectContaining({ status: "delivered" }),
  ]);
});
