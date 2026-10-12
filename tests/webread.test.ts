import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { Agent } from "../src/core/agent.ts";
import { ConversationHistory } from "../src/core/history.ts";
import { chatFixture, toolReply } from "./chat-fixture.ts";
import { pageFixture } from "./page-fixture.ts";

let model: Awaited<ReturnType<typeof chatFixture>> | undefined;
let pages: Awaited<ReturnType<typeof pageFixture>> | undefined;
afterEach(async () => {
  await pages?.close();
  await model?.close();
  pages = undefined;
  model = undefined;
});

it("reads a real page as Markdown through the Agent and continues with the matching result", async () => {
  model = await chatFixture();
  pages = await pageFixture();
  pages.pages.set("/static", {
    body: '<title>Local guide</title><h1>Guide</h1><p>Read <strong>carefully</strong>.</p><p><a href="/next">Next page</a></p>',
  });
  const agent = await Agent.open({
    workspace: await model.workspace(undefined, "fetch_content: {}\n"),
  });
  model.responses.push({
    status: 200,
    body: toolReply(
      [{ name: "fetch_content", id: "read-page", args: { url: `${pages.endpoint}/static` } }],
      "Read this source.",
    ),
  });
  expect(await agent.chat("Read the guide")).toBe("Hello!");
  expect(model.requests[1].messages.at(-1)).toEqual({
    role: "tool",
    tool_call_id: "read-page",
    content: `**Local guide**\n\n# Guide\n\nRead **carefully**.\n\n[Next page](${pages.endpoint}/next)`,
  });
  expect(model.requests[1].messages.at(-2)?.reasoning_content).toBe("Read this source.");
  expect(
    model.requests[0].tools.find((tool) => tool.function.name === "fetch_content")?.function,
  ).toMatchObject({
    parameters: {
      required: [],
      properties: { url: { type: "string", description: "The URL to read" } },
    },
  });
  expect(pages.requests).toContain("/static");
});

it("includes fetched client-side content and excludes hidden and executable markup", async () => {
  model = await chatFixture();
  pages = await pageFixture();
  pages.pages.set("/rendered", {
    body: `<title>Loading</title><style>.secret { display: none; }</style>
    <p class="secret">CSS hidden</p><p hidden>HTML hidden</p><div id="article">Loading</div>
    <script>fetch('/data').then(r => r.json()).then(data => {
      document.title = data.title;
      document.getElementById('article').innerHTML = '<h2>Rendered</h2><ul><li>Client content</li></ul><pre><code class="language-js">const answer = 42;</code></pre>';
    });</script><noscript>JavaScript disabled</noscript>`,
  });
  pages.pages.set("/data", {
    body: JSON.stringify({ title: "Rendered guide" }),
    headers: { "Content-Type": "application/json" },
  });
  const agent = await Agent.open({
    workspace: await model.workspace(undefined, "fetch_content: {}\n"),
  });
  model.responses.push({
    status: 200,
    body: toolReply([
      { name: "fetch_content", id: "rendered", args: { url: `${pages.endpoint}/rendered` } },
    ]),
  });
  expect(await agent.chat("Read the rendered page")).toBe("Hello!");
  expect(model.requests[1].messages.at(-1)?.content).toBe(
    "**Rendered guide**\n\n## Rendered\n\n-   Client content\n\n```js\nconst answer = 42;\n```",
  );
  expect(pages.requests).toContain("/data");
});

it("follows a redirect while keeping the requested URL in saved tool-call arguments", async () => {
  model = await chatFixture();
  pages = await pageFixture();
  pages.pages.set("/redirect", { status: 302, headers: { Location: "/final" }, body: "" });
  pages.pages.set("/final", { body: "<title>Final page</title><p>Redirect destination.</p>" });
  const requested = `${pages.endpoint}/redirect`;
  const agent = await Agent.open({
    workspace: await model.workspace(undefined, "fetch_content: {}\n"),
  });
  model.responses.push({
    status: 200,
    body: toolReply([{ name: "fetch_content", id: "redirect", args: { url: requested } }]),
  });
  await agent.chat("Read this URL");
  expect(model.requests[1].messages.at(-1)?.content).toBe(
    "**Final page**\n\nRedirect destination.",
  );
  const history = await ConversationHistory.open(agent.config.history_path);
  expect((await history.getMessages(agent.sessionId))[1].tool_calls?.[0].function.arguments).toBe(
    JSON.stringify({ url: requested }),
  );
  expect(pages.requests).toEqual(expect.arrayContaining(["/redirect", "/final"]));
});

it.each([404, 503])(
  "returns HTTP %s using the reference error format and original redirected URL",
  async (status) => {
    model = await chatFixture();
    pages = await pageFixture();
    pages.pages.set("/redirect", { status: 302, headers: { Location: "/failure" }, body: "" });
    pages.pages.set("/failure", {
      status,
      body: "<title>Error page</title><p>Do not return this content.</p>",
    });
    const url = `${pages.endpoint}/redirect`;
    const agent = await Agent.open({
      workspace: await model.workspace(undefined, "fetch_content: {}\n"),
    });
    model.responses.push({
      status: 200,
      body: toolReply([{ name: "fetch_content", id: "failure", args: { url } }]),
    });
    expect(await agent.chat("Read this URL")).toBe("Hello!");
    expect(model.requests[1].messages.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "failure",
      content: `Error reading ${url}: Page request failed (HTTP ${status}).`,
    });
  },
);

