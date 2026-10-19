import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentResources, RunContext } from "@mybots/mailbox";
import { RunnerMailbox } from "@mybots/mailbox/node";
import { afterEach, expect, it, vi } from "vitest";
import { runMailbox } from "../packages/agent-runner/src/poll-loop.ts";
import { PiProvider } from "../packages/agent-runner/src/providers/pi.ts";
import { WebSocketChannel } from "../packages/host/src/channels/websocket.ts";
import { loadHostSettings } from "../packages/host/src/config/host.ts";
import type { SessionDriver } from "../packages/host/src/drivers/types.ts";
import { Host } from "../packages/host/src/host.ts";
import { waitForCheckpoint } from "./checkpoint.ts";
import { MailboxDriver } from "./host-fixture.ts";
import { startPiService } from "./pi-fixture.ts";

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

async function start(driver: SessionDriver = new MailboxDriver(), now?: () => number) {
  root = await mkdtemp(join(tmpdir(), "mybots-config-"));
  const { configuration } = await loadHostSettings("examples/host/host.json");
  configuration.approvedModels = [
    configuration.agent.model,
    { ...configuration.agent.model, id: "deepseek-reasoner" },
    { ...configuration.agent.model, id: "tiny-context", contextWindow: 256, maxTokens: 64 },
  ];
  host = await Host.start({ root, configuration, driver, ...(now ? { now } : {}) });
  await listen(configuration);
  return configuration;
}
async function listen(
  configuration: Awaited<ReturnType<typeof loadHostSettings>>["configuration"],
) {
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

const edit = {
  requestId: "edit-personal",
  instructions: "Cite every source.",
  model: { provider: "deepseek", id: "deepseek-reasoner" },
  tools: ["read"],
};

it("saves role, model and tools across restart without bootstrap overwrite", async () => {
  const configuration = await start();
  const saved = await post("/api/bots/personal/settings", edit);
  expect(saved.status).toBe(201);
  const body = await saved.json();
  expect(body).toMatchObject({
    requestId: edit.requestId,
    replayed: false,
    bot: {
      id: "personal",
      instructions: edit.instructions,
      model: edit.model,
      tools: ["read"],
      savedVersion: 2,
      effectiveVersion: 2,
      effective: { instructions: edit.instructions, model: edit.model, tools: ["read"] },
    },
  });
  const replay = await post("/api/bots/personal/settings", edit);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({ replayed: true, bot: { savedVersion: 2 } });
  expect(
    (await post("/api/bots/personal/settings", { ...edit, instructions: "Different" })).status,
  ).toBe(409);
  expect(
    (await post("/api/bots/personal/settings", { ...edit, requestId: "override", taskId: "t" }))
      .status,
  ).toBe(400);
  const before = await get("/api/bots");
  await channel.close();
  await host.stop();
  configuration.agent.instructions = "Installation seed must not win";
  configuration.agent.resources = { tools: ["bash"] };
  host = await Host.start({ root, configuration, driver: new MailboxDriver() });
  await listen(configuration);
  expect(await get("/api/bots")).toEqual(before);
  const sent = await (
    await post("/api/bots/personal/thread/messages", { requestId: "after-restart", text: "Hello" })
  ).json();
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("succeeded"),
  );
  expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].attempts).toMatchObject([
    { configurationVersion: 2, endedAt: expect.any(String) },
  ]);
  expect(sent.runId).toEqual(expect.any(String));
});

