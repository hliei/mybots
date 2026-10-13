import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { WorkspaceConfiguration } from "../src/config/reload.ts";
import { Agent } from "../src/core/agent.ts";
import { chatFixture, toolReply } from "./chat-fixture.ts";
import { searchFixture } from "./search-fixture.ts";

let fixture: Awaited<ReturnType<typeof chatFixture>>;
const agents: Agent[] = [];
const configurations: WorkspaceConfiguration[] = [];
async function openAgent(options: Parameters<typeof Agent.open>[0]) {
  const agent = await Agent.open(options);
  agents.push(agent);
  return agent;
}
async function openConfiguration(workspace: string) {
  const configuration = await WorkspaceConfiguration.open(workspace);
  configurations.push(configuration);
  return configuration;
}
afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
  await Promise.all(configurations.splice(0).map((configuration) => configuration.stop()));
  await fixture?.close();
});

it("recursively overlays runtime model settings without removing user credentials", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace(undefined, "  temperature: 0.4\n");
  await writeFile(join(workspace, "config.runtime.yaml"), "llm:\n  model: runtime-model\n");
  const agent = await openAgent({ workspace });
  await agent.chat("Hello");
  expect(fixture.requests[0]).toMatchObject({ model: "runtime-model", temperature: 0.4 });
  expect(fixture.transports[0].authorization).toBe("Bearer offline-test-key");
});

it("keeps a turn snapshot then applies model, tools and Agent edits without losing reasoning", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  const agent = await openAgent({ workspace });
  let release!: (body: unknown) => void;
  const response = new Promise((resolve) => {
    release = resolve;
  });
  fixture.responses.push({ status: 200, body: response });
  const turn = agent.chat("Remember Alice");
  await expect.poll(() => fixture.requests.length).toBe(1);
  await writeFile(
    join(workspace, "config.runtime.yaml"),
    "llm:\n  model: next-model\nweb_search:\n  provider: brave\n  api_key: offline-web-key\nfetch_content: {}\n",
  );
  await writeFile(
    join(workspace, ".agents/bots/helper/AGENT.md"),
    "---\nname: Updated helper\n---\nNew instructions.",
  );
  release({
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          reasoning_content: "Original reasoning.",
          tool_calls: [
            {
              id: "read-call",
              type: "function",
              function: {
                name: "read",
                arguments: JSON.stringify({ path: join(workspace, "config.runtime.yaml") }),
              },
            },
          ],
        },
      },
    ],
  });
  await turn;
  expect(fixture.requests[1].model).toBe("deepseek-flash");
  expect(fixture.requests[1].messages[0].content).toBe("Give concise answers.");
  expect(fixture.requests[1].tools.map((tool) => tool.function.name)).not.toContain("web_search");
  await agent.chat("Who did I mention?");
  expect({
    model: fixture.requests[2].model,
    messages: fixture.requests[2].messages.slice(0, 3),
  }).toMatchObject({
    model: "next-model",
    messages: [
      { role: "system", content: "New instructions." },
      { role: "user", content: "Remember Alice" },
      { role: "assistant", reasoning_content: "Original reasoning." },
    ],
  });
  expect(fixture.requests[2].tools.map((tool) => tool.function.name)).toEqual(
    expect.arrayContaining(["web_search", "fetch_content"]),
  );
  expect(agent.definition.name).toBe("Updated helper");
});

it("loads disabled connection defaults and validates selected runtime fields before model use", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  const agent = await openAgent({ workspace });
  expect(agent.config).toMatchObject({
    channels: { enabled: false },
    api: { enabled: false, host: "127.0.0.1", port: 8000 },
    sources: {},
    default_delivery_source: null,
    logging_path: join(workspace, ".logs"),
    event_path: join(workspace, ".event"),
  });
  await writeFile(
    join(workspace, "config.runtime.yaml"),
    "channels:\n  enabled: true\n  telegram:\n    enabled: true\n    bot_token: offline-token\n    allowed_user_ids: ['123']\napi:\n  enabled: true\n  port: 9000\nsources:\n  'telegram:123:456':\n    session_id: saved-session\ndefault_delivery_source: 'telegram:123:456'\n",
  );
  const configured = await openAgent({ workspace });
  expect(configured.config).toMatchObject({
    channels: {
      enabled: true,
      telegram: { enabled: true, bot_token: "offline-token", allowed_user_ids: ["123"] },
    },
    api: { enabled: true, port: 9000 },
    sources: { "telegram:123:456": { session_id: "saved-session" } },
    default_delivery_source: "telegram:123:456",
  });
});

