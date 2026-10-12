import { gzipSync } from "node:zlib";
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

it("searches Brave and continues the Agent answer with JSON sources and original reasoning", async () => {
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
      url: "/res/v1/web/search?q=Brave+%E4%B8%AD%E6%96%87+%26+docs&count=5",
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
    content: JSON.stringify({
      queries: [
        {
          query: "Brave 中文 & docs",
          provider: "brave",
          results: [
            {
              title: "Brave docs",
              url: "https://example.test/docs",
              snippet: "Search documentation.",
            },
            { title: "Release", url: "https://example.test/news", snippet: "New release." },
          ],
          error: null,
        },
      ],
    }),
  };
  expect(model.requests[1].messages.at(-1)).toEqual(result);
  const history = await ConversationHistory.open(agent.config.history_path);
  expect(await history.getMessages(agent.sessionId)).toEqual(
    expect.arrayContaining([expect.objectContaining(result)]),
  );
});

it.each([
  { body: { type: "search" }, results: [] },
  { body: { type: "search", web: null }, results: [] },
  { body: { web: { results: [] } }, results: [] },
  {
    body: {
      web: { results: [{ title: "Title", url: "https://example.test", description: null }] },
    },
    results: [{ title: "Title", url: "https://example.test", snippet: "" }],
  },
])(
  "continues with successful Brave empty results or optional snippets",
  async ({ body, results }) => {
    model = await chatFixture();
    search = await searchFixture();
    search.responses.push({ status: 200, body });
    const agent = await Agent.open({
      workspace: await model.workspace(undefined, search.settings),
    });
    model.responses.push({
      status: 200,
      body: toolReply([{ name: "web_search", id: "empty", args: { query: "missing" } }]),
    });
    await agent.chat("Search");
    expect(JSON.parse(model.requests[1].messages.at(-1)?.content ?? "")).toEqual({
      queries: [{ query: "missing", provider: "brave", results, error: null }],
    });
  },
);

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
      content: JSON.stringify({
        queries: [
          {
            query: "news",
            provider: "brave",
            results: [],
            error: `Brave search request failed (HTTP ${status}).`,
          },
        ],
      }),
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
  {},
  { web: {} },
  { web: { results: [{}] } },
  { web: { results: [{ title: "Title", url: "file:///tmp/data" }] } },
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
  expect(JSON.parse(model.requests[1].messages.at(-1)?.content ?? "").queries[0]).toMatchObject({
    results: [],
    error: expect.stringMatching(/^Invalid Brave search/),
  });
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
  expect(JSON.parse(model.requests[1].messages.at(-1)?.content ?? "").queries[0]).toMatchObject({
    results: [],
    error: expect.any(String),
  });
});

it.each(["brave", "serpapi"] as const)(
  "times out a stalled %s response body after 30 seconds and continues with an item error",
  async (provider) => {
    model = await chatFixture();
    search = await searchFixture(provider);
    search.server.removeAllListeners("request");
    let closed: Promise<void> | undefined;
    search.server.on("request", (_request, response) => {
      closed = new Promise<void>((resolve) => response.once("close", resolve));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"web":');
    });
    const agent = await Agent.open({
      workspace: await model.workspace(undefined, search.settings),
    });
    model.responses.push({
      status: 200,
      body: toolReply([{ name: "web_search", id: "timeout", args: { query: "news" } }]),
    });
    const start = performance.now();
    expect(await agent.chat("Search")).toBe("Hello!");
    expect(performance.now() - start).toBeGreaterThanOrEqual(29_000);
    expect(performance.now() - start).toBeLessThan(36_000);
    expect(JSON.parse(model.requests[1].messages.at(-1)?.content ?? "").queries[0]).toEqual({
      query: "news",
      provider,
      results: [],
      error: "Search request timed out after 30 seconds.",
    });
    await closed;
  },
  40_000,
);

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

