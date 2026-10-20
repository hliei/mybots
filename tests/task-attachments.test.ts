import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocketChannel } from "../packages/host/src/channels/websocket.ts";
import { loadHostSettings } from "../packages/host/src/config/host.ts";
import type { HostConfiguration } from "../packages/host/src/host.ts";
import { Host } from "../packages/host/src/host.ts";
import { MailboxDriver } from "./host-fixture.ts";

let root: string;
let host: Host;
let channel: WebSocketChannel;
let base: string;
let headers: Record<string, string>;
let driver: MailboxDriver;

afterEach(async () => {
  await channel?.close();
  await host?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

async function start(files?: HostConfiguration["files"]) {
  root = await mkdtemp(join(tmpdir(), "mybots-attachments-"));
  const loaded = await loadHostSettings("examples/host/host.json");
  const configuration = { ...loaded.configuration, ...(files ? { files } : {}) };
  driver = new MailboxDriver();
  host = await Host.start({ root, configuration, driver });
  channel = await WebSocketChannel.listen({ root, host, configuration, port: 0 });
  base = `http://127.0.0.1:${channel.address.port}`;
  headers = {
    Authorization: `Bearer ${(await readFile(join(root, "data", "client-credential"), "utf8")).trim()}`,
  };
  return configuration;
}

function postJson(path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createBot(name: string) {
  const response = await postJson("/api/bots", {
    requestId: `bot-${name}`,
    name,
    instructions: `${name} works.`,
    model: { provider: "deepseek", id: "deepseek-chat" },
    tools: [],
  });
  expect(response.status).toBe(201);
  const body = await response.json();
  return body.bot.id as string;
}

async function newTask(botId: string, requestId: string) {
  const response = await postJson(`/api/bots/${botId}/thread/tasks`, {
    requestId,
    text: requestId,
  });
  expect(response.status).toBe(202);
  const body = await response.json();
  return body.taskId as string;
}

it("keeps uploaded bytes on the selected Task across restart and out of the other Task", async () => {
  await start();
  const botId = await createBot("Researcher");
  const first = await newTask(botId, "first-task");
  const second = await newTask(botId, "second-task");
  const bytes = Buffer.from("selected-task-bytes");
  const uploaded = await fetch(`${base}/api/bots/${botId}/tasks/${first}/attachments`, {
    method: "POST",
    headers: { ...headers, "X-Filename": "notes.txt" },
    body: bytes,
  });
  expect(uploaded.status).toBe(201);
  const created = await uploaded.json();
  expect(created).toMatchObject({ filename: "notes.txt", bytes: bytes.length });
  const listed = await fetch(`${base}/api/bots/${botId}/tasks/${first}/attachments`, { headers });
  expect(listed.status).toBe(200);
  const list = await listed.json();
  expect(list.attachments).toEqual([
    expect.objectContaining({ id: created.id, filename: "notes.txt", bytes: bytes.length }),
  ]);
  expect(list.maxBytes).toBe(25 * 1024 * 1024);
  const downloaded = await fetch(
    `${base}/api/bots/${botId}/tasks/${first}/attachments/${created.id}`,
    { headers },
  );
  expect(downloaded.status).toBe(200);
  expect(downloaded.headers.get("content-type")).toBe("application/octet-stream");
  expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(bytes);
  const other = await fetch(`${base}/api/bots/${botId}/tasks/${second}/attachments`, { headers });
  expect(await other.json()).toMatchObject({ attachments: [] });
  const bots = await (await fetch(`${base}/api/bots`, { headers })).json();
  const workspace = bots.bots.find((item: { id: string }) => item.id === botId).workspace as string;
  await expect(readFile(join(root, workspace, "notes.txt"))).rejects.toThrow();
  const firstLaunch = driver.launches.find((launch) =>
    launch.material.taskAttachments?.includes(first),
  );
  expect(firstLaunch?.material.taskAttachments).toBeTruthy();
  expect(await readFile(join(firstLaunch?.material.taskAttachments as string, created.id))).toEqual(
    bytes,
  );
  const context = await readFile(firstLaunch?.material.contextFile as string, "utf8");
  expect(context).not.toContain("selected-task-bytes");
  await vi.waitFor(() =>
    expect(
      driver.launches.some((launch) => launch.material.taskAttachments?.includes(second)),
    ).toBe(true),
  );
  const secondLaunch = driver.launches.find((launch) =>
    launch.material.taskAttachments?.includes(second),
  );
  await expect(
    readFile(join(secondLaunch?.material.taskAttachments as string, created.id)),
  ).rejects.toThrow();

  await channel.close();
  await host.stop();
  const configuration = await loadHostSettings("examples/host/host.json");
  host = await Host.start({
    root,
    configuration: configuration.configuration,
    driver: new MailboxDriver(),
  });
  channel = await WebSocketChannel.listen({
    root,
    host,
    configuration: configuration.configuration,
    port: 0,
  });
  base = `http://127.0.0.1:${channel.address.port}`;
  headers = {
    Authorization: `Bearer ${(await readFile(join(root, "data", "client-credential"), "utf8")).trim()}`,
  };
  const restored = await fetch(
    `${base}/api/bots/${botId}/tasks/${first}/attachments/${created.id}`,
    { headers },
  );
  expect(Buffer.from(await restored.arrayBuffer())).toEqual(bytes);
  const stillOther = await fetch(`${base}/api/bots/${botId}/tasks/${second}/attachments`, {
    headers,
  });
  expect(await stillOther.json()).toMatchObject({ attachments: [] });
});

it("copies a Task attachment into that Bot workspace only when the owner saves it", async () => {
  await start();
  const researcher = await createBot("Researcher");
  const writer = await createBot("Writer");
  const taskId = await newTask(researcher, "share-task");
  const otherTask = await newTask(researcher, "other-task");
  const bytes = Buffer.from("reuse-these-bytes");
  const uploaded = await fetch(`${base}/api/bots/${researcher}/tasks/${taskId}/attachments`, {
    method: "POST",
    headers: { ...headers, "X-Filename": "notes.txt" },
    body: bytes,
  });
  const created = await uploaded.json();
  const saved = await postJson(
    `/api/bots/${researcher}/tasks/${taskId}/attachments/${created.id}/workspace`,
    { path: "shared/notes.txt" },
  );
  expect(saved.status).toBe(201);
  expect(await saved.json()).toEqual({ path: "shared/notes.txt", bytes: bytes.length });
  const bots = await (await fetch(`${base}/api/bots`, { headers })).json();
  const workspace = (id: string) =>
    bots.bots.find((item: { id: string }) => item.id === id).workspace as string;
  expect(await readFile(join(root, workspace(researcher), "shared", "notes.txt"))).toEqual(bytes);
  await expect(readFile(join(root, workspace(writer), "shared", "notes.txt"))).rejects.toThrow();
  expect(
    await (await fetch(`${base}/api/bots/${researcher}/workspace/files`, { headers })).json(),
  ).toEqual({
    files: [{ path: "shared/notes.txt", bytes: bytes.length }],
  });
  expect(
    await (await fetch(`${base}/api/bots/${writer}/workspace/files`, { headers })).json(),
  ).toEqual({
    files: [],
  });
  const reused = await fetch(
    `${base}/api/bots/${researcher}/workspace/files?path=${encodeURIComponent("shared/notes.txt")}`,
    { headers },
  );
  expect(reused.headers.get("content-type")).toBe("application/octet-stream");
  expect(Buffer.from(await reused.arrayBuffer())).toEqual(bytes);
  expect(
    (
      await fetch(
        `${base}/api/bots/${writer}/workspace/files?path=${encodeURIComponent("shared/notes.txt")}`,
        { headers },
      )
    ).status,
  ).toBe(404);
  expect(
    await (
      await fetch(`${base}/api/bots/${researcher}/tasks/${otherTask}/attachments`, { headers })
    ).json(),
  ).toMatchObject({ attachments: [] });
  expect(
    Buffer.from(
      await (
        await fetch(`${base}/api/bots/${researcher}/tasks/${taskId}/attachments/${created.id}`, {
          headers,
        })
      ).arrayBuffer(),
    ),
  ).toEqual(bytes);
});

it("rejects another Bot, an escaped path, and a file over the 25 MiB default", async () => {
  await start();
  const researcher = await createBot("Researcher");
  const writer = await createBot("Writer");
  const taskId = await newTask(researcher, "scoped-task");
  const bytes = Buffer.from("scoped-bytes");
  const uploaded = await fetch(`${base}/api/bots/${researcher}/tasks/${taskId}/attachments`, {
    method: "POST",
    headers: { ...headers, "X-Filename": "notes.txt" },
    body: bytes,
  });
  const created = await uploaded.json();
  const anonymous = await fetch(`${base}/api/bots/${researcher}/tasks/${taskId}/attachments`);
  expect(anonymous.status).toBe(401);
  const foreign = await fetch(`${base}/api/bots/${writer}/tasks/${taskId}/attachments`, {
    method: "POST",
    headers: { ...headers, "X-Filename": "notes.txt" },
    body: bytes,
  });
  expect(foreign.status).toBe(404);
  const slash = await fetch(`${base}/api/bots/${researcher}/tasks/${taskId}/attachments`, {
    method: "POST",
    headers: { ...headers, "X-Filename": encodeURIComponent("../notes.txt") },
    body: bytes,
  });
  expect(slash.status).toBe(400);
  const escaped = await postJson(
    `/api/bots/${researcher}/tasks/${taskId}/attachments/${created.id}/workspace`,
    { path: "../outside.txt" },
  );
  expect(escaped.status).toBe(400);
  expect((await escaped.json()).error).toMatch(/workspace/i);
  await expect(readFile(join(root, "outside.txt"))).rejects.toThrow();
  const bots = await (await fetch(`${base}/api/bots`, { headers })).json();
  const workspace = bots.bots.find((item: { id: string }) => item.id === researcher)
    .workspace as string;
  const outside = join(root, "outside-dir");
  await mkdir(outside);
  await symlink(outside, join(root, workspace, "linked"));
  const linked = await postJson(
    `/api/bots/${researcher}/tasks/${taskId}/attachments/${created.id}/workspace`,
    { path: "linked/secret.txt" },
  );
  expect(linked.status).toBe(400);
  await expect(readFile(join(outside, "secret.txt"))).rejects.toThrow();
  const oversized = await fetch(`${base}/api/bots/${researcher}/tasks/${taskId}/attachments`, {
    method: "POST",
    headers: { ...headers, "X-Filename": "big.bin" },
    body: Buffer.alloc(25 * 1024 * 1024 + 1),
  });
  expect(oversized.status).toBe(413);
  expect(await oversized.json()).toEqual({ error: "File exceeds the 25 MiB limit." });
  const listed = await (
    await fetch(`${base}/api/bots/${researcher}/tasks/${taskId}/attachments`, { headers })
  ).json();
  expect(listed.attachments).toEqual([
    expect.objectContaining({ id: created.id, bytes: bytes.length }),
  ]);
});

it("uses an installation file limit below the 25 MiB default", async () => {
  await start({ maxBytes: 8 });
  const botId = await createBot("Researcher");
  const taskId = await newTask(botId, "small-limit");
  const accepted = await fetch(`${base}/api/bots/${botId}/tasks/${taskId}/attachments`, {
    method: "POST",
    headers: { ...headers, "X-Filename": "ok.bin" },
    body: Buffer.alloc(8, 1),
  });
  expect(accepted.status).toBe(201);
  const rejected = await fetch(`${base}/api/bots/${botId}/tasks/${taskId}/attachments`, {
    method: "POST",
    headers: { ...headers, "X-Filename": "over.bin" },
    body: Buffer.alloc(9, 2),
  });
  expect(rejected.status).toBe(413);
  expect((await rejected.json()).error).toContain("8");
});