it("retains the entire last valid turn configuration after malformed configuration or Agent edits", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  const agent = await openAgent({ workspace });
  await agent.chat("Remember Alice");
  for (const edit of [
    "llm: [",
    "llm:\n  model: should-not-apply\napi:\n  port: 0\n",
    "llm:\n  model: should-not-apply\nchannels:\n  telegram:\n    allowed_user_ids: [123]\n",
  ]) {
    await writeFile(join(workspace, "config.runtime.yaml"), edit);
    await agent.chat("Continue");
    expect(fixture.requests.at(-1)?.model).toBe("deepseek-flash");
  }
  await writeFile(join(workspace, "config.runtime.yaml"), "llm:\n  model: should-not-apply\n");
  await writeFile(
    join(workspace, ".agents/bots/helper/AGENT.md"),
    "---\nname: Broken\nallow_skills: invalid\n---\nChanged instructions.",
  );
  await agent.chat("Continue");
  expect(fixture.requests.at(-1)?.model).toBe("deepseek-flash");
  expect(fixture.requests.at(-1)?.messages[0].content).toBe("Give concise answers.");
});

it("applies live settings while keeping every active directory and connection at its startup value", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  const agent = await openAgent({ workspace });
  await mkdir(join(workspace, "new-agents/helper"), { recursive: true });
  await writeFile(
    join(workspace, "new-agents/helper/AGENT.md"),
    "---\nname: Replacement\n---\nRestart instructions.",
  );
  await writeFile(
    join(workspace, "config.runtime.yaml"),
    "llm:\n  model: next-model\nagents_path: new-agents\nskills_path: new-skills\nhistory_path: new-history\nlogging_path: new-logs\nevent_path: new-events\napi:\n  enabled: true\n  port: 9000\nchannels:\n  enabled: true\n  telegram:\n    enabled: true\n    bot_token: offline-token\n    allowed_user_ids: ['123']\n",
  );
  await agent.chat("Continue");
  expect(fixture.requests[0].model).toBe("next-model");
  expect(fixture.requests[0].messages[0].content).toBe("Give concise answers.");
  expect(agent.config).toMatchObject({
    agents_path: join(workspace, ".agents/bots"),
    skills_path: join(workspace, ".agents/skills"),
    history_path: join(workspace, ".history"),
    logging_path: join(workspace, ".logs"),
    event_path: join(workspace, ".event"),
    channels: { enabled: false },
    api: { enabled: false, port: 8000 },
  });
});

it("publishes serialized runtime updates immediately and preserves unknown extension fields", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  await writeFile(
    join(workspace, "config.runtime.yaml"),
    "extension:\n  retained: [one, two]\nsources:\n  existing:\n    session_id: first-session\n",
  );
  const configuration = await openConfiguration(workspace);
  await Promise.all([
    configuration.updateRuntime({ sources: { alpha: { session_id: "alpha-session" } } }),
    configuration.updateRuntime({ sources: { beta: { session_id: "beta-session" } } }),
  ]);
  expect(configuration.config.sources).toEqual({
    existing: { session_id: "first-session" },
    alpha: { session_id: "alpha-session" },
    beta: { session_id: "beta-session" },
  });
  const reopened = await openConfiguration(workspace);
  expect(reopened.config.sources).toEqual(configuration.config.sources);
  expect(parse(await readFile(join(workspace, "config.runtime.yaml"), "utf8"))).toMatchObject({
    extension: { retained: ["one", "two"] },
  });
});

it("observes atomic-save replacement and stops accepting reload work after shutdown", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  const configuration = await openConfiguration(workspace);
  configuration.startWatching();
  try {
    await writeFile(join(workspace, "replacement.yaml"), "llm:\n  model: observed-model\n");
    await rename(join(workspace, "replacement.yaml"), join(workspace, "config.runtime.yaml"));
    await expect
      .poll(() => configuration.config.llm.model, { timeout: 1000 })
      .toBe("observed-model");
  } finally {
    await configuration.stop();
  }
  await expect(configuration.reload()).rejects.toThrow("stopped");
});