it("searches SerpApi Google with workspace credentials and normalized sources", async () => {
  model = await chatFixture();
  search = await searchFixture("serpapi");
  search.responses.push({
    status: 200,
    body: {
      organic_results: [
        { title: "Google source", link: "https://example.test/google", snippet: "Google snippet" },
      ],
    },
  });
  const agent = await Agent.open({ workspace: await model.workspace(undefined, search.settings) });
  model.responses.push({
    status: 200,
    body: toolReply([{ name: "web_search", id: "google", args: { query: "  中文 & docs  " } }]),
  });
  expect(await agent.chat("Search Google")).toBe("Hello!");
  const params = new URL(search.requests[0].url, search.endpoint).searchParams;
  expect(Object.fromEntries(params)).toEqual({
    q: "  中文 & docs  ",
    engine: "google",
    api_key: "offline-search-key",
  });
  expect(search.requests[0]).toMatchObject({
    method: "GET",
    accept: "application/json",
    token: undefined,
  });
  expect(JSON.parse(model.requests[1].messages.at(-1)?.content ?? "")).toEqual({
    queries: [
      {
        query: "  中文 & docs  ",
        provider: "serpapi",
        results: [
          { title: "Google source", url: "https://example.test/google", snippet: "Google snippet" },
        ],
        error: null,
      },
    ],
  });
});

it.each([
  ["brave", "day", "pd"],
  ["brave", "week", "pw"],
  ["brave", "month", "pm"],
  ["brave", "year", "py"],
  ["serpapi", "day", "qdr:d"],
  ["serpapi", "week", "qdr:w"],
  ["serpapi", "month", "qdr:m"],
  ["serpapi", "year", "qdr:y"],
] as const)(
  "applies %s %s recency and domain restrictions without filling results",
  async (provider, recencyFilter, expectedRecency) => {
    model = await chatFixture();
    search = await searchFixture(provider);
    const sources = [
      { title: "Excluded", url: "https://blocked.example.test/one", snippet: "excluded subdomain" },
      { title: "Wrong", url: "https://notexample.test/one", snippet: "similar domain" },
      { title: "First", url: "https://sub.example.test/one", snippet: "first source" },
      { title: "Second", url: "https://other.test/two", snippet: "second source" },
      { title: "Third", url: "https://example.test/three", snippet: "third source" },
    ];
    search.responses.push({
      status: 200,
      body:
        provider === "brave"
          ? {
              web: {
                results: sources.map(({ title, url, snippet }) => ({
                  title,
                  url,
                  description: snippet,
                })),
              },
            }
          : {
              organic_results: sources.map(({ title, url, snippet }) => ({
                title,
                link: url,
                snippet,
              })),
            },
    });
    const agent = await Agent.open({
      workspace: await model.workspace(undefined, search.settings),
    });
    model.responses.push({
      status: 200,
      body: toolReply([
        {
          name: "web_search",
          id: "filtered",
          args: {
            query: "news",
            numResults: 2,
            recencyFilter,
            domainFilter: ["example.test", "other.test", "-blocked.example.test"],
          },
        },
      ]),
    });
    await agent.chat("Find sources");
    expect(JSON.parse(model.requests[1].messages.at(-1)?.content ?? "")).toEqual({
      queries: [{ query: "news", provider, results: sources.slice(2, 4), error: null }],
    });
    expect(search.requests).toHaveLength(1);
    const params = new URL(search.requests[0].url, search.endpoint).searchParams;
    expect(params.get("q")).toBe(
      "news (site:example.test OR site:other.test) -site:blocked.example.test",
    );
    expect(params.get(provider === "brave" ? "freshness" : "tbs")).toBe(expectedRecency);
    if (provider === "brave") expect(params.get("count")).toBe("2");
    else expect(params.has("num")).toBe(false);
  },
);

it.each(["brave", "serpapi"] as const)(
  "preserves %s mixed-success batches in input order with distinguishable item errors",
  async (provider) => {
    model = await chatFixture();
    search = await searchFixture(provider);
    search.responses.push(
      {
        status: 200,
        body: provider === "brave" ? { web: { results: [] } } : { organic_results: [] },
      },
      { status: 429, body: { error: "Unavailable" } },
      {
        status: 200,
        body: provider === "brave" ? { web: { results: "broken" } } : { organic_results: "broken" },
      },
      {
        status: 200,
        body:
          provider === "brave"
            ? {
                web: {
                  results: [
                    { title: "Last", url: "https://example.test/last", description: "Last source" },
                  ],
                },
              }
            : {
                organic_results: [
                  { title: "Last", link: "https://example.test/last", snippet: "Last source" },
                ],
              },
      },
    );
    const agent = await Agent.open({
      workspace: await model.workspace(undefined, search.settings),
    });
    model.responses.push({
      status: 200,
      body: toolReply([
        {
          name: "web_search",
          id: "batch",
          args: { queries: ["empty", "http", "invalid", "last"] },
        },
      ]),
    });
    expect(await agent.chat("Search batch")).toBe("Hello!");
    expect(JSON.parse(model.requests[1].messages.at(-1)?.content ?? "")).toEqual({
      queries: [
        { query: "empty", provider, results: [], error: null },
        { query: "http", provider, results: [], error: expect.stringContaining("HTTP 429") },
        {
          query: "invalid",
          provider,
          results: [],
          error: expect.stringMatching(/Invalid .* search/),
        },
        {
          query: "last",
          provider,
          results: [{ title: "Last", url: "https://example.test/last", snippet: "Last source" }],
          error: null,
        },
      ],
    });
    expect(search.requests).toHaveLength(4);
  },
);

