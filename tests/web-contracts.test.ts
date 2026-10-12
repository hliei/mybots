import { afterEach, expect, it } from "vitest";
import { Agent } from "../src/core/agent.ts";
import { ConversationHistory } from "../src/core/history.ts";
import { chatFixture, toolReply } from "./chat-fixture.ts";
import { pageFixture } from "./page-fixture.ts";
import { searchFixture } from "./search-fixture.ts";

let model: Awaited<ReturnType<typeof chatFixture>> | undefined;
let search: Awaited<ReturnType<typeof searchFixture>> | undefined;
let pages: Awaited<ReturnType<typeof pageFixture>> | undefined;
afterEach(async () => {
  await search?.close();
  await pages?.close();
  await model?.close();
  search = undefined;
  pages = undefined;
  model = undefined;
});

it("accepts a one-item query array and preserves its text through the Agent", async () => {
  model = await chatFixture();
  search = await searchFixture();
  const agent = await Agent.open({
    workspace: await model.workspace(
      undefined,
      `web_search:\n  provider: brave\n  api_key: test\n  api_base: ${search.endpoint}\n`,
    ),
  });
  model.responses.push({
    status: 200,
    body: toolReply([
      { name: "web_search", id: "array-search", args: { queries: ["  中文 & docs  "] } },
    ]),
  });
  await agent.chat("Search");
  expect(search.requests).toHaveLength(1);
  expect(new URL(search.requests[0].url, search.endpoint).searchParams.get("q")).toBe(
    "  中文 & docs  ",
  );
  expect(model.requests[1].messages.at(-1)).toMatchObject({
    tool_call_id: "array-search",
    content: expect.stringContaining("Brave docs"),
  });
});

it.each([
  [{}, "Exactly one of url, urls is required."],
  [
    { url: "http://example.test", urls: ["http://other.test"] },
    "Exactly one of url, urls is required.",
  ],
  [{ url: 42 }, "url must be a string."],
  [{ urls: [] }, "urls must be at least 1 items."],
  [{ urls: ["a", "b", "c", "d", "e", "f"] }, "urls must be at most 5 items."],
  [{ urls: ["http://example.test", false] }, "urls must be a string array."],
  [{ urls: null }, "urls must be a string array."],
  [{ url: "http://example.test", offset: -1 }, "offset must be at least 0."],
  [{ url: "http://example.test", offset: 0.5 }, "offset must be an integer."],
  [{ url: "http://example.test", limit: 0 }, "limit must be at least 1."],
  [{ url: "http://example.test", limit: 20_001 }, "limit must be at most 20000."],
  [{ url: "http://example.test", limit: "100" }, "limit must be an integer."],
  [{ url: "http://example.test", raw: true }, "Unknown argument: raw."],
])("rejects invalid content arguments before page requests: %j", async (args, error) => {
  model = await chatFixture();
  pages = await pageFixture();
  const agent = await Agent.open({
    workspace: await model.workspace(undefined, "fetch_content: {}\n"),
  });
  const localArgs = {
    ...args,
    ...("url" in args && typeof args.url === "string" ? { url: `${pages.endpoint}/page` } : {}),
  };
  model.responses.push({
    status: 200,
    body: toolReply([{ name: "fetch_content", id: "invalid-content", args: localArgs }]),
  });
  expect(await agent.chat("Read")).toBe("Hello!");
  expect(model.requests[1].messages.at(-1)).toMatchObject({
    tool_call_id: "invalid-content",
    content: `Error executing tool: ${error}`,
  });
  expect(pages.requests).toHaveLength(0);
});

it("advertises exclusive web inputs with optional bounded arguments to the model", async () => {
  model = await chatFixture();
  const agent = await Agent.open({
    workspace: await model.workspace(
      undefined,
      "web_search:\n  provider: brave\n  api_key: test\nfetch_content: {}\n",
    ),
  });
  await agent.chat("Hello");
  const tools = model.requests[0].tools;
  expect(tools.map((tool) => tool.function.name)).toEqual([
    "read",
    "write",
    "edit",
    "bash",
    "web_search",
    "fetch_content",
  ]);
  expect(
    tools.find((tool) => tool.function.name === "web_search")?.function.parameters,
  ).toMatchObject({
    required: [],
    additionalProperties: false,
    oneOf: [{ required: ["query"] }, { required: ["queries"] }],
    properties: {
      query: { type: "string", minLength: 1, pattern: "\\S" },
      queries: {
        type: "array",
        minItems: 1,
        maxItems: 5,
        items: { type: "string", minLength: 1, pattern: "\\S" },
      },
      numResults: { type: "integer", minimum: 1, maximum: 20 },
      recencyFilter: { type: "string", enum: ["day", "week", "month", "year"] },
      domainFilter: { type: "array", items: { type: "string" } },
    },
  });
  expect(
    tools.find((tool) => tool.function.name === "fetch_content")?.function.parameters,
  ).toMatchObject({
    required: [],
    additionalProperties: false,
    oneOf: [{ required: ["url"] }, { required: ["urls"] }],
    properties: {
      url: { type: "string" },
      urls: { type: "array", minItems: 1, maxItems: 5, items: { type: "string" } },
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 20_000 },
    },
  });
});