it("applies a finite cutoff without retargeting later input or extending the old Attempt", async () => {
  const driver = new MailboxDriver();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const seen: { content: string; instructions?: string; version?: number }[] = [];
  driver.respond = async (input, material, signal) => {
    const context = JSON.parse(await readFile(material.contextFile, "utf8")) as {
      instructions?: string;
      configurationVersion?: number;
    };
    seen.push({
      content: input.content,
      instructions: context.instructions,
      version: context.configurationVersion,
    });
    if (input.content === "Current") {
      entered.resolve();
      await Promise.race([
        release.promise,
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
      ]);
    }
    return `Final: ${input.content}`;
  };
  const configuration = await start(driver);
  const path = "/api/bots/personal/thread";
  const current = await (
    await post(`${path}/messages`, { requestId: "current", text: "Current" })
  ).json();
  await waitForCheckpoint(entered.promise, "current Attempt");
  const steering = await (
    await post(`${path}/messages`, { requestId: "steering", text: "Steering" })
  ).json();
  expect(steering).toMatchObject({ taskId: current.taskId, runId: current.runId });
  const firstSave = await post("/api/bots/personal/settings", edit);
  expect(firstSave.status).toBe(201);
  expect(await firstSave.json()).toMatchObject({
    bot: { savedVersion: 2, effectiveVersion: 1 },
  });
  const flood = await (
    await post(`${path}/messages`, { requestId: "flood", text: "Flood" })
  ).json();
  expect(flood).toMatchObject({ taskId: current.taskId, runId: current.runId });
  const second = await post("/api/bots/personal/settings", {
    requestId: "edit-again",
    instructions: "Final role.",
    model: edit.model,
    tools: ["read"],
  });
  expect(second.status).toBe(201);
  expect(await second.json()).toMatchObject({ bot: { savedVersion: 3, effectiveVersion: 1 } });
  expect(seen.map((item) => item.content)).toEqual(["Current"]);
  release.resolve();
  await vi.waitFor(async () => expect((await get(path)).tasks[0].runs[0].state).toBe("succeeded"));
  expect(seen.map((item) => item.content)).toEqual(["Current", "Steering", "Flood"]);
  expect(seen[0]).toMatchObject({ instructions: configuration.agent.instructions, version: 1 });
  expect(seen[1]).toMatchObject({ instructions: configuration.agent.instructions, version: 1 });
  expect(seen[2]).toMatchObject({ instructions: "Final role.", version: 3 });
  expect((await get(path)).tasks[0].runs[0].attempts).toMatchObject([
    { configurationVersion: 1, endedAt: expect.any(String) },
    { configurationVersion: 3, endedAt: expect.any(String) },
  ]);
  expect(
    (await get(path)).tasks[0].runs[0].inputs.map((input: { text: string }) => input.text),
  ).toEqual(["Current", "Steering", "Flood"]);
});

it("continues pre-save work after restart and applies the saved configuration to the same Run", async () => {
  const driver = new MailboxDriver();
  const entered = Promise.withResolvers<void>();
  driver.respond = async (input, _material, signal) => {
    if (input.content === "Current") {
      entered.resolve();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    }
    return `Final: ${input.content}`;
  };
  const configuration = await start(driver);
  const path = "/api/bots/personal/thread";
  const current = await (
    await post(`${path}/messages`, { requestId: "current", text: "Current" })
  ).json();
  await waitForCheckpoint(entered.promise, "held Attempt");
  expect((await post("/api/bots/personal/settings", edit)).status).toBe(201);
  const later = await (
    await post(`${path}/messages`, { requestId: "later", text: "Later" })
  ).json();
  expect(later).toMatchObject({ taskId: current.taskId, runId: current.runId });
  await channel.close();
  await host.stop();
  const recovered = new MailboxDriver();
  const seen: { content: string; instructions?: string }[] = [];
  recovered.respond = async (input, material) => {
    const context = JSON.parse(await readFile(material.contextFile, "utf8")) as {
      instructions?: string;
    };
    seen.push({ content: input.content, instructions: context.instructions });
    return `Final: ${input.content}`;
  };
  host = await Host.start({ root, configuration, driver: recovered });
  await listen(configuration);
  await vi.waitFor(async () => expect((await get(path)).tasks[0].runs[0].state).toBe("succeeded"), {
    timeout: 15000,
  });
  expect(seen.map((item) => item.content)).toEqual(["Current", "Later"]);
  expect(seen[0]?.instructions).toBe(configuration.agent.instructions);
  expect(seen[1]?.instructions).toBe(edit.instructions);
  expect((await get(path)).tasks).toHaveLength(1);
  expect((await get("/api/bots")).bots[0]).toMatchObject({
    savedVersion: 2,
    instructions: edit.instructions,
  });
}, 20000);