it.each(["brave", "serpapi"] as const)(
  "rejects an oversized decoded %s streamed body and closes the response",
  async (provider) => {
    model = await chatFixture();
    search = await searchFixture(provider);
    search.server.removeAllListeners("request");
    let closed: Promise<void> | undefined;
    search.server.on("request", (_request, response) => {
      closed = new Promise<void>((resolve) => response.once("close", resolve));
      response.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": "gzip" });
      const padding = "中".repeat(1_800_000);
      const payload =
        provider === "brave" ? { web: { results: [], padding } } : { organic_results: [], padding };
      response.write(gzipSync(JSON.stringify(payload)));
      response.end();
    });
    const agent = await Agent.open({
      workspace: await model.workspace(undefined, search.settings),
    });
    model.responses.push({
      status: 200,
      body: toolReply([{ name: "web_search", id: "oversize", args: { query: "news" } }]),
    });
    expect(await agent.chat("Search")).toBe("Hello!");
    expect(JSON.parse(model.requests[1].messages.at(-1)?.content ?? "")).toEqual({
      queries: [{ query: "news", provider, results: [], error: expect.stringMatching(/5 MiB/) }],
    });
    await closed;
  },
);

it.each(["brave", "serpapi"] as const)(
  "limits a five-query %s batch to three active requests while preserving rank and input order",
  async (provider) => {
    model = await chatFixture();
    search = await searchFixture(provider);
    search.server.removeAllListeners("request");
    const pending = new Map<string, () => void>();
    const arrived: string[] = [];
    const waiting = new Map<string, () => void>();
    const waitFor = (query: string) =>
      arrived.includes(query)
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiting.set(query, resolve));
    let maximum = 0;
    search.server.on("request", (request, response) => {
      const query = new URL(request.url ?? "", search?.endpoint).searchParams.get("q") ?? "";
      arrived.push(query);
      pending.set(query, () => {
        pending.delete(query);
        const source = { title: query, url: `https://example.test/${query}`, description: query };
        response.end(
          JSON.stringify(
            provider === "brave"
              ? { web: { results: [source] } }
              : { organic_results: [{ title: query, link: source.url, snippet: query }] },
          ),
        );
      });
      maximum = Math.max(maximum, pending.size);
      waiting.get(query)?.();
    });
    const agent = await Agent.open({
      workspace: await model.workspace(undefined, search.settings),
    });
    const queries = ["one", "two", "three", "four", "five"];
    model.responses.push({
      status: 200,
      body: toolReply([{ name: "web_search", id: "limited", args: { queries } }]),
    });
    const chat = agent.chat("Search batch");
    await waitFor("three");
    pending.get("three")?.();
    await waitFor("four");
    pending.get("four")?.();
    await waitFor("five");
    pending.get("five")?.();
    pending.get("two")?.();
    pending.get("one")?.();
    expect(await chat).toBe("Hello!");
    expect(maximum).toBe(3);
    expect(arrived).toEqual(queries);
    expect(JSON.parse(model.requests[1].messages.at(-1)?.content ?? "")).toEqual({
      queries: queries.map((query) => ({
        query,
        provider,
        results: [{ title: query, url: `https://example.test/${query}`, snippet: query }],
        error: null,
      })),
    });
  },
);