it.each([0, 21, 1.5, "5", null])(
  "rejects invalid result bounds before a search request: %s",
  async (numResults) => {
    model = await chatFixture();
    search = await searchFixture();
    const agent = await Agent.open({
      workspace: await model.workspace(
        undefined,
        `web_search:\n  provider: brave\n  api_key: test\n  api_base: ${search.endpoint}\n`,
      ),
    });
    model.responses.push({
      status: 200,
      body: toolReply([
        { name: "web_search", id: "invalid-count", args: { query: "docs", numResults } },
      ]),
    });
    expect(await agent.chat("Search")).toBe("Hello!");
    expect(model.requests[1].messages.at(-1)).toMatchObject({
      tool_call_id: "invalid-count",
      content: expect.stringMatching(/^Error executing tool: numResults /),
    });
    expect(search.requests).toHaveLength(0);
  },
);

it.each([
  { queries: "docs" },
  { queries: [] },
  { queries: ["a", "b", "c", "d", "e", "f"] },
  { queries: ["docs", 1] },
  { queries: ["docs", "  "] },
  { queries: ["docs", null] },
])("rejects malformed query arrays before HTTP: %j", async (args) => {
  model = await chatFixture();
  search = await searchFixture();
  const agent = await Agent.open({
    workspace: await model.workspace(
      undefined,
      `web_search:\n  provider: brave\n  api_key: test\n  api_base: ${search.endpoint}\n`,
    ),
  });
  model.responses.push({
    status: 200,
    body: toolReply([{ name: "web_search", id: "invalid-array", args }]),
  });
  await agent.chat("Search");
  expect(model.requests[1].messages.at(-1)?.content).toMatch(
    /^Error executing tool: queries must be (a string array|at least|at most|an array of nonempty strings)/,
  );
  expect(search.requests).toHaveLength(0);
});

it.each([
  [{}, "Exactly one of query, queries is required."],
  [{ query: "docs", queries: ["other"] }, "Exactly one of query, queries is required."],
  [{ query: "" }, "query must be a nonempty string."],
  [{ query: " \n\t" }, "query must be a nonempty string."],
  [
    { query: "docs", recencyFilter: "hour" },
    "recencyFilter must be one of day, week, month, year.",
  ],
  [{ query: "docs", recencyFilter: null }, "recencyFilter must be a string."],
  [{ query: "docs", domainFilter: ["example.test", 3] }, "domainFilter must be a string array."],
  [{ query: "docs", provider: "serpapi" }, "Unknown argument: provider."],
])("rejects invalid search contracts before HTTP: %j", async (args, error) => {
  model = await chatFixture();
  search = await searchFixture();
  const agent = await Agent.open({
    workspace: await model.workspace(
      undefined,
      `web_search:\n  provider: brave\n  api_key: test\n  api_base: ${search.endpoint}\n`,
    ),
  });
  model.responses.push({
    status: 200,
    body: toolReply([{ name: "web_search", id: "invalid-input", args }]),
  });
  expect(await agent.chat("Search")).toBe("Hello!");
  expect(model.requests[1].messages.at(-1)).toMatchObject({
    tool_call_id: "invalid-input",
    content: `Error executing tool: ${error}`,
  });
  expect(search.requests).toHaveLength(0);
});

