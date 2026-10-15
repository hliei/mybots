import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerMailbox } from "@mybots/mailbox/node";
import { expect, test, vi } from "vitest";
import { runMailbox } from "../packages/agent-runner/src/poll-loop.ts";
import { PiProvider } from "../packages/agent-runner/src/providers/pi.ts";
import type { SessionDriver } from "../packages/host/src/drivers/types.ts";
import { Host, type HostConfiguration } from "../packages/host/src/host.ts";
import { waitForCheckpoint } from "./checkpoint.ts";
import { startPiService } from "./pi-fixture.ts";

test("owner reset waits for idle, preserves other sessions and shared files, and continues after restart", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mybots-host-reset-")));
  const held = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const service = await startPiService(async (request) => {
    const latest = JSON.stringify(
      request.messages.findLast((message) => message.role === "user")?.content,
    );
    if (latest.includes("Held private message")) {
      started.resolve();
      await held.promise;
    }
    return { text: "Reply" };
  });
  const driver: SessionDriver = {
    async start(material, signal) {
      const controller = new AbortController();
      const context = JSON.parse(await readFile(material.contextFile, "utf8"));
      const running = runMailbox({
        mailbox: new RunnerMailbox(material.directory),
        provider: new PiProvider({ modelRuntime: service.runtime, model: service.model }),
        cwd: material.workspace,
        sessionDir: join(material.directory, "pi"),
        instructions: context.instructions,
        resources: context.resources,
        signal: AbortSignal.any([signal, controller.signal]),
        pollMs: 5,
      });
      return {
        wait: () => running,
        stop: async () => {
          controller.abort();
          await running;
        },
      };
    },
  };
  const configuration: HostConfiguration = {
    owners: ["cli:local"],
    agent: {
      id: "personal",
      name: "Personal",
      folder: "personal",
      resources: { tools: ["read"] },
      model: {
        provider: "controlled",
        id: "controlled-model",
        baseUrl: "https://controlled.invalid",
        contextWindow: 32768,
        maxTokens: 4096,
      },
    },
    destinations: [
      { id: "terminal", channelType: "cli", platformId: "local", instance: "cli" },
      { id: "notes", channelType: "cli", platformId: "notes", instance: "cli" },
    ],
  };
  let host: Host | undefined;
  try {
    host = await Host.start({ root, configuration, driver });
    await mkdir(join(root, "groups", "personal"), { recursive: true });
    await writeFile(join(root, "groups", "personal", "shared.txt"), "amber orchard");
    const other = await host.accept({
      destinationId: "notes",
      userId: "cli:local",
      text: "Other private message",
    });
    await vi.waitFor(async () =>
      expect((await host?.inspect(other.sessionId))?.outputs).toHaveLength(1),
    );
    const otherContinuation = (await host.inspect(other.sessionId)).continuation;
    const first = await host.accept({
      destinationId: "terminal",
      userId: "cli:local",
      text: "Held private message",
    });
    await waitForCheckpoint(started.promise, "held model request");
    const old = (await host.inspect(first.sessionId)).continuation;
    await expect(
      host.accept({ destinationId: "terminal", userId: "cli:stranger", text: "/reset" }),
    ).rejects.toThrow("Owner");
    const reset = await host.accept({
      destinationId: "terminal",
      userId: "cli:local",
      text: "/reset",
    });
    const next = await host.accept({
      destinationId: "terminal",
      userId: "cli:local",
      text: "After reset",
    });
    expect(reset.sessionId).toBe(first.sessionId);
    expect((await host.inspect(first.sessionId)).continuation).toBe(old);
    held.resolve();
    await vi.waitFor(async () =>
      expect((await host?.inspect(first.sessionId))?.outputs).toHaveLength(3),
    );
    const state = await host.inspect(first.sessionId);
    expect(state.outputs.find((message) => message.in_reply_to === reset.messageId)?.content).toBe(
      "Conversation reset.",
    );
    expect(state.outputs.map((message) => message.in_reply_to)).toEqual([
      first.messageId,
      reset.messageId,
      next.messageId,
    ]);
    expect(state.continuation).not.toBe(old);
    expect(JSON.stringify(service.requests.at(-1)?.messages)).not.toContain("Held private message");
    expect(JSON.stringify(service.requests.at(-1)?.messages)).not.toContain(
      "Other private message",
    );
    expect((await host.inspect(other.sessionId)).continuation).toBe(otherContinuation);
    expect(await readFile(join(root, "groups", "personal", "shared.txt"), "utf8")).toBe(
      "amber orchard",
    );
    await host.stop();
    host = await Host.start({ root, configuration, driver });
    const resumed = await host.accept({
      destinationId: "terminal",
      userId: "cli:local",
      text: "Reopened",
    });
    await vi.waitFor(async () =>
      expect((await host?.inspect(first.sessionId))?.outputs).toHaveLength(4),
    );
    expect(resumed.sessionId).toBe(first.sessionId);
    expect((await host.inspect(first.sessionId)).continuation).toBe(state.continuation);
    expect(JSON.stringify(service.requests.at(-1)?.messages)).toContain("After reset");
    expect(JSON.stringify(service.requests.at(-1)?.messages)).not.toContain("Held private message");
  } finally {
    held.resolve();
    await host?.stop();
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test("model failure reaches host delivery once and stays terminal across host restart", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mybots-host-provider-failure-")));
  const service = await startPiService((request) => {
    const latest = JSON.stringify(
      request.messages.findLast((message) => message.role === "user")?.content,
    );
    return latest.includes("Fail this exchange")
      ? { status: 400 }
      : { text: "Recovered conversation" };
  });
  const driver: SessionDriver = {
    async start(material, signal) {
      const controller = new AbortController();
      const running = runMailbox({
        mailbox: new RunnerMailbox(material.directory),
        provider: new PiProvider({ modelRuntime: service.runtime, model: service.model }),
        cwd: material.workspace,
        sessionDir: join(material.directory, "pi"),
        signal: AbortSignal.any([signal, controller.signal]),
        pollMs: 5,
      });
      return {
        wait: () => running,
        stop: async () => {
          controller.abort();
          await running;
        },
      };
    },
  };
  const configuration: HostConfiguration = {
    owners: ["cli:local"],
    agent: {
      id: "personal",
      name: "Personal",
      folder: "personal",
      model: {
        provider: "controlled",
        id: "controlled-model",
        baseUrl: "https://controlled.invalid",
        contextWindow: 32768,
        maxTokens: 4096,
      },
    },
    destinations: [{ id: "terminal", channelType: "cli", platformId: "local", instance: "cli" }],
  };
  let host: Host | undefined;
  const replies: { content: string; kind: string }[] = [];
  function attach() {
    host?.attachChannel({
      channelType: "cli",
      instance: "cli",
      async deliver(message) {
        replies.push(message);
      },
    });
  }
  try {
    host = await Host.start({ root, configuration, driver });
    attach();
    const failed = await host.accept({
      destinationId: "terminal",
      userId: "cli:local",
      text: "Fail this exchange",
    });
    await vi.waitFor(() =>
      expect(replies).toMatchObject([{ kind: "error", content: "Agent model request failed." }]),
    );
    await vi.waitFor(async () =>
      expect((await host?.inspect(failed.sessionId))?.deliveries).toEqual([
        expect.objectContaining({ status: "delivered" }),
      ]),
    );
    const state = await host.inspect(failed.sessionId);
    expect(state.inputs).toEqual([
      expect.objectContaining({ id: failed.messageId, status: "failed" }),
    ]);
    expect(service.requests).toHaveLength(1);
    await host.stop();
    host = undefined;
    host = await Host.start({ root, configuration, driver });
    attach();
    const next = await host.accept({
      destinationId: "terminal",
      userId: "cli:local",
      text: "Continue normally",
    });
    expect(next.sessionId).toBe(failed.sessionId);
    await vi.waitFor(() =>
      expect(replies.map((reply) => reply.content)).toEqual([
        "Agent model request failed.",
        "Recovered conversation",
      ]),
    );
    expect(service.requests).toHaveLength(2);
    expect((await host.inspect(failed.sessionId)).inputs[0].status).toBe("failed");
  } finally {
    await host?.stop();
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