it.each(["brave", "serpapi"] as const)(
  "cancels active %s batch bodies without starting queued work or continuing the model",
  async (provider) => {
    model = await chatFixture();
    search = await searchFixture(provider);
    search.server.removeAllListeners("request");
    const controller = new AbortController();
    const arrived: string[] = [];
    const closed: Promise<void>[] = [];
    search.server.on("request", (request, response) => {
      arrived.push(new URL(request.url ?? "", search?.endpoint).searchParams.get("q") ?? "");
      closed.push(new Promise<void>((resolve) => response.once("close", resolve)));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"partial":');
      if (arrived.length === 3) controller.abort(new Error("User cancelled search."));
    });
    const agent = await Agent.open({
      workspace: await model.workspace(undefined, search.settings),
    });
    model.responses.push({
      status: 200,
      body: toolReply([
        {
          name: "web_search",
          id: "cancel-batch",
          args: { queries: ["one", "two", "three", "four", "five"] },
        },
      ]),
    });
    await expect(agent.chat("Search", controller.signal)).rejects.toThrow(
      "DeepSeek request cancelled.",
    );
    await Promise.all(closed);
    expect(arrived).toEqual(["one", "two", "three"]);
    expect(model.requests).toHaveLength(1);
    const history = await ConversationHistory.open(agent.config.history_path);
    expect((await history.getMessages(agent.sessionId)).at(-1)).toMatchObject({
      role: "tool",
      tool_call_id: "cancel-batch",
      content: "Error executing tool: User cancelled search.",
    });
  },
);

it.each([
  ["brave", undefined],
  ["serpapi", undefined],
  ["brave", 1],
  ["serpapi", 1],
  ["brave", 20],
  ["serpapi", 20],
] as const)(
  "bounds %s results by %s without pagination or additional requests",
  async (provider, numResults) => {
    model = await chatFixture();
    search = await searchFixture(provider);
    const results = Array.from({ length: 25 }, (_, index) => ({
      title: `Source ${index}`,
      url: `https://example.test/${index}`,
      snippet: `${index}`,
    }));
    search.responses.push({
      status: 200,
      body:
        provider === "brave"
          ? {
              web: {
                results: results.map(({ title, url, snippet }) => ({
                  title,
                  url,
                  description: snippet,
                })),
              },
            }
          : {
              organic_results: results.map(({ title, url, snippet }) => ({
                title,
                link: url,
                snippet,
              })),
            },
    });
    const agent = await Agent.open({
      workspace: await model.workspace(undefined, search.settings),
    });
    model.responses.push({
      status: 200,
      body: toolReply([
        {
          name: "web_search",
          id: "count",
          args: { query: "news", ...(numResults === undefined ? {} : { numResults }) },
        },
      ]),
    });
    await agent.chat("Search");
    expect(JSON.parse(model.requests[1].messages.at(-1)?.content ?? "")).toEqual({
      queries: [
        { query: "news", provider, results: results.slice(0, numResults ?? 5), error: null },
      ],
    });
    expect(search.requests).toHaveLength(1);
  },
);

it.each([
  { body: { organic_results: [] }, error: null },
  {
    body: {
      search_metadata: { status: "Success" },
      search_information: { organic_results_state: "Fully empty" },
    },
    error: null,
  },
  {
    body: {
      search_metadata: { status: "Success" },
      search_information: { organic_results_state: "Fully empty" },
      error: "Google hasn't returned any results for this query.",
    },
    error: null,
  },
  { body: {}, error: /Invalid SerpApi search/ },
  { body: { error: "Invalid key" }, error: /SerpApi search provider error/ },
  {
    body: { search_metadata: { status: "Error" }, organic_results: [] },
    error: /SerpApi search provider error/,
  },
  {
    body: { search_metadata: { status: "Processing" }, organic_results: [] },
    error: /Invalid SerpApi search status/,
  },
  { body: { organic_results: [null] }, error: /Invalid SerpApi search/ },
  {
    body: { organic_results: [{ title: "Title", link: "https://example.test", snippet: 1 }] },
    error: /Invalid SerpApi search/,
  },
])(
  "distinguishes SerpApi empty results from malformed/provider failures",
  async ({ body, error }) => {
    model = await chatFixture();
    search = await searchFixture("serpapi");
    search.responses.push({ status: 200, body });
    const agent = await Agent.open({
      workspace: await model.workspace(undefined, search.settings),
    });
    model.responses.push({
      status: 200,
      body: toolReply([{ name: "web_search", id: "payload", args: { query: "news" } }]),
    });
    await agent.chat("Search");
    expect(JSON.parse(model.requests[1].messages.at(-1)?.content ?? "")).toEqual({
      queries: [
        {
          query: "news",
          provider: "serpapi",
          results: [],
          error: error === null ? null : expect.stringMatching(error),
        },
      ],
    });
    expect(search.requests).toHaveLength(1);
  },
);

