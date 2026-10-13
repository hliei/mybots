import { once } from "node:events";
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { chatFixture } from "./chat-fixture.ts";

let fixture: Awaited<ReturnType<typeof chatFixture>> | undefined;
afterEach(async () => {
  const current = fixture;
  fixture = undefined;
  await current?.close();
});

it("uses workspace defaults and Agent instructions for a DeepSeek reply", async () => {
  fixture = await chatFixture();
  const agent = await fixture.openAgent({ workspace: await fixture.workspace() });
  expect(await agent.chat("Hello")).toBe("Hello!");
  expect(fixture.requests[0]).toMatchObject({
    model: "deepseek-flash",
    thinking: { type: "enabled" },
    stream: false,
    temperature: 0.7,
    max_tokens: 2048,
    messages: [
      { role: "system", content: "Give concise answers." },
      { role: "user", content: "Hello" },
    ],
  });
});

it("continues a session with the earlier user reply and complete reasoning", async () => {
  fixture = await chatFixture();
  const agent = await fixture.openAgent({ workspace: await fixture.workspace() });
  await agent.chat("Remember Alice");
  await agent.chat("Who did I mention?");
  expect(fixture.requests[1].messages).toEqual([
    { role: "system", content: "Give concise answers." },
    { role: "user", content: "Remember Alice" },
    { role: "assistant", content: "Hello!", reasoning_content: "Full reasoning." },
    { role: "user", content: "Who did I mention?" },
  ]);
});

it("selects another Agent and merges all model overrides with workspace settings", async () => {
  fixture = await chatFixture();
  const path = await fixture.workspace();
  await mkdir(join(path, ".agents", "bots", "other"));
  await writeFile(
    join(path, ".agents", "bots", "other", "AGENT.md"),
    `---\nname: Other\ndescription: Another assistant\nallow_skills: true\nllm:\n  model: custom-model\n  thinking: false\n  temperature: 1.2\n  max_tokens: 4096\n---\nOther instructions.`,
  );
  const agent = await fixture.openAgent({ workspace: path, agent: "other" });
  await agent.chat("Hello");
  expect(agent.definition).toMatchObject({
    id: "other",
    name: "Other",
    description: "Another assistant",
    allow_skills: true,
  });
  expect(agent.config).toMatchObject({
    agents_path: join(path, ".agents", "bots"),
    skills_path: join(path, ".agents", "skills"),
    history_path: join(path, ".history"),
  });
  expect(fixture.requests[0]).toMatchObject({
    model: "custom-model",
    thinking: { type: "disabled" },
    temperature: 1.2,
    max_tokens: 4096,
    messages: [
      { role: "system", content: "Other instructions." },
      { role: "user", content: "Hello" },
    ],
  });
});

it.each([
  ["  thinking: false\n", "", "disabled"],
  ["  thinking: false\n", "llm:\n  thinking: true\n", "enabled"],
])("honors Workspace and Agent thinking settings %s %s", async (settings, metadata, expected) => {
  fixture = await chatFixture();
  const agent = await fixture.openAgent({
    workspace: await fixture.workspace(fixture.root, settings, metadata),
  });
  await agent.chat("Hello");
  expect(fixture.requests[0].thinking.type).toBe(expected);
});

it("starts a fresh Agent session without reasoning invented for a plain response", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  const first = await fixture.openAgent({ workspace });
  fixture.responses.push({
    status: 200,
    body: { choices: [{ message: { role: "assistant", content: "Plain reply" } }] },
  });
  await first.chat("One");
  await first.chat("Two");
  expect(fixture.requests[1].messages[2]).toEqual({ role: "assistant", content: "Plain reply" });
  const second = await fixture.openAgent({ workspace });
  expect(second.sessionId).not.toBe(first.sessionId);
  await second.chat("Fresh");
  expect(fixture.requests[2].messages).toHaveLength(2);
});

it("preserves successful conversation when a provider request fails", async () => {
  fixture = await chatFixture();
  const agent = await fixture.openAgent({ workspace: await fixture.workspace() });
  await agent.chat("First");
  fixture.responses.push({ status: 401, body: { error: { message: "Invalid test key" } } });
  await expect(agent.chat("Failed turn")).rejects.toThrow("DeepSeek request failed (HTTP 401).");
  await agent.chat("Try again");
  expect(fixture.requests[2].messages.map((message) => message.content)).toEqual([
    "Give concise answers.",
    "First",
    "Hello!",
    "Try again",
  ]);
});

it("accepts an empty optional Agent description", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace(fixture.root, "", 'description: ""\n');
  const agent = await fixture.openAgent({ workspace });
  expect(agent.definition.description).toBe("");
});

it.each(["brave", "serpapi"])("loads explicit %s web search configuration", async (provider) => {
  fixture = await chatFixture();
  const agent = await fixture.openAgent({
    workspace: await fixture.workspace(
      undefined,
      `web_search:\n  provider: ${provider}\n  api_key: offline-web-key\n  api_base: ${fixture.endpoint}/search\nfetch_content: {}\n`,
    ),
  });
  expect(agent.config).toMatchObject({
    web_search: { provider, api_key: "offline-web-key", api_base: `${fixture.endpoint}/search` },
    fetch_content: {},
  });
  expect(fixture.requests).toHaveLength(0);
});

