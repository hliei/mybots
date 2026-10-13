import { watch } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { EventRuntime } from "../src/core/runtime.ts";
import { chatFixture } from "./chat-fixture.ts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, watch: vi.fn(actual.watch) };
});

let fixture: Awaited<ReturnType<typeof chatFixture>> | undefined;
let runtime: EventRuntime | undefined;
afterEach(async () => {
  await runtime?.stop({ graceMs: 0 });
  await fixture?.close();
});

it("splits paragraphs with hard fallback at Unicode code-point limits", async () => {
  fixture = await chatFixture();
  fixture.responses.push(answer("ab\n\ncde\n\n😀😀😀😀😀😀"));
  const sent: string[] = [];
  runtime = await EventRuntime.open({
    workspace: await fixture.workspace(),
    delivery: {
      transports: [
        {
          platform: "telegram",
          limit: 5,
          async send(chunk) {
            sent.push(chunk.content);
          },
        },
      ],
    },
  });
  const result = await runtime.submit({ source: "platform-telegram:1:2", content: "Long" });
  await runtime.stop();
  expect(sent).toEqual(["ab", "cde", "😀😀😀😀😀", "😀"]);
  expect(await runtime.getPendingReplies(result.session_id)).toEqual([]);
});

function answer(content: string) {
  return { status: 200, body: { choices: [{ message: { role: "assistant", content } }] } };
}

it("recovers older pending replies and saved progress before later replies on a fresh runtime", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  fixture.responses.push(answer("abc\n\ndef"), answer("ghi"));
  runtime = await EventRuntime.open({
    workspace,
    delivery: {
      transports: [
        {
          platform: "telegram",
          limit: 3,
          async send(chunk) {
            if (chunk.content === "def") throw new Error("Offline");
          },
        },
      ],
      random: () => 0.5,
      wait: async () => {},
    },
  });
  const first = await runtime.submit({ source: "platform-telegram:1:2", content: "First" });
  await runtime.submit({ source: "platform-telegram:1:2", content: "Second" });
  await runtime.stop();
  expect(await runtime.getPendingReplies(first.session_id)).toMatchObject([
    { confirmedChunks: 1, failure: { attempts: 5, error: "Offline" } },
    { confirmedChunks: 0 },
  ]);
  await rm(join(workspace, ".event", "pending"), { recursive: true });
  const recovered: string[] = [];
  runtime = await EventRuntime.open({
    workspace,
    delivery: {
      transports: [
        {
          platform: "telegram",
          limit: 3,
          async send(chunk) {
            recovered.push(chunk.content);
          },
        },
      ],
    },
  });
  await runtime.stop();
  expect(recovered).toEqual(["def", "ghi"]);
  expect(await runtime.getPendingReplies(first.session_id)).toEqual([]);
  expect(fixture.requests).toHaveLength(2);
});

it("retries only unconfirmed chunks five times, pausing delivery but allowing turns", async () => {
  fixture = await chatFixture();
  fixture.responses.push(answer("abc\n\ndef"), answer("later"));
  const sent: string[] = [];
  const waits: number[] = [];
  runtime = await EventRuntime.open({
    workspace: await fixture.workspace(),
    delivery: {
      transports: [
        {
          platform: "telegram",
          limit: 3,
          async send(chunk) {
            sent.push(chunk.content);
            if (chunk.content === "def") throw new Error("Offline");
          },
        },
      ],
      ...{
        random: () => 0.5,
        wait: async (ms: number) => {
          waits.push(ms);
        },
      },
    },
  });
  const first = await runtime.submit({ source: "platform-telegram:1:2", content: "First" });
  await runtime.submit({ source: "platform-telegram:1:2", content: "Follow-up" });
  await runtime.stop();
  expect(sent).toEqual(["abc", "def", "def", "def", "def", "def"]);
  expect(waits).toEqual([5000, 25000, 120000, 600000]);
  expect(await runtime.getPendingReplies(first.session_id)).toEqual([
    expect.objectContaining({ payload: "abc\n\ndef", confirmedChunks: 1 }),
    expect.objectContaining({ payload: "later", confirmedChunks: 0 }),
  ]);
});

it("delivers a committed reply to its destination and acknowledges after confirmation", async () => {
  fixture = await chatFixture();
  const sent: unknown[] = [];
  runtime = await EventRuntime.open({
    workspace: await fixture.workspace(),
    ...{
      delivery: {
        transports: [
          {
            platform: "telegram" as const,
            limit: 4096,
            async send(chunk: unknown) {
              sent.push(chunk);
            },
          },
        ],
      },
    },
  });
  const result = await runtime.submit({ source: "platform-telegram:1:2", content: "Hello" });
  await runtime.stop();
  expect(sent).toEqual([
    expect.objectContaining({
      content: "Hello!",
      destination: "platform-telegram:1:2",
      sessionId: result.session_id,
    }),
  ]);
  expect(await runtime.getPendingReplies(result.session_id)).toEqual([]);
});