function sdkDriver(service: Awaited<ReturnType<typeof startPiService>>): SessionDriver {
  return {
    start: async (material, signal) => {
      const context = JSON.parse(await readFile(material.contextFile, "utf8")) as {
        instructions?: string;
        resources?: AgentResources;
        model: { contextWindow: number; maxTokens: number };
        runContext?: RunContext;
      };
      const model =
        context.model.contextWindow < 1000
          ? {
              ...service.model,
              contextWindow: context.model.contextWindow,
              maxTokens: context.model.maxTokens,
            }
          : service.model;
      const controller = new AbortController();
      const running = runMailbox({
        mailbox: new RunnerMailbox(material.directory),
        provider: new PiProvider({ modelRuntime: service.runtime, model }),
        cwd: material.workspace,
        sessionDir: join(material.directory, "pi"),
        instructions: context.instructions,
        resources: context.resources,
        runContext: context.runContext,
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
}

it("reopens the same Run with the saved instructions and tools", async () => {
  const release = Promise.withResolvers<void>();
  const service = await startPiService(async () => {
    await release.promise;
    return { text: "Recorded answer" };
  });
  try {
    const configuration = await start(sdkDriver(service));
    const path = "/api/bots/personal/thread";
    const first = await (
      await post(`${path}/messages`, { requestId: "ledger", text: "First ledger" })
    ).json();
    await service.waitForRequest(1);
    expect(JSON.stringify(service.requests[0])).toContain(configuration.agent.instructions);
    expect((await post("/api/bots/personal/settings", edit)).status).toBe(201);
    const follow = await (
      await post(`${path}/messages`, { requestId: "follow", text: "Follow under new settings" })
    ).json();
    expect(follow).toMatchObject({ taskId: first.taskId, runId: first.runId });
    release.resolve();
    await vi.waitFor(async () => expect(service.requests.length).toBeGreaterThanOrEqual(2));
    await vi.waitFor(async () =>
      expect((await get(path)).tasks[0].runs[0].state).toBe("succeeded"),
    );
    const reopened = JSON.stringify(service.requests[1]);
    expect(reopened).toContain("Cite every source.");
    expect(reopened).toContain("First ledger");
    const tools = service.requests[1]?.tools?.map((tool) => tool.function.name) ?? [];
    expect(tools).toContain("read");
    expect(tools).not.toContain("bash");
    expect((await get(path)).tasks[0].runs[0].attempts).toMatchObject([
      { configurationVersion: 1 },
      { configurationVersion: 2 },
    ]);
  } finally {
    release.resolve();
    await host?.stop();
    await service.close();
  }
});

it("fails an incompatible model continuation visibly and keeps the Run ledger", async () => {
  const release = Promise.withResolvers<void>();
  const service = await startPiService(async () => {
    await release.promise;
    return { text: "Recorded answer" };
  });
  try {
    await start(sdkDriver(service));
    const path = "/api/bots/personal/thread";
    const first = await (
      await post(`${path}/messages`, { requestId: "ledger", text: "First ledger" })
    ).json();
    await service.waitForRequest(1);
    expect(
      (
        await post("/api/bots/personal/settings", {
          requestId: "tiny",
          instructions: "Keep the ledger.",
          model: { provider: "deepseek", id: "tiny-context" },
          tools: ["read"],
        })
      ).status,
    ).toBe(201);
    const follow = await (
      await post(`${path}/messages`, { requestId: "follow", text: "Continue incompatible history" })
    ).json();
    expect(follow).toMatchObject({ taskId: first.taskId, runId: first.runId });
    release.resolve();
    await vi.waitFor(async () => expect((await get(path)).tasks[0].runs[0].state).toBe("failed"));
    const detail = await get(path);
    expect(detail.tasks[0].runs[0].outcome.reply).toContain(
      "Required Run input exceeds model capacity.",
    );
    expect(detail.messages.map((message: { content: string }) => message.content)).toContain(
      "First ledger",
    );
    const ledger = (await host.inspect(first.runId)).continuation?.slice(3) as string;
    expect(await readFile(ledger, "utf8")).toContain("First ledger");
    expect(await readdir(join(ledger, ".."))).toHaveLength(1);
  } finally {
    release.resolve();
    await host?.stop();
    await service.close();
  }
});