it.each([
  "websearch: null\n",
  "webread: {}\n",
  "websearch: {}\nweb_search:\n  provider: brave\n  api_key: test\n",
  "webread: null\nfetch_content: {}\n",
])("rejects legacy web configuration with migration instructions: %s", async (settings) => {
  fixture = await chatFixture();
  await expect(
    fixture.openAgent({ workspace: await fixture.workspace(undefined, settings) }),
  ).rejects.toThrow(/Migrate websearch to web_search.*replace webread with fetch_content: \{\}/);
  expect(fixture.requests).toHaveLength(0);
});

it.each([
  ["web_search: {}\n", "web_search.provider"],
  ["web_search: []\n", "web_search must be a mapping"],
  ["web_search:\n  api_key: test\n", "web_search.provider"],
  ["web_search:\n  provider: other\n  api_key: test\n", "web_search.provider"],
  ["web_search:\n  provider: brave\n", "web_search.api_key"],
  ["web_search:\n  provider: brave\n  api_key: 123\n", "web_search.api_key"],
  ["web_search:\n  provider: serpapi\n  api_key: '  '\n", "web_search.api_key"],
  ["web_search:\n  provider: brave\n  api_key: test\n  api_base: /search\n", "web_search.api_base"],
  [
    "web_search:\n  provider: brave\n  api_key: test\n  api_base: http:search\n",
    "web_search.api_base",
  ],
  [
    "web_search:\n  provider: serpapi\n  api_key: test\n  api_base: file:///tmp/search\n",
    "web_search.api_base",
  ],
  ["fetch_content: []\n", "fetch_content must be a mapping"],
  ["fetch_content:\n  provider: crawl4ai\n", "fetch_content must be an empty mapping"],
])("rejects invalid replacement settings: %s", async (settings, error) => {
  fixture = await chatFixture();
  await expect(
    fixture.openAgent({ workspace: await fixture.workspace(undefined, settings) }),
  ).rejects.toThrow(error);
  expect(fixture.requests).toHaveLength(0);
});

it.each([
  ["  thinking: 'false'\n", "llm.thinking must be a boolean"],
  ["  temperature: 3\n", "llm.temperature must be between 0 and 2"],
  ["  max_tokens: 0\n", "llm.max_tokens must be a positive integer"],
  ["  provider: other\n", "Only the deepseek provider is supported"],
])("rejects invalid settings before contacting the provider %s", async (settings, error) => {
  fixture = await chatFixture();
  await expect(
    fixture.openAgent({ workspace: await fixture.workspace(fixture.root, settings) }),
  ).rejects.toThrow(error);
  expect(fixture.requests).toHaveLength(0);
});

it("loads custom Workspace paths and preserves optional web settings", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  await rename(join(workspace, ".agents", "bots"), join(workspace, "definitions"));
  await appendFile(
    join(workspace, "config.user.yaml"),
    "agents_path: definitions\nskills_path: abilities\nhistory_path: logs\nweb_search:\n  provider: brave\n  api_key: offline-web-key\nfetch_content: {}\n",
  );
  const agent = await fixture.openAgent({ workspace });
  expect(agent.config).toMatchObject({
    agents_path: join(workspace, "definitions"),
    skills_path: join(workspace, "abilities"),
    history_path: join(workspace, "logs"),
    web_search: { provider: "brave", api_key: "offline-web-key" },
    fetch_content: {},
  });
  expect(await agent.chat("Hi")).toBe("Hello!");
});

it("rejects unusable provider replies without adding them to the next request", async () => {
  fixture = await chatFixture();
  const agent = await fixture.openAgent({ workspace: await fixture.workspace() });
  fixture.responses.push({ status: 200, body: { choices: [] } });
  await expect(agent.chat("Lost")).rejects.toThrow("DeepSeek returned no text reply");
  await agent.chat("Next");
  expect(fixture.requests[1].messages).toHaveLength(2);
});

it("cancels a provider request without contacting a live service", async () => {
  fixture = await chatFixture();
  const agent = await fixture.openAgent({ workspace: await fixture.workspace() });
  await expect(agent.chat("Cancelled", AbortSignal.abort())).rejects.toThrow(
    "DeepSeek request cancelled",
  );
  expect(fixture.requests).toHaveLength(0);
});

it("uses Agent-level credentials and endpoint overrides for Chat Completions", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace(
    fixture.root,
    "",
    `llm:\n  api_key: agent-test-key\n  api_base: ${fixture.endpoint}/custom\n`,
  );
  const agent = await fixture.openAgent({ workspace });
  await agent.chat("Hello");
  expect(fixture.transports[0]).toEqual({
    path: "/v1/custom/chat/completions",
    authorization: "Bearer agent-test-key",
  });
});

it("rejects overlapping calls in one session and preserves the completed turn", async () => {
  fixture = await chatFixture();
  const agent = await fixture.openAgent({ workspace: await fixture.workspace() });
  let release!: (value: unknown) => void;
  const body = new Promise<unknown>((resolve) => {
    release = resolve;
  });
  fixture.responses.push({ status: 200, body });
  const received = once(fixture.server, "request");
  const first = agent.chat("First");
  try {
    await received;
    await expect(agent.chat("Overlap")).rejects.toThrow("An Agent reply is already in progress.");
  } finally {
    release({ choices: [{ message: { role: "assistant", content: "First reply" } }] });
    await first;
  }
  await agent.chat("Next");
  expect(fixture.requests[1].messages).toEqual([
    { role: "system", content: "Give concise answers." },
    { role: "user", content: "First" },
    { role: "assistant", content: "First reply" },
    { role: "user", content: "Next" },
  ]);
});