it("keeps session ownership when default Agent changes and reads Skill content at load time", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace(undefined, "", "allow_skills: true\n");
  await fixture.writeSkill(
    "brief",
    "---\nname: Brief\ndescription: Brief answers\n---\nOriginal content.",
  );
  await mkdir(join(workspace, ".agents/bots/other"));
  await writeFile(
    join(workspace, ".agents/bots/other/AGENT.md"),
    "---\nname: Other\n---\nOther instructions.",
  );
  const configuration = await openConfiguration(workspace);
  const first = await openAgent({ configuration });
  let release!: (body: unknown) => void;
  fixture.responses.push({
    status: 200,
    body: new Promise((resolve) => {
      release = resolve;
    }),
  });
  const turn = first.chat("Load brief");
  await expect.poll(() => fixture.requests.length).toBe(1);
  await fixture.writeSkill(
    "brief",
    "---\nname: Brief\ndescription: Brief answers\n---\nNew content.",
  );
  await configuration.updateRuntime({ default_agent: "other" });
  release(toolReply([{ name: "skill", id: "skill-call", args: { skill_name: "brief" } }]));
  await turn;
  expect(fixture.requests[1].messages.at(-1)?.content).toBe("New content.");
  await first.chat("Continue");
  expect(first.definition.id).toBe("helper");
  expect(fixture.requests[2].messages[0].content).toBe("Give concise answers.");
  const second = await openAgent({ configuration });
  await second.chat("New session");
  expect(second.definition.id).toBe("other");
  expect(fixture.requests[3].messages).toEqual([
    { role: "system", content: "Other instructions." },
    { role: "user", content: "New session" },
  ]);
});

it("uses a web tool's original credentials during a turn and replacement credentials next turn", async () => {
  fixture = await chatFixture();
  const search = await searchFixture();
  try {
    const workspace = await fixture.workspace(undefined, search.settings);
    const agent = await openAgent({ workspace });
    let release!: (body: unknown) => void;
    fixture.responses.push({
      status: 200,
      body: new Promise((resolve) => {
        release = resolve;
      }),
    });
    const turn = agent.chat("Search");
    await expect.poll(() => fixture.requests.length).toBe(1);
    await writeFile(
      join(workspace, "config.runtime.yaml"),
      "web_search:\n  api_key: replacement-key\n",
    );
    release(toolReply([{ name: "web_search", id: "search-one", args: { query: "first" } }]));
    await turn;
    expect(search.requests[0].token).toBe("offline-search-key");
    fixture.responses.push({
      status: 200,
      body: toolReply([{ name: "web_search", id: "search-two", args: { query: "second" } }]),
    });
    await agent.chat("Search again");
    expect(search.requests[1].token).toBe("replacement-key");
    expect(fixture.requests[3].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reasoning_content: "Tool reasoning." }),
        expect.objectContaining({ role: "tool", tool_call_id: "search-one" }),
      ]),
    );
  } finally {
    await search.close();
  }
});

it.skipIf(process.platform === "win32")(
  "keeps memory and disk unchanged when persistence fails, then permits a later update",
  async () => {
    fixture = await chatFixture();
    const workspace = await fixture.workspace();
    const configuration = await openConfiguration(workspace);
    await configuration.updateRuntime({ sources: { first: { session_id: "first-session" } } });
    const saved = await readFile(join(workspace, "config.runtime.yaml"), "utf8");
    await chmod(workspace, 0o500);
    try {
      await expect(
        configuration.updateRuntime({ sources: { failed: { session_id: "failed-session" } } }),
      ).rejects.toThrow();
    } finally {
      await chmod(workspace, 0o700);
    }
    expect(configuration.config.sources).toEqual({ first: { session_id: "first-session" } });
    expect(await readFile(join(workspace, "config.runtime.yaml"), "utf8")).toBe(saved);
    await expect(configuration.updateRuntime({ api: { port: 0 } })).rejects.toThrow("api.port");
    await configuration.updateRuntime({ sources: { next: { session_id: "next-session" } } });
    expect(configuration.config.sources.next).toEqual({ session_id: "next-session" });
  },
);

