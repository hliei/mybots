import { afterEach, expect, it } from "vitest";
import { Agent } from "../src/core/agent.ts";
import { ConversationHistory } from "../src/core/history.ts";
import { chatFixture, toolReply } from "./chat-fixture.ts";
import { searchFixture } from "./search-fixture.ts";

let model: Awaited<ReturnType<typeof chatFixture>> | undefined;
let search: Awaited<ReturnType<typeof searchFixture>> | undefined;
afterEach(async () => {
  await search?.close();
  await model?.close();
  search = undefined;
  model = undefined;
});

it("searches Brave and continues the Agent answer with numbered sources and original reasoning", async () => {
  model = await chatFixture();
  search = await searchFixture();
  const agent = await Agent.open({ workspace: await model.workspace(undefined, search.settings) });
  model.responses.push({
    status: 200,
    body: toolReply(
      [{ name: "web_search", id: "search-1", args: { query: "Brave 中文 & docs" } }],
      "Need current sources.",
    ),
  });
  expect(await agent.chat("Search Brave docs")).toBe("Hello!");
  expect(search.requests).toEqual([
    {
      method: "GET",
      url: "/res/v1/web/search?q=Brave+%E4%B8%AD%E6%96%87+%26+docs&count=10",
      token: "offline-search-key",
      accept: "application/json",
    },
  ]);
  expect(
    model.requests[0].tools.find((tool) => tool.function.name === "web_search")?.function,
  ).toMatchObject({
    parameters: {
      required: [],
      properties: { query: { type: "string", description: "The search query" } },
    },
  });
  expect(model.requests[1].messages.at(-2)?.reasoning_content).toBe("Need current sources.");
  const result = {
    role: "tool",
    tool_call_id: "search-1",
    content:
      "1. **Brave docs**\n   https://example.test/docs\n   Search documentation.\n\n2. **Release**\n   https://example.test/news\n   New release.",
  };
  expect(model.requests[1].messages.at(-1)).toEqual(result);
  const history = await ConversationHistory.open(agent.config.history_path);
  expect(await history.getMessages(agent.sessionId)).toEqual(
    expect.arrayContaining([expect.objectContaining(result)]),
  );
});

it.each([
  { body: {}, expected: "No results found." },
  { body: { web: {} }, expected: "No results found." },
  { body: { web: { results: [] } }, expected: "No results found." },
  { body: { web: { results: [{}] } }, expected: "1. ****\n   \n   " },
  {
    body: { web: { results: [{ title: "Only a title" }] } },
    expected: "1. **Only a title**\n   \n   ",
  },
])("continues with reference empty/default fields: $expected", async ({ body, expected }) => {
  model = await chatFixture();
  search = await searchFixture();
  search.responses.push({ status: 200, body });
  const agent = await Agent.open({ workspace: await model.workspace(undefined, search.settings) });
  model.responses.push({
    status: 200,
    body: toolReply([{ name: "web_search", id: "empty", args: { query: "missing" } }]),
  });
  expect(await agent.chat("Search")).toBe("Hello!");
  expect(model.requests[1].messages.at(-1)).toEqual({
    role: "tool",
    tool_call_id: "empty",
    content: expected,
  });
});

it.each([429, 503])(
  "returns HTTP %s as a tool error for model continuation without retrying",
  async (status) => {
    model = await chatFixture();
    search = await searchFixture();
    search.responses.push({ status, body: { error: "Unavailable" } });
    const agent = await Agent.open({
      workspace: await model.workspace(undefined, search.settings),
    });
    model.responses.push({
      status: 200,
      body: toolReply([{ name: "web_search", id: "failed", args: { query: "news" } }]),
    });
    expect(await agent.chat("Search")).toBe("Hello!");
    expect(model.requests[1].messages.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "failed",
      content: `Error executing tool: Brave search request failed (HTTP ${status}).`,
    });
    expect(search.requests).toHaveLength(1);
  },
);