it.each(["brave", "serpapi"] as const)("returns a %s invalid JSON item error", async (provider) => {
  model = await chatFixture();
  search = await searchFixture(provider);
  search.server.removeAllListeners("request");
  search.server.on("request", (_request, response) => response.end("{not JSON"));
  const agent = await Agent.open({ workspace: await model.workspace(undefined, search.settings) });
  model.responses.push({
    status: 200,
    body: toolReply([{ name: "web_search", id: "json", args: { query: "news" } }]),
  });
  await agent.chat("Search");
  expect(JSON.parse(model.requests[1].messages.at(-1)?.content ?? "")).toEqual({
    queries: [
      {
        query: "news",
        provider,
        results: [],
        error: expect.stringMatching(/Invalid .* search JSON/),
      },
    ],
  });
});

it.each(["brave", "serpapi"] as const)(
  "enforces %s exclusion-only filters and lets exclusions win over identical inclusions",
  async (provider) => {
    model = await chatFixture();
    search = await searchFixture(provider);
    const sources = [
      { title: "Excluded", url: "https://deep.sub.example.test/", snippet: "blocked" },
      { title: "Allowed", url: "https://other.test/", snippet: "allowed" },
    ];
    const body =
      provider === "brave"
        ? {
            web: {
              results: sources.map(({ title, url, snippet }) => ({
                title,
                url,
                description: snippet,
              })),
            },
          }
        : {
            organic_results: sources.map(({ title, url, snippet }) => ({
              title,
              link: url,
              snippet,
            })),
          };
    search.responses.push({ status: 200, body }, { status: 200, body });
    const agent = await Agent.open({
      workspace: await model.workspace(undefined, search.settings),
    });
    model.responses.push({
      status: 200,
      body: toolReply([
        {
          name: "web_search",
          id: "exclude",
          args: { query: "news", domainFilter: ["-EXAMPLE.TEST"] },
        },
        {
          name: "web_search",
          id: "wins",
          args: { query: "news", domainFilter: ["example.test", "-example.test"] },
        },
      ]),
    });
    await agent.chat("Search");
    expect(JSON.parse(model.requests[1].messages.at(-2)?.content ?? "")).toEqual({
      queries: [{ query: "news", provider, results: [sources[1]], error: null }],
    });
    expect(JSON.parse(model.requests[1].messages.at(-1)?.content ?? "")).toEqual({
      queries: [{ query: "news", provider, results: [], error: null }],
    });
    expect(search.requests).toHaveLength(2);
  },
);

it.each(["brave", "serpapi"] as const)(
  "accepts a %s response body at exactly the 5 MiB boundary",
  async (provider) => {
    model = await chatFixture();
    search = await searchFixture(provider);
    search.server.removeAllListeners("request");
    const empty = JSON.stringify(
      provider === "brave"
        ? { web: { results: [] }, padding: "" }
        : { organic_results: [], padding: "" },
    );
    const payload = empty.replace(
      '"padding":""',
      `"padding":"${"x".repeat(5_242_880 - Buffer.byteLength(empty))}"`,
    );
    search.server.on("request", (_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write(payload);
      response.end();
    });
    const agent = await Agent.open({
      workspace: await model.workspace(undefined, search.settings),
    });
    model.responses.push({
      status: 200,
      body: toolReply([{ name: "web_search", id: "boundary", args: { query: "news" } }]),
    });
    await agent.chat("Search");
    expect(JSON.parse(model.requests[1].messages.at(-1)?.content ?? "")).toEqual({
      queries: [{ query: "news", provider, results: [], error: null }],
    });
  },
);

it.each(["brave", "serpapi"] as const)(
  "closes a stalled %s HTTP error body without retrying or waiting for its deadline",
  async (provider) => {
    model = await chatFixture();
    search = await searchFixture(provider);
    search.server.removeAllListeners("request");
    let requests = 0;
    let closed: Promise<void> | undefined;
    search.server.on("request", (_request, response) => {
      requests++;
      closed = new Promise<void>((resolve) => response.once("close", resolve));
      response.writeHead(503, { "Content-Type": "application/json" });
      response.write('{"error":');
    });
    const agent = await Agent.open({
      workspace: await model.workspace(undefined, search.settings),
    });
    model.responses.push({
      status: 200,
      body: toolReply([{ name: "web_search", id: "http-body", args: { query: "news" } }]),
    });
    await agent.chat("Search");
    await closed;
    expect(JSON.parse(model.requests[1].messages.at(-1)?.content ?? "")).toEqual({
      queries: [
        { query: "news", provider, results: [], error: expect.stringContaining("HTTP 503") },
      ],
    });
    expect(requests).toBe(1);
  },
);