it("keeps held delivery in order while another session and follow-up execution continue", async () => {
  fixture = await chatFixture();
  fixture.responses.push(answer("first"), answer("later"), answer("other"));
  const started = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const otherDelivered = Promise.withResolvers<void>();
  const sent: string[] = [];
  runtime = await EventRuntime.open({
    workspace: await fixture.workspace(),
    delivery: {
      transports: [
        {
          platform: "telegram",
          limit: 4096,
          async send(chunk) {
            if (chunk.content === "first") {
              started.resolve();
              await released.promise;
            }
            sent.push(chunk.content);
            if (chunk.content === "other") otherDelivered.resolve();
          },
        },
      ],
    },
  });
  try {
    const first = await runtime.submit({ source: "platform-telegram:1:2", content: "First" });
    await started.promise;
    expect(await runtime.getPendingReplies(first.session_id)).toHaveLength(1);
    await runtime.submit({ source: "platform-telegram:1:2", content: "Follow-up" });
    await runtime.submit({ source: "platform-telegram:3:4", content: "Other" });
    await otherDelivered.promise;
    expect(sent).toEqual(["other"]);
    expect(await runtime.getPendingReplies(first.session_id)).toHaveLength(2);
  } finally {
    released.resolve();
  }
  await runtime.stop();
  expect(sent).toEqual(["other", "first", "later"]);
});

it("cancels a retry wait, allowing the accepted-but-unrecorded duplicate window on recovery", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  const waiting = Promise.withResolvers<void>();
  let cancelled = false;
  const accepted: string[] = [];
  runtime = await EventRuntime.open({
    workspace,
    delivery: {
      transports: [
        {
          platform: "telegram",
          limit: 4096,
          async send(chunk) {
            accepted.push(chunk.content);
            throw new Error("Acceptance outcome unknown");
          },
        },
      ],
      wait: async (_ms, signal) => {
        waiting.resolve();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              cancelled = true;
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
    },
  });
  const first = await runtime.submit({ source: "platform-telegram:1:2", content: "First" });
  await waiting.promise;
  await runtime.stop({ graceMs: 0 });
  expect(cancelled).toBe(true);
  expect(await runtime.getPendingReplies(first.session_id)).toMatchObject([{ confirmedChunks: 0 }]);
  runtime = await EventRuntime.open({
    workspace,
    delivery: {
      transports: [
        {
          platform: "telegram",
          limit: 4096,
          async send(chunk) {
            accepted.push(chunk.content);
          },
        },
      ],
    },
  });
  await runtime.stop();
  expect(accepted).toEqual(["Hello!", "Hello!"]);
  expect(await runtime.getPendingReplies(first.session_id)).toEqual([]);
});

it("awaits transport cancellation cleanup and preserves confirmed chunks for restart", async () => {
  fixture = await chatFixture();
  fixture.responses.push(answer("abc\n\ndef"));
  const workspace = await fixture.workspace();
  const held = Promise.withResolvers<void>();
  const cleanup = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  runtime = await EventRuntime.open({
    workspace,
    delivery: {
      transports: [
        {
          platform: "telegram",
          limit: 3,
          async send(chunk, signal) {
            if (chunk.content === "abc") return;
            held.resolve();
            await new Promise<void>((_resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => {
                  cancelled.resolve();
                  void cleanup.promise.then(() => reject(signal.reason));
                },
                { once: true },
              );
            });
          },
        },
      ],
    },
  });
  const first = await runtime.submit({ source: "platform-telegram:1:2", content: "First" });
  await held.promise;
  let stopped = false;
  const stopping = runtime.stop({ graceMs: 0 }).then(() => {
    stopped = true;
  });
  await cancelled.promise;
  expect(stopped).toBe(false);
  cleanup.resolve();
  await stopping;
  expect(await runtime.getPendingReplies(first.session_id)).toMatchObject([{ confirmedChunks: 1 }]);
  const sent: string[] = [];
  runtime = await EventRuntime.open({
    workspace,
    delivery: {
      transports: [
        {
          platform: "telegram",
          limit: 3,
          async send(chunk) {
            sent.push(chunk.content);
          },
        },
      ],
    },
  });
  await runtime.stop();
  expect(sent).toEqual(["def"]);
});

