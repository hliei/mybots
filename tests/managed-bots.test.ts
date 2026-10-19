import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WebSocketChannel } from "../packages/host/src/channels/websocket.ts";
import { loadHostSettings } from "../packages/host/src/config/host.ts";
import { Host } from "../packages/host/src/host.ts";
import { MailboxDriver } from "./host-fixture.ts";

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

async function start() {
  root = await mkdtemp(join(tmpdir(), "mybots-managed-"));
  const { configuration } = await loadHostSettings("examples/host/host.json");
  configuration.approvedModels = [
    configuration.agent.model,
    { ...configuration.agent.model, id: "deepseek-reasoner" },
  ];
  host = await Host.start({ root, configuration, driver: new MailboxDriver() });
  channel = await WebSocketChannel.listen({ root, host, configuration, port: 0 });
  base = `http://127.0.0.1:${channel.address.port}`;
  headers = {
    Authorization: `Bearer ${(await readFile(join(root, "data", "client-credential"), "utf8")).trim()}`,
    "Content-Type": "application/json",
  };
  return configuration;
}

const researcher = {
  requestId: "create-researcher",
  name: "Researcher",
  instructions: "Investigate sources and preserve research notes.",
  model: { provider: "deepseek", id: "deepseek-chat" },
  tools: ["read", "write"],
};

function create(body: unknown) {
  return fetch(`${base}/api/bots`, { method: "POST", headers, body: JSON.stringify(body) });
}

it("creates independently owned Bots with inspectable initial settings through the public API", async () => {
  await start();
  const first = await create(researcher);
  expect(first.status).toBe(201);
  const research = await first.json();
  const second = await create({
    ...researcher,
    requestId: "create-writer",
    name: "Writer",
    instructions: "Write clear reports.",
    tools: ["read", "edit"],
  });
  expect(second.status).toBe(201);
  const writer = await second.json();
  expect(research).toMatchObject({
    requestId: researcher.requestId,
    bot: {
      name: "Researcher",
      instructions: researcher.instructions,
      model: researcher.model,
      tools: ["read", "write"],
    },
  });
  expect(writer.bot.id).not.toBe(research.bot.id);
  expect(writer.bot.workspace).not.toBe(research.bot.workspace);
  const response = await fetch(`${base}/api/bots`, { headers });
  expect(await response.json()).toMatchObject({
    bots: [{ id: "personal", name: "Personal" }, research.bot, writer.bot],
  });
});

it("retains admitted settings and request identity across a fresh Host without reseeding", async () => {
  const configuration = await start();
  const created = await (await create(researcher)).json();
  expect(created.bot?.name).toBe("Researcher");
  const retry = await create(researcher);
  expect(retry.status).toBe(200);
  expect(await retry.json()).toEqual({ ...created, replayed: true });
  expect((await create({ ...researcher, name: "Different" })).status).toBe(409);
  const before = await (await fetch(`${base}/api/bots`, { headers })).json();
  await channel.close();
  await host.stop();
  configuration.agent.id = "new-seed-id";
  configuration.agent.folder = "new-seed-folder";
  configuration.agent.name = "Replacement seed";
  configuration.agent.instructions = "Changed installation instructions";
  configuration.agent.resources = { tools: ["bash"] };
  host = await Host.start({ root, configuration, driver: new MailboxDriver() });
  channel = await WebSocketChannel.listen({ root, host, configuration, port: 0 });
  base = `http://127.0.0.1:${channel.address.port}`;
  expect(await (await fetch(`${base}/api/bots`, { headers })).json()).toEqual(before);
  expect(await (await create(researcher)).json()).toEqual({ ...created, replayed: true });
});

it("offers installation-approved models and tools without exposing deployment configuration", async () => {
  await start();
  const response = await fetch(`${base}/api/bot-options`, { headers });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    models: [
      { provider: "deepseek", id: "deepseek-chat" },
      { provider: "deepseek", id: "deepseek-reasoner" },
    ],
    tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
  });
  const result = await create({
    ...researcher,
    model: { provider: "deepseek", id: "deepseek-reasoner" },
  });
  expect(result.status).toBe(201);
  expect(await result.json()).toMatchObject({ bot: { model: { id: "deepseek-reasoner" } } });
});