it("reports latest restart requirements separately from resource settings and drains queued updates on stop", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  const configuration = await openConfiguration(workspace);
  const updating = configuration.updateRuntime({
    api: { enabled: true, host: "localhost", port: 9000 },
    history_path: "new-history",
    channels: { enabled: true },
  });
  const reload = configuration.reload();
  await configuration.stop();
  await updating;
  await reload;
  expect(configuration.config).toMatchObject({
    api: { enabled: true, host: "localhost", port: 9000 },
    history_path: join(workspace, "new-history"),
    channels: { enabled: true },
  });
  expect(configuration.activeConfig).toMatchObject({
    api: { enabled: false, host: "127.0.0.1", port: 8000 },
    history_path: join(workspace, ".history"),
    channels: { enabled: false },
  });
  expect(configuration.restartRequired).toEqual(["history_path", "channels", "api"]);
  await expect(configuration.updateRuntime({})).rejects.toThrow("stopped");
  await expect(configuration.snapshot()).rejects.toThrow("stopped");
  expect(() => configuration.startWatching()).toThrow("stopped");
  const observer = await openConfiguration(workspace);
  observer.startWatching();
  await writeFile(join(workspace, "config.runtime.yaml"), "llm:\n  model: after-stop\n");
  await expect.poll(() => observer.config.llm.model).toBe("after-stop");
  expect(configuration.config.llm.model).toBe("deepseek-flash");
});

it.each([
  ["api: null\n", "api must be a mapping"],
  ["api:\n  enabled: 'true'\n", "api.enabled"],
  ["api:\n  port: 65536\n", "api.port"],
  ["api:\n  port: 1.5\n", "api.port"],
  ["api:\n  host: ''\n", "api.host"],
  ["channels: []\n", "channels must be a mapping"],
  ["channels:\n  enabled: 1\n", "channels.enabled"],
  ["channels:\n  telegram:\n    enabled: true\n", "bot_token"],
  ["channels:\n  telegram:\n    bot_token: 123\n", "bot_token"],
  ["channels:\n  telegram:\n    allowed_user_ids: ['abc']\n", "allowed_user_ids"],
  ["sources: []\n", "sources must be a mapping"],
  ["sources:\n  source:\n    session_id: 123\n", "session_id"],
  ["sources:\n  source: null\n", "must be a mapping"],
  ["default_delivery_source: 123\n", "default_delivery_source"],
  ["logging_path: null\n", "logging_path"],
  ["event_path: 123\n", "event_path"],
  ["llm:\n  thinking: null\n", "llm.thinking"],
])("rejects malformed runtime fields before starting resources: %s", async (runtime, error) => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  await writeFile(join(workspace, "config.runtime.yaml"), runtime);
  await expect(openAgent({ workspace })).rejects.toThrow(error);
  expect(fixture.requests).toHaveLength(0);
});

it("treats an empty runtime file as no overrides", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  await writeFile(join(workspace, "config.runtime.yaml"), "");
  const agent = await openAgent({ workspace });
  expect(await agent.chat("Hello")).toBe("Hello!");
});

it("replaces non-mapping values, disables web tools and observes repeated user-file replacements", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace(
    undefined,
    "web_search:\n  provider: brave\n  api_key: offline-key\nfetch_content: {}\nchannels:\n  telegram:\n    allowed_user_ids: ['123', '456']\n",
  );
  const configuration = await openConfiguration(workspace);
  const agent = await openAgent({ configuration });
  await configuration.updateRuntime({
    web_search: null,
    fetch_content: null,
    channels: { telegram: { allowed_user_ids: ["789"] } },
  });
  expect(configuration.config.channels.telegram?.allowed_user_ids).toEqual(["789"]);
  await agent.chat("Hello");
  expect(fixture.requests[0].tools.map((tool) => tool.function.name)).not.toContain("web_search");
  expect(fixture.requests[0].tools.map((tool) => tool.function.name)).not.toContain(
    "fetch_content",
  );
  configuration.startWatching();
  const user = parse(await readFile(join(workspace, "config.user.yaml"), "utf8"));
  for (const model of ["first-replacement", "second-replacement"]) {
    await writeFile(
      join(workspace, "replacement.yaml"),
      stringify({ ...user, llm: { ...user.llm, model } }),
    );
    await rename(join(workspace, "replacement.yaml"), join(workspace, "config.user.yaml"));
    await expect.poll(() => configuration.config.llm.model).toBe(model);
  }
  await writeFile(join(workspace, "config.runtime.yaml"), "llm: [");
  await expect.poll(() => configuration.lastError).toContain("Invalid YAML");
  expect(configuration.config.llm.model).toBe("second-replacement");
});