it("suppresses stale acknowledged projections and never redirects old terminal replies", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  runtime = await EventRuntime.open({ workspace });
  const oldCli = await runtime.openSession();
  await runtime.submit({
    type: "InboundEvent",
    session_id: oldCli.session_id,
    source: "platform-cli:cli-user",
    content: "Old terminal",
    timestamp: 1,
    retry_count: 0,
  });
  const telegram = await runtime.submit({ source: "platform-telegram:1:2", content: "Delivered" });
  const [reply] = await runtime.getPendingReplies(telegram.session_id);
  const projection = join(
    workspace,
    ".event",
    "pending",
    telegram.session_id,
    `${reply.replyId}.json`,
  );
  const stale = await readFile(projection, "utf8");
  await runtime.acknowledgeReply(telegram.session_id, reply.replyId);
  await runtime.stop();
  await writeFile(projection, stale);
  const sent: string[] = [];
  runtime = await EventRuntime.open({
    workspace,
    delivery: {
      transports: [
        {
          platform: "telegram",
          limit: 4096,
          async send(chunk) {
            sent.push(chunk.content);
          },
        },
      ],
    },
  });
  const newCli = await runtime.openSession();
  await runtime.stop();
  expect(newCli.session_id).not.toBe(oldCli.session_id);
  expect(sent).toEqual([]);
  expect(await runtime.getPendingReplies(oldCli.session_id)).toHaveLength(1);
  expect(await runtime.getPendingReplies(telegram.session_id)).toEqual([]);
  await expect(readFile(projection, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

it("retains a missing destination and pauses only its session", async () => {
  fixture = await chatFixture();
  const sent: string[] = [];
  runtime = await EventRuntime.open({
    workspace: await fixture.workspace(),
    delivery: {
      transports: [
        {
          platform: "telegram",
          limit: 4096,
          async send(chunk) {
            sent.push(chunk.destination);
          },
        },
      ],
    },
  });
  const absent = await runtime.submit({ source: "platform-ws:absent", content: "First" });
  await runtime.submit({ source: "platform-ws:absent", content: "Later" });
  await runtime.submit({ source: "platform-telegram:1:2", content: "Other" });
  await runtime.stop();
  expect(sent).toEqual(["platform-telegram:1:2"]);
  expect(await runtime.getPendingReplies(absent.session_id)).toMatchObject([
    { failure: { attempts: 0, error: "Reply destination is unavailable." } },
    { confirmedChunks: 0 },
  ]);
  expect(runtime.deliveryFailures).toHaveLength(1);
});

it("uses appended chunk progress after a pending projection write fails", async () => {
  fixture = await chatFixture();
  fixture.responses.push(answer("abc\n\ndef"));
  const workspace = await fixture.workspace();
  const sent: string[] = [];
  let blocked = "";
  runtime = await EventRuntime.open({
    workspace,
    delivery: {
      transports: [
        {
          platform: "telegram",
          limit: 3,
          async send(chunk) {
            sent.push(chunk.content);
            if (chunk.content === "abc") {
              blocked = join(
                workspace,
                ".event",
                "pending",
                chunk.sessionId,
                `${chunk.replyId}.json`,
              );
              await rm(blocked);
              await mkdir(blocked);
            }
          },
        },
      ],
      wait: async () => {
        await rm(blocked, { recursive: true });
      },
    },
  });
  const result = await runtime.submit({ source: "platform-telegram:1:2", content: "First" });
  await runtime.stop();
  expect(sent).toEqual(["abc", "def"]);
  expect(await runtime.getPendingReplies(result.session_id)).toEqual([]);
  expect(runtime.deliveryFailures).toEqual([]);
});

it.each([
  { random: 0, waits: [4000, 20000, 96000, 480000] },
  { random: 0.9999999, waits: [6000, 30000, 144000, 720000] },
])("bounds retry jitter with random=$random", async ({ random, waits }) => {
  fixture = await chatFixture();
  const observed: number[] = [];
  runtime = await EventRuntime.open({
    workspace: await fixture.workspace(),
    delivery: {
      transports: [
        {
          platform: "telegram",
          limit: 4096,
          async send() {
            throw new Error("Offline");
          },
        },
      ],
      random: () => random,
      wait: async (ms) => {
        observed.push(ms);
      },
    },
  });
  await runtime.submit({ source: "platform-telegram:1:2", content: "First" });
  await runtime.stop();
  expect(observed).toEqual(waits);
  expect(runtime.deliveryFailures).toHaveLength(1);
});

it("does not start recovered sends when runtime resource initialization fails", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  runtime = await EventRuntime.open({ workspace });
  const result = await runtime.submit({ source: "platform-telegram:1:2", content: "Pending" });
  await runtime.stop();
  vi.mocked(watch).mockImplementationOnce(() => {
    throw new Error("Watcher unavailable");
  });
  const sent: string[] = [];
  await expect(
    EventRuntime.open({
      workspace,
      delivery: {
        transports: [
          {
            platform: "telegram",
            limit: 4096,
            async send(chunk) {
              sent.push(chunk.content);
            },
          },
        ],
      },
    }),
  ).rejects.toThrow("Watcher unavailable");
  runtime = await EventRuntime.open({ workspace });
  await runtime.getPendingReplies(result.session_id);
  expect(sent).toEqual([]);
});
