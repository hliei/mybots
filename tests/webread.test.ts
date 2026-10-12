import { once } from "node:events";
import type { ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { Agent } from "../src/core/agent.ts";
import { ConversationHistory } from "../src/core/history.ts";
import { chatFixture, toolReply } from "./chat-fixture.ts";
import { pageFixture } from "./page-fixture.ts";

interface ContentItem {
  url: string;
  finalUrl: string | null;
  title: string;
  content: string;
  error: string | null;
  totalChars: number;
  nextOffset: number | null;
}

let model: Awaited<ReturnType<typeof chatFixture>>;
let pages: Awaited<ReturnType<typeof pageFixture>>;
afterEach(async () => {
  if (pages?.server.listening) await pages.close();
  await model?.close();
});

async function setup() {
  model = await chatFixture();
  pages = await pageFixture();
  return Agent.open({ workspace: await model.workspace(undefined, "fetch_content: {}\n") });
}

async function read(agent: Agent, args: unknown, signal?: AbortSignal): Promise<ContentItem[]> {
  model.responses.push({
    status: 200,
    body: toolReply([{ name: "fetch_content", id: "read-page", args }], "Read this source."),
  });
  const before = model.requests.length;
  expect(await agent.chat("Read the source", signal)).toBe("Hello!");
  expect(model.requests[before + 1].messages.at(-2)?.reasoning_content).toBe("Read this source.");
  const message = model.requests[before + 1].messages.at(-1);
  expect(message).toMatchObject({ role: "tool", tool_call_id: "read-page" });
  return JSON.parse(message?.content ?? "").urls;
}

it("reads plain text through the Agent with a JSON envelope and records its tool result", async () => {
  const agent = await setup();
  pages.pages.set("/text", {
    body: "Read carefully.\n",
    headers: { "Content-Type": "text/plain" },
  });
  const url = `${pages.endpoint}/text`;
  const expected = {
    url,
    finalUrl: url,
    title: "",
    content: "Read carefully.\n",
    error: null,
    totalChars: 16,
    nextOffset: null,
  };
  expect(await read(agent, { url })).toEqual([expected]);
  const history = await ConversationHistory.open(agent.config.history_path);
  expect((await history.getMessages(agent.sessionId)).at(-2)).toMatchObject({
    role: "tool",
    tool_call_id: "read-page",
    content: JSON.stringify({ urls: [expected] }),
  });
  expect(pages.requests).toEqual(["/text"]);
});

it("extracts article Markdown, removes explicit hidden markup, and resolves references from the document base", async () => {
  const agent = await setup();
  const prose =
    "This guide explains how to read and use reliable sources. It contains useful details, examples, and clear advice for readers. ".repeat(
      8,
    );
  pages.pages.set("/article", {
    body: `<title>Local guide</title><base href="/assets/"><nav><a href="/ads">Advertisement</a></nav><article><h1>Guide</h1><p>${prose}</p><p>Read <strong>carefully</strong> and <a href="next">continue</a>.</p><img src="diagram.png" alt="Diagram"><p hidden>Hidden attribute</p><p aria-hidden="true">ARIA hidden</p><p style="display: none">Inline hidden</p><p style="visibility: hidden">Invisible</p><script>fetch('/script-data')</script><style>noise</style><template>Template noise</template><noscript>Noscript noise</noscript></article>`,
  });
  const url = `${pages.endpoint}/article`;
  const [item] = await read(agent, { url });
  expect(item).toMatchObject({
    url,
    finalUrl: url,
    title: "Local guide",
    error: null,
    nextOffset: null,
  });
  expect(item.content).toContain(prose.trim());
  expect(item.content).toContain("Read **carefully**");
  expect(item.content).toContain(`[continue](${pages.endpoint}/assets/next)`);
  expect(item.content).toContain(`![Diagram](${pages.endpoint}/assets/diagram.png)`);
  expect(item.content).not.toMatch(
    /Advertisement|Hidden attribute|ARIA hidden|Inline hidden|Invisible|script-data|noise/,
  );
  expect(pages.requests).toEqual(["/article"]);
});

it("removes explicit hidden markup regardless of CSS and ARIA casing", async () => {
  const agent = await setup();
  pages.pages.set("/hidden", {
    body: '<p>Visible text.</p><p style="DISPLAY: none">Hidden display.</p><p style="visibility: HIDDEN">Hidden visibility.</p><p style="VISIBILITY: collapse">Hidden collapse.</p><p aria-hidden="TRUE">Hidden ARIA.</p>',
  });
  const [item] = await read(agent, { url: `${pages.endpoint}/hidden` });
  expect(item).toMatchObject({ content: "Visible text.", error: null, totalChars: 13 });
  expect(pages.requests).toEqual(["/hidden"]);
});

it("falls back to the cleaned body when a small link directory has no readable article", async () => {
  const agent = await setup();
  pages.pages.set("/directory", {
    body: '<nav><a href="/one">First guide</a> <a href="/two">Second guide</a></nav><template>Template noise</template><p hidden>Hidden noise</p>',
  });
  const url = `${pages.endpoint}/directory`;
  expect(await read(agent, { url })).toEqual([
    {
      url,
      finalUrl: url,
      title: "",
      content: `[First guide](${pages.endpoint}/one) [Second guide](${pages.endpoint}/two)`,
      error: null,
      totalChars: `[First guide](${pages.endpoint}/one) [Second guide](${pages.endpoint}/two)`
        .length,
      nextOffset: null,
    },
  ]);
});

it("returns an extraction error when both article and cleaned body are empty", async () => {
  const agent = await setup();
  pages.pages.set("/empty", {
    body: '<title>Empty</title><body><script>document.body.textContent="dynamic"</script><style>body { color: red }</style><template>Template</template><noscript>Disabled</noscript><p hidden>Hidden</p>',
  });
  const url = `${pages.endpoint}/empty`;
  expect(await read(agent, { url })).toEqual([
    {
      url,
      finalUrl: url,
      title: "",
      content: "",
      error: "Content extraction produced no readable text.",
      totalChars: 0,
      nextOffset: null,
    },
  ]);
});

it("preserves ordered successes and item failures in a mixed batch, including redirected final URLs", async () => {
  const agent = await setup();
  pages.pages.set("/redirect", { status: 302, headers: { Location: "/final" }, body: "" });
  pages.pages.set("/final", { body: "<title>Final</title><p><a href='next'>Next</a></p>" });
  pages.pages.set("/file.html", {
    body: "%PDF-1.7",
    headers: { "Content-Type": "application/pdf" },
  });
  pages.pages.set("/failure", { status: 503, body: "Unavailable" });
  pages.pages.set("/markdown", {
    body: "# Guide\n\nRaw **Markdown**.\n",
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
  const urls = ["/redirect", "file:///tmp/page.html", "/file.html", "/failure", "/markdown"].map(
    (path) => (path.startsWith("/") ? `${pages.endpoint}${path}` : path),
  );
  const items = await read(agent, { urls });
  expect(items.map((item) => item.url)).toEqual(urls);
  expect(items[0]).toMatchObject({
    finalUrl: `${pages.endpoint}/final`,
    title: "Final",
    content: `[Next](${pages.endpoint}/next)`,
    error: null,
  });
  expect(items[1]).toMatchObject({
    finalUrl: null,
    error: "Content URL must be an absolute HTTP(S) URL.",
    content: "",
    title: "",
    totalChars: 0,
    nextOffset: null,
  });
  expect(items[2]).toMatchObject({
    finalUrl: urls[2],
    error: "Unsupported content type: application/pdf.",
    content: "",
    totalChars: 0,
  });
  expect(items[3]).toMatchObject({
    finalUrl: urls[3],
    error: "Content request failed (HTTP 503).",
    content: "",
    totalChars: 0,
  });
  expect(items[4]).toMatchObject({
    finalUrl: urls[4],
    title: "",
    content: "# Guide\n\nRaw **Markdown**.\n",
    error: null,
    totalChars: 27,
    nextOffset: null,
  });
  expect(pages.requests).toHaveLength(5);
});

it("rejects HTTP URLs without an authority before sending content requests", async () => {
  const agent = await setup();
  pages.pages.set("/text", { body: "Readable", headers: { "Content-Type": "text/plain" } });
  const url = `${pages.endpoint.replace("://", ":")}/text`;
  expect(await read(agent, { url })).toEqual([
    {
      url,
      finalUrl: null,
      title: "",
      content: "",
      error: "Content URL must be an absolute HTTP(S) URL.",
      totalChars: 0,
      nextOffset: null,
    },
  ]);
  expect(pages.requests).toEqual([]);
});

it("paginates Unicode code points, refetches continuations, and retains total length beyond the end", async () => {
  const agent = await setup();
  pages.pages.set("/unicode", { body: "A😀中🚀B", headers: { "Content-Type": "text/plain" } });
  const url = `${pages.endpoint}/unicode`;
  expect(await read(agent, { url, limit: 2 })).toEqual([
    { url, finalUrl: url, title: "", content: "A😀", error: null, totalChars: 5, nextOffset: 2 },
  ]);
  expect(await read(agent, { urls: [url], offset: 2, limit: 2 })).toEqual([
    { url, finalUrl: url, title: "", content: "中🚀", error: null, totalChars: 5, nextOffset: 4 },
  ]);
  expect(await read(agent, { url, offset: 4, limit: 2 })).toEqual([
    { url, finalUrl: url, title: "", content: "B", error: null, totalChars: 5, nextOffset: null },
  ]);
  for (const offset of [5, 10])
    expect(await read(agent, { url, offset })).toEqual([
      { url, finalUrl: url, title: "", content: "", error: null, totalChars: 5, nextOffset: null },
    ]);
  pages.pages.set("/unicode", { body: "Changed", headers: { "Content-Type": "text/plain" } });
  expect((await read(agent, { url, offset: 2, limit: 2 }))[0]).toMatchObject({
    content: "an",
    totalChars: 7,
    nextOffset: 4,
  });
  expect(pages.requests).toEqual(Array(6).fill("/unicode"));
});

it("runs three content requests concurrently, fills freed slots, and preserves input order", async () => {
  const agent = await setup();
  pages.server.removeAllListeners("request");
  const held = new Map<string, ServerResponse>();
  let active = 0;
  let maximum = 0;
  pages.server.on("request", (request, response) => {
    const path = request.url ?? "";
    pages.requests.push(path);
    active++;
    maximum = Math.max(maximum, active);
    response.once("finish", () => active--);
    response.writeHead(200, { "Content-Type": "text/plain" });
    if (path === "/4" || path === "/5") response.end(path);
    else held.set(path, response);
    if (held.size === 3) pages.server.emit("batch-ready");
    if (path === "/5") pages.server.emit("queue-drained");
  });
  const ready = once(pages.server, "batch-ready", { signal: AbortSignal.timeout(2_000) });
  const drained = once(pages.server, "queue-drained", { signal: AbortSignal.timeout(2_000) });
  drained.catch(() => {});
  const urls = [1, 2, 3, 4, 5].map((n) => `${pages.endpoint}/${n}`);
  const controller = new AbortController();
  const result = read(agent, { urls }, controller.signal);
  result.catch(() => {});
  try {
    await ready;
    expect(pages.requests).toEqual(["/1", "/2", "/3"]);
    held.get("/3")?.end("/3");
    await drained;
    expect(pages.requests).toEqual(["/1", "/2", "/3", "/4", "/5"]);
    held.get("/2")?.end("/2");
    held.get("/1")?.end("/1");
    expect((await result).map((item) => item.content)).toEqual(["/1", "/2", "/3", "/4", "/5"]);
    expect(maximum).toBe(3);
  } finally {
    controller.abort();
    for (const [path, response] of held) response.end(path);
    await result.catch(() => {});
  }
});

it.each([false, true])(
  "rejects an oversized streamed decoded body and closes its connection (gzip: %s)",
  async (compressed) => {
    const agent = await setup();
    pages.server.removeAllListeners("request");
    const disconnected = new Promise<void>((resolve) => {
      pages.server.on("request", (_request, response) => {
        response.once("close", resolve);
        response.writeHead(200, {
          "Content-Type": "text/plain",
          ...(compressed ? { "Content-Encoding": "gzip" } : {}),
        });
        const body = "é".repeat(2_621_441);
        response.write(compressed ? gzipSync(body) : body);
        // Leave the stream open: rejecting its size must cancel body consumption.
      });
    });
    const url = `${pages.endpoint}/large`;
    const controller = new AbortController();
    try {
      const [item] = await read(
        agent,
        { url },
        AbortSignal.any([controller.signal, AbortSignal.timeout(2_000)]),
      );
      expect(item).toEqual({
        url,
        finalUrl: url,
        title: "",
        content: "",
        error: "Content response exceeds 5 MiB.",
        totalChars: 0,
        nextOffset: null,
      });
      await disconnected;
    } finally {
      controller.abort();
    }
  },
  10_000,
);

it("times out a stalled response body after 30 seconds, closes it, and continues the Agent", async () => {
  const agent = await setup();
  pages.server.removeAllListeners("request");
  const disconnected = new Promise<void>((resolve) => {
    pages.server.on("request", (_request, response) => {
      response.once("close", resolve);
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.write("Still loading");
    });
  });
  const url = `${pages.endpoint}/stall`;
  const started = performance.now();
  const [item] = await read(agent, { url }, AbortSignal.timeout(33_000));
  expect(performance.now() - started).toBeGreaterThanOrEqual(29_000);
  expect(performance.now() - started).toBeLessThan(32_000);
  expect(item).toEqual({
    url,
    finalUrl: url,
    title: "",
    content: "",
    error: "Content request timed out after 30 seconds.",
    totalChars: 0,
    nextOffset: null,
  });
  await disconnected;
}, 36_000);

it("cancels all three active body reads, never starts queued URLs, and records cancellation without model continuation", async () => {
  const agent = await setup();
  pages.server.removeAllListeners("request");
  const controller = new AbortController();
  let closed = 0;
  const disconnected = once(pages.server, "all-closed", { signal: AbortSignal.timeout(2_000) });
  disconnected.catch(() => {});
  pages.server.on("request", (request, response) => {
    pages.requests.push(request.url ?? "");
    response.once("close", () => {
      if (++closed === 3) pages.server.emit("all-closed");
    });
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.write("Pending body");
    if (pages.requests.length === 3) controller.abort(new Error("Cancelled by user."));
  });
  model.responses.push({
    status: 200,
    body: toolReply([
      {
        name: "fetch_content",
        id: "cancelled",
        args: { urls: [1, 2, 3, 4, 5].map((n) => `${pages.endpoint}/${n}`) },
      },
    ]),
  });
  await expect(agent.chat("Read this batch", controller.signal)).rejects.toThrow(/cancelled/i);
  await disconnected;
  expect(pages.requests).toEqual(["/1", "/2", "/3"]);
  expect(model.requests).toHaveLength(1);
  const history = await ConversationHistory.open(agent.config.history_path);
  expect((await history.getMessages(agent.sessionId)).at(-1)).toMatchObject({
    role: "tool",
    tool_call_id: "cancelled",
    content: "Error executing tool: Cancelled by user.",
  });
});

it.each(["text/plain", "text/markdown", "text/html"])(
  "decodes %s according to the response charset",
  async (type) => {
    const agent = await setup();
    const body = type === "text/html" ? "<title>Café</title><p>Café guide.</p>" : "Café guide.";
    pages.pages.set("/encoded", {
      body: Buffer.from(body, "latin1"),
      headers: { "Content-Type": `${type}; charset=windows-1252` },
    });
    const url = `${pages.endpoint}/encoded`;
    expect((await read(agent, { url }))[0]).toMatchObject({
      title: type === "text/html" ? "Café" : "",
      content: "Café guide.",
      totalChars: 11,
      error: null,
    });
  },
);

it.each([undefined, "fetch_content: null\n"])(
  "omits fetch_content when unconfigured",
  async (settings) => {
    model = await chatFixture();
    const agent = await Agent.open({ workspace: await model.workspace(undefined, settings) });
    await agent.chat("Hello");
    expect(model.requests[0].tools.map((tool) => tool.function.name)).not.toContain(
      "fetch_content",
    );
  },
);

it.each(["fetch_content: []\n", "fetch_content:\n  provider: playwright\n"])(
  "rejects unsupported fetch_content configuration before calling the model",
  async (settings) => {
    model = await chatFixture();
    await expect(
      Agent.open({ workspace: await model.workspace(undefined, settings) }),
    ).rejects.toThrow();
    expect(model.requests).toHaveLength(0);
  },
);

it.each([undefined, 20_000])("enforces the content output bound with limit %s", async (limit) => {
  const agent = await setup();
  pages.pages.set("/long", {
    body: "😀".repeat(20_001),
    headers: { "Content-Type": "text/plain" },
  });
  const [item] = await read(agent, {
    url: `${pages.endpoint}/long`,
    ...(limit === undefined ? {} : { limit }),
  });
  expect(item.content).toHaveLength((limit ?? 10_000) * 2);
  expect(new Set(Array.from(item.content))).toEqual(new Set(["😀"]));
  expect(item).toMatchObject({ totalChars: 20_001, nextOffset: limit ?? 10_000, error: null });
});

it("accepts a body exactly at 5 MiB and returns the final character without losing total length", async () => {
  const agent = await setup();
  pages.pages.set("/boundary", {
    body: `${"x".repeat(5_242_879)}Z`,
    headers: { "Content-Type": "text/plain" },
  });
  const [item] = await read(agent, {
    url: `${pages.endpoint}/boundary`,
    offset: 5_242_879,
    limit: 1,
  });
  expect(item).toMatchObject({
    content: "Z",
    totalChars: 5_242_880,
    nextOffset: null,
    error: null,
  });
});

it.each(["not a URL", "", "ftp://example.test/page"])(
  "returns a non-HTTP URL as an item error without requesting a service: %s",
  async (url) => {
    const agent = await setup();
    expect(await read(agent, { url })).toEqual([
      {
        url,
        finalUrl: null,
        title: "",
        content: "",
        error: "Content URL must be an absolute HTTP(S) URL.",
        totalChars: 0,
        nextOffset: null,
      },
    ]);
    expect(pages.requests).toEqual([]);
  },
);

it("returns a connection failure with no final URL and permits the Agent to continue", async () => {
  const agent = await setup();
  const url = `${pages.endpoint}/offline`;
  await new Promise<void>((resolve, reject) =>
    pages.server.close((error) => (error ? reject(error) : resolve())),
  );
  const [item] = await read(agent, { url });
  expect(item).toMatchObject({
    url,
    finalUrl: null,
    title: "",
    content: "",
    totalChars: 0,
    nextOffset: null,
  });
  expect(item.error).toMatch(/fetch failed/i);
});

it.each(["http", "unsupported"])(
  "rejects a %s response before reading its stalled body and closes the connection",
  async (failure) => {
    const agent = await setup();
    pages.server.removeAllListeners("request");
    const disconnected = new Promise<void>((resolve) => {
      pages.server.on("request", (_request, response) => {
        response.once("close", resolve);
        response.writeHead(failure === "http" ? 503 : 200, {
          "Content-Type": failure === "http" ? "text/plain" : "application/json",
        });
        response.write("Do not read this stalled body");
      });
    });
    const [item] = await read(
      agent,
      { url: `${pages.endpoint}/rejected` },
      AbortSignal.timeout(2_000),
    );
    expect(item).toMatchObject({
      error:
        failure === "http"
          ? "Content request failed (HTTP 503)."
          : "Unsupported content type: application/json.",
      content: "",
      title: "",
      totalChars: 0,
      nextOffset: null,
    });
    await disconnected;
  },
);

it("reads an article containing styled MathML without treating its nodes as HTML elements", async () => {
  const agent = await setup();
  pages.pages.set("/math", {
    body: '<title>Math guide</title><article><p>Read this equation carefully.</p><math style="display: block"><mi>x</mi><mo>=</mo><mn>42</mn></math><math style="display: none"><mi>secret</mi></math><p>Continue with the guide.</p></article>',
  });
  const [item] = await read(agent, { url: `${pages.endpoint}/math` });
  expect(item).toMatchObject({ title: "Math guide", error: null });
  expect(item.content).toContain("Read this equation carefully.");
  expect(item.content).toContain("x\\=42");
  expect(item.content).not.toContain("secret");
});