it.each(["not a URL", "file:///tmp/page.html"])(
  "returns invalid page URLs as reference tool errors",
  async (url) => {
    model = await chatFixture();
    const agent = await Agent.open({
      workspace: await model.workspace(undefined, "fetch_content: {}\n"),
    });
    model.responses.push({
      status: 200,
      body: toolReply([{ name: "fetch_content", id: "invalid", args: { url } }]),
    });
    expect(await agent.chat("Read this URL")).toBe("Hello!");
    expect(model.requests[1].messages.at(-1)?.content).toMatch(
      new RegExp(`^Error reading ${url}:`),
    );
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

it("returns a connection failure to the model instead of page content", async () => {
  model = await chatFixture();
  pages = await pageFixture();
  const url = `${pages.endpoint}/closed`;
  await pages.close();
  pages = undefined;
  const agent = await Agent.open({
    workspace: await model.workspace(undefined, "fetch_content: {}\n"),
  });
  model.responses.push({
    status: 200,
    body: toolReply([{ name: "fetch_content", id: "offline", args: { url } }]),
  });
  expect(await agent.chat("Read this URL")).toBe("Hello!");
  expect(model.requests[1].messages.at(-1)?.content).toContain(`Error reading ${url}:`);
});

it("closes the browser's live page connection after a successful read", async () => {
  model = await chatFixture();
  pages = await pageFixture();
  const disconnected = new Promise<void>((resolve) => {
    pages?.server.on("upgrade", (request, socket) => {
      socket.on("error", () => socket.destroy());
      const key = request.headers["sec-websocket-key"];
      const accept = createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      socket.once("close", resolve);
      socket.on("data", () => socket.end(Buffer.from([0x88, 0x00])));
    });
  });
  pages.pages.set("/live", {
    body: '<title>Connecting</title><p>Connected page.</p><script>const ws = new WebSocket("ws://" + location.host + "/socket"); ws.onopen = () => document.title = "Connected";</script>',
  });
  const agent = await Agent.open({
    workspace: await model.workspace(undefined, "fetch_content: {}\n"),
  });
  model.responses.push({
    status: 200,
    body: toolReply([
      { name: "fetch_content", id: "live", args: { url: `${pages.endpoint}/live` } },
    ]),
  });
  await agent.chat("Read this URL");
  expect(model.requests[1].messages.at(-1)?.content).toBe("**Connected**\n\nConnected page.");
  await disconnected;
}, 10_000);

it("times out a stalled page within 30 seconds, closes the connection, and continues", async () => {
  model = await chatFixture();
  pages = await pageFixture();
  pages.server.removeAllListeners("request");
  let disconnected: Promise<void> | undefined;
  pages.server.on("request", (_request, response) => {
    disconnected = new Promise<void>((resolve) => response.once("close", resolve));
    response.writeHead(200, { "Content-Type": "text/html" });
    response.write("<title>Still loading</title>");
  });
  const url = `${pages.endpoint}/stall`;
  const agent = await Agent.open({
    workspace: await model.workspace(undefined, "fetch_content: {}\n"),
  });
  model.responses.push({
    status: 200,
    body: toolReply([{ name: "fetch_content", id: "timeout", args: { url } }]),
  });
  const start = performance.now();
  expect(await agent.chat("Read this URL")).toBe("Hello!");
  expect(performance.now() - start).toBeGreaterThanOrEqual(29_000);
  expect(performance.now() - start).toBeLessThan(36_000);
  expect(model.requests[1].messages.at(-1)?.content).toBe(
    `Error reading ${url}: Page read timed out after 30 seconds.`,
  );
  await disconnected;
}, 40_000);

it("cancels a pending page read, closes the connection, and saves its tool error", async () => {
  model = await chatFixture();
  pages = await pageFixture();
  pages.server.removeAllListeners("request");
  const controller = new AbortController();
  let disconnected: Promise<void> | undefined;
  pages.server.on("request", (_request, response) => {
    disconnected = new Promise<void>((resolve) => response.once("close", resolve));
    controller.abort(new Error("Cancelled by user."));
  });
  const url = `${pages.endpoint}/stall`;
  const agent = await Agent.open({
    workspace: await model.workspace(undefined, "fetch_content: {}\n"),
  });
  model.responses.push({
    status: 200,
    body: toolReply([{ name: "fetch_content", id: "cancelled", args: { url } }]),
  });
  await expect(agent.chat("Read this URL", controller.signal)).rejects.toThrow();
  await disconnected;
  const history = await ConversationHistory.open(agent.config.history_path);
  expect((await history.getMessages(agent.sessionId)).at(-1)).toMatchObject({
    role: "tool",
    tool_call_id: "cancelled",
    content: `Error reading ${url}: Cancelled by user.`,
  });
  expect(model.requests).toHaveLength(1);
}, 10_000);