it.each([undefined, "web_search: null\n"])(
  "omits the tool without web_search configuration",
  async (settings) => {
    model = await chatFixture();
    const agent = await Agent.open({ workspace: await model.workspace(undefined, settings) });
    await agent.chat("Hello");
    expect(model.requests[0].tools.map((tool) => tool.function.name)).not.toContain("web_search");
  },
);

it.each([
  "web_search: {}\n",
  "web_search: []\n",
  "web_search:\n  provider: other\n  api_key: test\n",
  "web_search:\n  api_key: 123\n",
  "web_search:\n  api_key: test\n  api_base: file:///tmp/search\n",
])("rejects invalid search configuration before calling any service", async (settings) => {
  model = await chatFixture();
  await expect(
    Agent.open({ workspace: await model.workspace(undefined, settings) }),
  ).rejects.toThrow();
  expect(model.requests).toHaveLength(0);
});

it.each([
  { web: { results: "invalid" } },
  { web: null },
  { web: { results: [{ description: 12 }] } },
])("supplies malformed Brave response errors to the model", async (body) => {
  model = await chatFixture();
  search = await searchFixture();
  search.responses.push({ status: 200, body });
  const agent = await Agent.open({ workspace: await model.workspace(undefined, search.settings) });
  model.responses.push({
    status: 200,
    body: toolReply([{ name: "web_search", id: "bad", args: { query: "news" } }]),
  });
  expect(await agent.chat("Search")).toBe("Hello!");
  expect(model.requests[1].messages.at(-1)?.content).toMatch(
    /^Error executing tool: Invalid Brave search/,
  );
});

it("supplies connection failures to the model", async () => {
  model = await chatFixture();
  search = await searchFixture();
  const settings = search.settings;
  await search.close();
  search = undefined;
  const agent = await Agent.open({ workspace: await model.workspace(undefined, settings) });
  model.responses.push({
    status: 200,
    body: toolReply([{ name: "web_search", id: "offline", args: { query: "news" } }]),
  });
  expect(await agent.chat("Search")).toBe("Hello!");
  expect(model.requests[1].messages.at(-1)?.content).toMatch(/^Error executing tool:/);
});

it("times out a stalled response body after 30 seconds and continues with a tool error", async () => {
  model = await chatFixture();
  search = await searchFixture();
  search.server.removeAllListeners("request");
  let closed: Promise<void> | undefined;
  search.server.on("request", (_request, response) => {
    closed = new Promise<void>((resolve) => response.once("close", resolve));
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write('{"web":');
  });
  const agent = await Agent.open({ workspace: await model.workspace(undefined, search.settings) });
  model.responses.push({
    status: 200,
    body: toolReply([{ name: "web_search", id: "timeout", args: { query: "news" } }]),
  });
  const start = performance.now();
  expect(await agent.chat("Search")).toBe("Hello!");
  expect(performance.now() - start).toBeGreaterThanOrEqual(29_000);
  expect(performance.now() - start).toBeLessThan(36_000);
  expect(model.requests[1].messages.at(-1)?.content).toMatch(/^Error executing tool:/);
  await closed;
}, 40_000);

it("cancels a pending search, closes its connection, and saves the associated tool error", async () => {
  model = await chatFixture();
  search = await searchFixture();
  search.server.removeAllListeners("request");
  const controller = new AbortController();
  let closed: Promise<void> | undefined;
  search.server.on("request", (_request, response) => {
    closed = new Promise<void>((resolve) => response.once("close", resolve));
    controller.abort();
  });
  const agent = await Agent.open({ workspace: await model.workspace(undefined, search.settings) });
  model.responses.push({
    status: 200,
    body: toolReply([{ name: "web_search", id: "cancelled", args: { query: "news" } }]),
  });
  await expect(agent.chat("Search", controller.signal)).rejects.toThrow();
  await closed;
  const history = await ConversationHistory.open(agent.config.history_path);
  expect((await history.getMessages(agent.sessionId)).at(-1)).toMatchObject({
    role: "tool",
    tool_call_id: "cancelled",
    content: expect.stringMatching(/^Error executing tool:/),
  });
  expect(model.requests).toHaveLength(1);
}, 5000);
