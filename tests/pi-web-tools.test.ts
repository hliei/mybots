import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutboundMessage } from "@mybots/mailbox";
import { RunnerMailbox } from "@mybots/mailbox/node";
import { expect, test, vi } from "vitest";
import { runMailbox } from "../packages/agent-runner/src/poll-loop.ts";
import { PiProvider } from "../packages/agent-runner/src/providers/pi.ts";
import type { ProviderEvent } from "../packages/agent-runner/src/providers/types.ts";
import { createWebTools } from "../packages/agent-runner/src/tools/web.ts";
import type { SessionDriver } from "../packages/host/src/drivers/types.ts";
import { Host } from "../packages/host/src/host.ts";
import { waitForCheckpoint } from "./checkpoint.ts";
import { pageFixture } from "./page-fixture.ts";
import { startPiService } from "./pi-fixture.ts";
import { searchFixture } from "./search-fixture.ts";

function results(events: ProviderEvent[]) {
  return events.filter((event) => event.type === "result");
}

// Direct tool tests have no extension context; Pi supplies one at runtime.
const noContext = undefined as never;

test("the host routes a real SDK web exchange through persisted mailboxes to its channel", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mybots-host-web-")));
  const search = await searchFixture("brave");
  const pages = await pageFixture();
  pages.pages.set("/docs", {
    headers: { "Content-Type": "text/plain" },
    body: "Readable fixture documentation.",
  });
  const service = await startPiService((request) => {
    const count = request.messages.filter((message) => message.role === "tool").length;
    if (count === 0) return { tool: "web_search", arguments: { query: "documentation" } };
    if (count === 1) return { tool: "fetch_content", arguments: { url: `${pages.endpoint}/docs` } };
    return { text: "Read the searched documentation." };
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
        resources: context.resources,
        web: context.web,
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
  let host: Host | undefined;
  try {
    host = await Host.start({
      root,
      driver,
      configuration: {
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
          resources: { tools: ["web_search", "fetch_content"] },
          web: { search: { provider: "brave", endpoint: search.endpoint }, fetch: true },
        },
        destinations: [
          { id: "terminal", channelType: "cli", platformId: "local", instance: "cli" },
        ],
      },
    });
    const received: { message: OutboundMessage; destinationId: string; sessionId: string }[] = [];
    host.attachChannel({
      channelType: "cli",
      instance: "cli",
      async deliver(message, _signal, context) {
        received.push({ message, ...context });
      },
    });
    const accepted = await host.accept({
      destinationId: "terminal",
      userId: "cli:local",
      text: "Search and read the documentation",
    });
    await vi.waitFor(async () =>
      expect((await host?.inspect(accepted.sessionId))?.deliveries).toEqual([
        expect.objectContaining({ status: "delivered" }),
      ]),
    );
    expect(received).toEqual([
      expect.objectContaining({
        destinationId: "terminal",
        sessionId: accepted.sessionId,
        message: expect.objectContaining({
          in_reply_to: accepted.messageId,
          channel_type: "cli",
          platform_id: "local",
          content: "Read the searched documentation.",
        }),
      }),
    ]);
    expect(search.requests).toHaveLength(1);
    expect(pages.requests).toContain("/docs");
    expect(JSON.stringify(service.requests[2]?.messages)).toContain(
      "Readable fixture documentation.",
    );
  } finally {
    await host?.stop();
    await service.close();
    await search.close();
    await pages.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test("Pi runs configured web search and content fetching through the SDK tool loop", async () => {
  const root = await mkdtemp(join(tmpdir(), "mybots-pi-web-"));
  const search = await searchFixture("brave");
  const pages = await pageFixture();
  pages.pages.set("/docs", {
    body: "<html><head><title>Docs</title></head><body><article><h1>Docs</h1><p>Readable body text here.</p></article></body></html>",
  });
  const service = await startPiService((request) => {
    const toolMessages = request.messages.filter((message) => message.role === "tool");
    if (toolMessages.length === 0)
      return { tool: "web_search", arguments: { query: "mybots", numResults: 3 } };
    if (toolMessages.length === 1)
      return { tool: "fetch_content", arguments: { url: `${pages.endpoint}/docs` } };
    return { text: "Found sources and read the page." };
  });
  const query = new PiProvider({ modelRuntime: service.runtime, model: service.model }).query({
    prompt: "Search for mybots and read the documentation",
    cwd: root,
    sessionDir: join(root, "pi"),
    systemContext: {
      resources: { tools: ["read", "web_search", "fetch_content"] },
      web: { search: { provider: "brave", endpoint: search.endpoint }, fetch: true },
    },
  });
  const events: ProviderEvent[] = [];
  const collected = (async () => {
    for await (const event of query.events) events.push(event);
  })();
  try {
    await waitForCheckpoint(collected, "Pi web query completion");
    expect(results(events)).toEqual([{ type: "result", text: "Found sources and read the page." }]);
    expect(
      events.filter((event) => event.type === "progress").map((event) => event.message),
    ).toEqual(["web_search", "fetch_content"]);
    expect(service.requests[0]?.tools?.map((tool) => tool.function.name)).toEqual(
      expect.arrayContaining(["read", "web_search", "fetch_content"]),
    );
    expect(search.requests[0]?.url).toContain("q=mybots");
    expect(search.requests[0]?.url).toContain("count=3");
    expect(search.requests[0]?.token).toBe("gateway-managed");
    expect(pages.requests).toContain("/docs");
    expect(JSON.stringify(service.requests[1]?.messages)).toContain("Brave docs");
    expect(JSON.stringify(service.requests[2]?.messages)).toContain("Readable body text here.");
  } finally {
    await query.abort();
    await waitForCheckpoint(collected, "Pi web query completion");
    await service.close();
    await search.close();
    await pages.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

test("web tools stay out of the model loop when the Agent did not select them", async () => {
  const root = await mkdtemp(join(tmpdir(), "mybots-pi-web-disabled-"));
  const search = await searchFixture("brave");
  const service = await startPiService((request) =>
    request.messages.some((message) => message.role === "tool")
      ? { text: "Continued without the web tool." }
      : { tool: "web_search", arguments: { query: "blocked" } },
  );
  const query = new PiProvider({ modelRuntime: service.runtime, model: service.model }).query({
    prompt: "Search even though the tool is not selected",
    cwd: root,
    sessionDir: join(root, "pi"),
    systemContext: {
      resources: { tools: ["read"] },
      web: { search: { provider: "brave", endpoint: search.endpoint }, fetch: true },
    },
  });
  const events: ProviderEvent[] = [];
  const collected = (async () => {
    for await (const event of query.events) events.push(event);
  })();
  try {
    await waitForCheckpoint(collected, "Pi disabled web query completion");
    expect(results(events)).toEqual([{ type: "result", text: "Continued without the web tool." }]);
    expect(service.requests[0]?.tools?.map((tool) => tool.function.name)).not.toContain(
      "web_search",
    );
    expect(service.requests[0]?.tools?.map((tool) => tool.function.name)).not.toContain(
      "fetch_content",
    );
    expect(search.requests).toHaveLength(0);
  } finally {
    await query.abort();
    await waitForCheckpoint(collected, "Pi disabled web query completion");
    await service.close();
    await search.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

test("a provider failure returns a usable per-query error to the model", async () => {
  const root = await mkdtemp(join(tmpdir(), "mybots-pi-web-failure-"));
  const search = await searchFixture("brave");
  search.responses.push({ status: 500, body: { error: "upstream" } });
  const service = await startPiService((request) =>
    request.messages.some((message) => message.role === "tool")
      ? { text: "Reported the search failure." }
      : { tool: "web_search", arguments: { query: "failing" } },
  );
  const query = new PiProvider({ modelRuntime: service.runtime, model: service.model }).query({
    prompt: "Search a failing provider",
    cwd: root,
    sessionDir: join(root, "pi"),
    systemContext: {
      resources: { tools: ["web_search"] },
      web: { search: { provider: "brave", endpoint: search.endpoint } },
    },
  });
  const events: ProviderEvent[] = [];
  const collected = (async () => {
    for await (const event of query.events) events.push(event);
  })();
  try {
    await waitForCheckpoint(collected, "Pi web failure completion");
    expect(results(events)).toEqual([{ type: "result", text: "Reported the search failure." }]);
    const toolMessage = service.requests[1]?.messages.find((message) => message.role === "tool");
    expect(String(toolMessage?.content)).toContain("Brave search request failed (HTTP 500).");
    expect(String(toolMessage?.content)).toContain('"error"');
  } finally {
    await query.abort();
    await waitForCheckpoint(collected, "Pi web failure completion");
    await service.close();
    await search.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

test("cancellation terminates an active web request", async () => {
  const root = await mkdtemp(join(tmpdir(), "mybots-pi-web-cancel-"));
  const sockets = new Set<Socket>();
  const received = Promise.withResolvers<void>();
  const server = createServer(() => {
    received.resolve();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/search`;
  const service = await startPiService(() => ({
    tool: "web_search",
    arguments: { query: "held" },
  }));
  const query = new PiProvider({ modelRuntime: service.runtime, model: service.model }).query({
    prompt: "Search a held provider",
    cwd: root,
    sessionDir: join(root, "pi"),
    systemContext: {
      resources: { tools: ["web_search"] },
      web: { search: { provider: "brave", endpoint } },
    },
  });
  const events: ProviderEvent[] = [];
  const collected = (async () => {
    for await (const event of query.events) events.push(event);
  })();
  try {
    await received.promise;
    await query.abort();
    await waitForCheckpoint(collected, "Pi web cancellation completion");
    expect(results(events).at(-1)).toEqual({
      type: "result",
      text: null,
      isError: true,
      error: "Agent query aborted.",
    });
  } finally {
    await query.abort();
    await waitForCheckpoint(collected, "Pi web cancellation completion");
    await service.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

test("content fetching decodes the declared character set before extraction", async () => {
  const pages = await pageFixture();
  pages.pages.set("/latin", {
    body: Buffer.from(
      "<html><head><title>Caf\u00e9</title></head><body><article><p>caf\u00e9 r\u00e9sum\u00e9</p></article></body></html>",
      "latin1",
    ),
    headers: { "Content-Type": "text/html; charset=iso-8859-1" },
  });
  const tool = createWebTools({ fetch: true }).find(
    (candidate) => candidate.name === "fetch_content",
  );
  if (!tool) throw new Error("Missing fetch_content tool");
  try {
    const result = await tool.execute(
      "call-1",
      { url: `${pages.endpoint}/latin` },
      undefined,
      undefined,
      noContext,
    );
    const text = result.content[0];
    if (text.type !== "text") throw new Error("Expected text tool content");
    expect(text.text).toContain("caf\u00e9 r\u00e9sum\u00e9");
  } finally {
    await pages.close();
  }
}, 15000);

test("web search batches preserve input order and reject ambiguous arguments", async () => {
  const search = await searchFixture("brave");
  const tools = createWebTools({
    search: { provider: "brave", endpoint: search.endpoint },
  });
  const tool = tools.find((candidate) => candidate.name === "web_search");
  if (!tool) throw new Error("Missing web_search tool");
  try {
    const result = await tool.execute(
      "call-1",
      { queries: ["first", "second"] },
      undefined,
      undefined,
      noContext,
    );
    const text = result.content[0];
    if (text.type !== "text") throw new Error("Expected text tool content");
    const parsed = JSON.parse(text.text) as { queries: { query: string }[] };
    expect(parsed.queries.map((item) => item.query)).toEqual(["first", "second"]);
    expect(search.requests.map((request) => request.url)).toEqual([
      expect.stringContaining("q=first"),
      expect.stringContaining("q=second"),
    ]);
    await expect(
      tool.execute("call-2", { query: "a", queries: ["b"] }, undefined, undefined, noContext),
    ).rejects.toThrow("Provide either query or queries, exclusively.");
  } finally {
    await search.close();
  }
}, 15000);