it("rejects invalid settings visibly without admitting a Bot or consuming the request identity", async () => {
  await start();
  const before = await (await fetch(`${base}/api/bots`, { headers })).json();
  for (const invalid of [
    { ...researcher, name: " " },
    { ...researcher, instructions: "" },
    { ...researcher, requestId: "" },
    { ...researcher, model: { provider: "other", id: "deepseek-chat" } },
    { ...researcher, model: { provider: "deepseek", id: "unapproved" } },
    { ...researcher, model: { ...researcher.model, baseUrl: "https://attacker.example" } },
    { ...researcher, apiKey: "forbidden" },
    { ...researcher, tools: ["read", "read"] },
    { ...researcher, tools: ["web_search"] },
    { ...researcher, tools: ["unknown"] },
  ]) {
    const response = await create(invalid);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.any(String) });
  }
  expect(await (await fetch(`${base}/api/bots`, { headers })).json()).toEqual(before);
  expect((await create(researcher)).status).toBe(201);
});

it("admits concurrent retries once while equal display names can own different identities", async () => {
  await start();
  const responses = await Promise.all([create(researcher), create(researcher), create(researcher)]);
  expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 201]);
  const results = await Promise.all(responses.map((response) => response.json()));
  expect(new Set(results.map((result) => result.bot.id)).size).toBe(1);
  const other = await (await create({ ...researcher, requestId: "another-researcher" })).json();
  expect(other.bot.id).not.toBe(results[0].bot.id);
  expect(other.bot.workspace).not.toBe(results[0].bot.workspace);
  expect((await (await fetch(`${base}/api/status`, { headers })).json()).bots).toHaveLength(3);
});

it("keeps Bot materials in separate real workspaces and retains them after restart", async () => {
  const configuration = await start();
  const research = await (await create(researcher)).json();
  const writer = await (
    await create({ ...researcher, requestId: "writer-files", name: "Writer" })
  ).json();
  await writeFile(join(root, research.bot.workspace, "notes.md"), "Research notes");
  await writeFile(join(root, writer.bot.workspace, "notes.md"), "Writer notes");
  await channel.close();
  await host.stop();
  host = await Host.start({ root, configuration, driver: new MailboxDriver() });
  channel = await WebSocketChannel.listen({ root, host, configuration, port: 0 });
  base = `http://127.0.0.1:${channel.address.port}`;
  const visible = await (await fetch(`${base}/api/bots`, { headers })).json();
  expect(visible.bots).toContainEqual(research.bot);
  expect(visible.bots).toContainEqual(writer.bot);
  expect(await readFile(join(root, research.bot.workspace, "notes.md"), "utf8")).toBe(
    "Research notes",
  );
  expect(await readFile(join(root, writer.bot.workspace, "notes.md"), "utf8")).toBe("Writer notes");
});

it("does not admit an identity when workspace provisioning fails", async () => {
  await start();
  await symlink(tmpdir(), join(root, "groups"));
  const response = await create(researcher);
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: expect.stringContaining("workspace") });
  expect((await (await fetch(`${base}/api/status`, { headers })).json()).bots).toEqual([
    { id: "personal", name: "Personal" },
  ]);
  await rm(join(root, "groups"));
  expect((await create(researcher)).status).toBe(201);
});

it("reports malformed and oversized JSON and permits correction without partial identity", async () => {
  await start();
  const bad = await fetch(`${base}/api/bots`, { method: "POST", headers, body: "{" });
  expect(bad.status).toBe(400);
  const large = await create({ ...researcher, instructions: "x".repeat(66000) });
  expect(large.status).toBe(413);
  expect((await create(researcher)).status).toBe(201);
});
