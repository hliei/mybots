import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WebSocketChannel } from "../packages/host/src/channels/websocket.ts";
import { loadHostSettings } from "../packages/host/src/config/host.ts";
import type { SessionDriver } from "../packages/host/src/drivers/types.ts";
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

async function start(driver: SessionDriver = new MailboxDriver()) {
  root = await mkdtemp(join(tmpdir(), "mybots-memory-"));
  const { configuration } = await loadHostSettings("examples/host/host.json");
  host = await Host.start({ root, configuration, driver });
  channel = await WebSocketChannel.listen({ root, host, configuration, port: 0 });
  base = `http://127.0.0.1:${channel.address.port}`;
  headers = {
    Authorization: `Bearer ${(await readFile(join(root, "data", "client-credential"), "utf8")).trim()}`,
    "Content-Type": "application/json",
  };
  return configuration;
}
function put(path: string, body: unknown) {
  return fetch(`${base}${path}`, { method: "PUT", headers, body: JSON.stringify(body) });
}
function del(path: string, body: unknown) {
  return fetch(`${base}${path}`, { method: "DELETE", headers, body: JSON.stringify(body) });
}
async function get(path: string) {
  const response = await fetch(`${base}${path}`, { headers });
  expect(response.status).toBe(200);
  return response.json();
}

it("saves versioned memory for one Bot, rejects a stale save, and reloads it after restart", async () => {
  const configuration = await start();
  const created = await fetch(`${base}/api/bots`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      requestId: "writer-memory",
      name: "Writer",
      instructions: "Write clear reports.",
      model: {
        provider: configuration.agent.model.provider,
        id: configuration.agent.model.id,
      },
      tools: ["read", "write"],
    }),
  });
  expect(created.status).toBe(201);
  const writer = (await created.json()).bot.id as string;
  expect(await get("/api/bots/personal/memory")).toMatchObject({
    index: null,
    definition: null,
    topics: [],
    coreCharacterLimit: 16000,
  });
  const saved = await put("/api/bots/personal/memory/index", {
    content: `${"a".repeat(16000)}Ω`,
    version: null,
  });
  expect(saved.status).toBe(200);
  const index = (await saved.json()).index;
  expect(index).toMatchObject({ characters: 16001, truncated: true, version: expect.any(String) });
  expect(index.content.endsWith("Ω")).toBe(true);
  await writeFile(join(root, "groups", "personal", "memory", "index.md"), "intervening owner note");
  const conflict = await put("/api/bots/personal/memory/index", {
    content: "replaced without rereading",
    version: index.version,
  });
  expect(conflict.status).toBe(409);
  const observed = await conflict.json();
  expect(observed.error).toContain("Reread the current file");
  expect(observed.observed.content).toBe("intervening owner note");
  expect(await readFile(join(root, "groups", "personal", "memory", "index.md"), "utf8")).toBe(
    "intervening owner note",
  );
  const topic = await put(`/api/bots/${writer}/memory/topics/orchid`, {
    content: "writer topic body",
    version: null,
  });
  expect(topic.status).toBe(200);
  expect(await get(`/api/bots/${writer}/memory`)).toMatchObject({
    index: null,
    topics: [{ id: "orchid", content: "writer topic body" }],
  });
  expect((await get("/api/bots/personal/memory")).topics).toEqual([]);
  const outside = join(root, "secret.txt");
  await writeFile(outside, "other-bot-secret");
  await rm(join(root, "groups", "personal", "memory", "definition.md"), { force: true });
  await symlink(outside, join(root, "groups", "personal", "memory", "definition.md"));
  const linked = await get("/api/bots/personal/memory");
  expect(JSON.stringify(linked)).not.toContain("other-bot-secret");
  expect(
    (await put("/api/bots/personal/memory/definition", { content: "safe", version: null })).status,
  ).toBe(409);
  expect(
    (await lstat(join(root, "groups", "personal", "memory", "definition.md"))).isSymbolicLink(),
  ).toBe(true);
  await channel.close();
  await host.stop();
  host = await Host.start({ root, configuration, driver: new MailboxDriver() });
  channel = await WebSocketChannel.listen({ root, host, configuration, port: 0 });
  base = `http://127.0.0.1:${channel.address.port}`;
  headers = {
    ...headers,
    Authorization: `Bearer ${(await readFile(join(root, "data", "client-credential"), "utf8")).trim()}`,
  };
  expect((await get("/api/bots/personal/memory")).index.content).toBe("intervening owner note");
  expect((await get(`/api/bots/${writer}/memory`)).topics[0].content).toBe("writer topic body");
  const removed = await del("/api/bots/personal/memory/index", {
    version: (await get("/api/bots/personal/memory")).index.version,
  });
  expect(removed.status).toBe(200);
  expect((await removed.json()).index).toBeNull();
  expect(await get(`/api/bots/${writer}/memory`)).toMatchObject({
    topics: [{ content: "writer topic body" }],
  });
});
