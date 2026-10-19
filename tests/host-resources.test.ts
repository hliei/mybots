import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerMailbox } from "@mybots/mailbox/node";
import { expect, test, vi } from "vitest";
import { runMailbox } from "../packages/agent-runner/src/poll-loop.ts";
import { PiProvider } from "../packages/agent-runner/src/providers/pi.ts";
import type { SessionDriver } from "../packages/host/src/drivers/types.ts";
import { Host, type HostConfiguration } from "../packages/host/src/host.ts";
import { startPiService } from "./pi-fixture.ts";

test("legacy SDK reset is retired rather than rewriting a live Run", async () => {
  const root = await mkdtemp(join(tmpdir(), "mybots-reset-retired-"));
  const service = await startPiService(() => ({ text: "Reply" }));
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
  const { piRunDriver } = await import("./pi-run-driver.ts");
  const host = await Host.start({
    root,
    configuration,
    driver: piRunDriver(new PiProvider({ modelRuntime: service.runtime, model: service.model })),
  });
  try {
    await expect(
      host.accept({ destinationId: "terminal", userId: "cli:local", text: "/reset" }),
    ).rejects.toThrow("background reset is not available");
    await expect(
      host.accept({ destinationId: "terminal", userId: "cli:stranger", text: "/reset" }),
    ).rejects.toThrow("Owner");
    expect(host.sessions()).toEqual([]);
  } finally {
    await host.stop();
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

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
        runContext: JSON.parse(await readFile(material.contextFile, "utf8")).runContext,
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
    expect(next.sessionId).not.toBe(failed.sessionId);
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