it.each(["brave", "serpapi"] as const)(
  "searches, fetches selected content, and continues Unicode text through the Agent with %s",
  async (provider) => {
    model = await chatFixture();
    search = await searchFixture(provider);
    pages = await pageFixture();
    const url = `${pages.endpoint}/source`;
    pages.pages.set("/source", { status: 302, headers: { Location: "/text" }, body: "" });
    pages.pages.set("/text", { body: "A😀中🚀B", headers: { "Content-Type": "text/plain" } });
    search.responses.push({
      status: 200,
      body:
        provider === "brave"
          ? { web: { results: [{ title: "Source", url, description: "Read this source." }] } }
          : { organic_results: [{ title: "Source", link: url, snippet: "Read this source." }] },
    });
    const agent = await Agent.open({
      workspace: await model.workspace(undefined, `${search.settings}fetch_content: {}\n`),
    });
    model.responses.push(
      {
        status: 200,
        body: toolReply(
          [{ name: "web_search", id: "find-source", args: { query: "Unicode source" } }],
          "Find a source.",
        ),
      },
      {
        status: 200,
        body: toolReply(
          [{ name: "fetch_content", id: "read-source", args: { url, limit: 2 } }],
          "Read the selected source.",
        ),
      },
      {
        status: 200,
        body: toolReply(
          [{ name: "fetch_content", id: "continue-source", args: { url, offset: 2, limit: 3 } }],
          "Read the remaining text.",
        ),
      },
      {
        status: 200,
        body: {
          choices: [
            {
              message: {
                role: "assistant",
                content: "The source says A😀中🚀B.",
                reasoning_content: "Combine both chunks.",
              },
            },
          ],
        },
      },
    );
    expect(await agent.chat("Find and read the complete source")).toBe("The source says A😀中🚀B.");
    expect(model.requests).toHaveLength(4);
    expect(model.requests[1].messages.at(-1)).toMatchObject({
      role: "tool",
      tool_call_id: "find-source",
      content: JSON.stringify({
        queries: [
          {
            query: "Unicode source",
            provider,
            results: [{ title: "Source", url, snippet: "Read this source." }],
            error: null,
          },
        ],
      }),
    });
    const expected = {
      url,
      finalUrl: `${pages.endpoint}/text`,
      title: "",
      error: null,
      totalChars: 5,
    };
    expect(model.requests[2].messages.at(-1)).toMatchObject({
      role: "tool",
      tool_call_id: "read-source",
    });
    expect(JSON.parse(model.requests[2].messages.at(-1)?.content ?? "")).toEqual({
      urls: [
        {
          ...expected,
          content: "A😀",
          nextOffset: 2,
        },
      ],
    });
    expect(model.requests[3].messages.at(-1)).toMatchObject({
      role: "tool",
      tool_call_id: "continue-source",
    });
    expect(JSON.parse(model.requests[3].messages.at(-1)?.content ?? "")).toEqual({
      urls: [
        {
          ...expected,
          content: "中🚀B",
          nextOffset: null,
        },
      ],
    });
    expect(
      model.requests[3].messages
        .filter((message) => message.tool_calls)
        .map((message) => message.reasoning_content),
    ).toEqual(["Find a source.", "Read the selected source.", "Read the remaining text."]);
    const history = await ConversationHistory.open(agent.config.history_path);
    const recorded = await history.getMessages(agent.sessionId);
    expect(recorded.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(recorded.filter((message) => message.role === "tool")).toMatchObject(
      model.requests[3].messages.filter((message) => message.role === "tool"),
    );
    expect(recorded.at(-1)).toMatchObject({
      content: "The source says A😀中🚀B.",
      reasoning_content: "Combine both chunks.",
    });
    expect(search.requests).toHaveLength(1);
    expect(pages.requests).toEqual(["/source", "/text", "/source", "/text"]);
  },
);

it.each([
  ["", []],
  ["web_search:\n  provider: serpapi\n  api_key: offline\n", ["web_search"]],
  ["fetch_content: {}\n", ["fetch_content"]],
  [
    "web_search:\n  provider: brave\n  api_key: offline\nfetch_content: {}\n",
    ["web_search", "fetch_content"],
  ],
])(
  "gates web tools independently while preserving local tools and Skill: %s",
  async (settings, names) => {
    model = await chatFixture();
    await model.writeSkill(
      "guide",
      "---\nname: Guide\ndescription: A reading guide\n---\nRead carefully.",
    );
    const agent = await Agent.open({
      workspace: await model.workspace(undefined, settings, "allow_skills: true\n"),
    });
    await agent.chat("Hello");
    expect(model.requests[0].tools.map((tool) => tool.function.name)).toEqual([
      "read",
      "write",
      "edit",
      "bash",
      "skill",
      ...names,
    ]);
  },
);
