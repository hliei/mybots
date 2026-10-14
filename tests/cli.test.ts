import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { copyFile, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CliChannel } from "../src/channels/cli.ts";
import { Host, type HostConfiguration } from "../src/host.ts";
import { MailboxDriver } from "./host-fixture.ts";

const configuration: HostConfiguration = {
  owner: "cli:local",
  agent: {
    id: "personal",
    name: "Personal",
    folder: "personal",
    model: {
      provider: "deepseek",
      id: "deepseek-chat",
      baseUrl: "https://api.deepseek.com",
      contextWindow: 128000,
      maxTokens: 4096,
    },
  },
  destinations: [{ id: "terminal", channelType: "cli", platformId: "local", instance: "cli" }],
};
let root: string;
let host: Host | undefined;
let channel: CliChannel | undefined;
const sockets: Socket[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const child of children.splice(0)) {
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await closed;
    }
  }
  await channel?.close();
  await host?.stop();
  channel = undefined;
  host = undefined;
  if (root) await rm(root, { recursive: true, force: true });
});

async function setup() {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-cli-")));
  const driver = new MailboxDriver();
  host = await Host.start({ root, configuration, driver });
  channel = await CliChannel.listen({
    host,
    root,
    destinationId: "terminal",
    owner: configuration.owner,
  });
  return driver;
}

async function terminal() {
  const socket = connect(join(root, "data", "cli.sock"));
  sockets.push(socket);
  const replies: { text: string }[] = [];
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    let end = buffer.indexOf("\n");
    while (end >= 0) {
      replies.push(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
      end = buffer.indexOf("\n");
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return {
    socket,
    replies,
    send(text: string) {
      socket.write(`${JSON.stringify({ text })}\n`);
    },
  };
}

it("routes owner-local socket input through the persistent host and continues after reconnect", async () => {
  await setup();
  expect((await stat(join(root, "data", "cli.sock"))).mode & 0o777).toBe(0o600);
  expect((await stat(join(root, "data"))).mode & 0o777).toBe(0o700);
  const first = await terminal();
  first.send("Remember Alice");
  await vi.waitFor(() => expect(first.replies).toEqual([{ text: "Reply: Remember Alice" }]));
  const session = host?.sessions()[0].id;
  first.socket.destroy();
  const second = await terminal();
  second.send("Continue");
  await vi.waitFor(() => expect(second.replies).toEqual([{ text: "Reply: Continue" }]));
  expect(host?.sessions().map((session) => session.id)).toEqual([session]);
});

it("claims a terminal on its first input and replaces the previous client without cancelling the session", async () => {
  await setup();
  const first = await terminal();
  first.send("First");
  await vi.waitFor(() => expect(first.replies).toHaveLength(1));
  const second = await terminal();
  expect(first.socket.destroyed).toBe(false);
  second.send("Second");
  await vi.waitFor(() =>
    expect(first.replies).toContainEqual({ text: "[superseded by a newer client]" }),
  );
  await vi.waitFor(() => expect(second.replies).toEqual([{ text: "Reply: Second" }]));
  expect(host?.sessions()).toHaveLength(1);
});

it("rejects malformed socket input without accepting Agent work and remains usable", async () => {
  await setup();
  const client = await terminal();
  client.socket.write("not json\n");
  await vi.waitFor(() => expect(client.replies[0].text).toContain("Error:"));
  expect(host?.sessions()).toHaveLength(0);
  client.send("Valid");
  await vi.waitFor(() => expect(client.replies).toContainEqual({ text: "Reply: Valid" }));
});

it("executes the CLI as a host client and reconnects to the same saved conversation", async () => {
  await setup();
  for (const text of ["First", "Continue"]) {
    const child = spawn(process.execPath, ["src/cli.ts", "--root", root], { stdio: "pipe" });
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    const exit = new Promise<number | null>((resolve, reject) => {
      child.once("close", resolve);
      child.once("error", reject);
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      await vi.waitFor(() => expect(stdout).toContain("Connected"));
      child.stdin.write(`${text}\n`);
      await vi.waitFor(() => expect(stdout).toContain(`Reply: ${text}`));
      child.stdin.end("quit\n");
      expect(await exit).toBe(0);
      expect(stderr).toBe("");
    } finally {
      clearTimeout(timeout);
    }
  }
  expect(host?.sessions()).toHaveLength(1);
});

it("disconnects a CLI process with Ctrl+C while the host keeps its conversation available", async () => {
  await setup();
  const child = spawn(process.execPath, ["src/cli.ts", "--root", root], { stdio: "pipe" });
  children.push(child);
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  const exit = new Promise<number | null>((resolve) => child.once("close", resolve));
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    await vi.waitFor(() => expect(stdout).toContain("Connected"));
    child.stdin.write("Before interrupt\n");
    await vi.waitFor(() => expect(stdout).toContain("Reply: Before interrupt"));
    child.kill("SIGINT");
    expect(await exit).toBe(130);
    expect(host?.sessions()).toHaveLength(1);
    const next = await terminal();
    next.send("After interrupt");
    await vi.waitFor(() => expect(next.replies).toEqual([{ text: "Reply: After interrupt" }]));
  } finally {
    clearTimeout(timeout);
  }
});

it("refuses a second CLI listener without disrupting the existing channel", async () => {
  await setup();
  await expect(
    CliChannel.listen({
      host: host as Host,
      root,
      destinationId: "terminal",
      owner: configuration.owner,
    }),
  ).rejects.toThrow("Channel already attached");
  const client = await terminal();
  client.send("Still available");
  await vi.waitFor(() => expect(client.replies).toEqual([{ text: "Reply: Still available" }]));
});

it("starts the host executable with valid settings and removes its socket and ownership on SIGTERM", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-cli-")));
  await copyFile("examples/host/host.json", join(root, "host.json"));
  const child = spawn(process.execPath, ["src/index.ts", "--root", root], { stdio: "pipe" });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const exit = new Promise<number | null>((resolve) => child.once("close", resolve));
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    await vi.waitFor(() => expect(stdout).toContain("Mybots host listening"));
    expect((await stat(join(root, "data", "cli.sock"))).mode & 0o777).toBe(0o600);
    child.kill("SIGTERM");
    expect(await exit).toBe(0);
    expect(stderr).toBe("");
    await expect(stat(join(root, "data", "cli.sock"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(root, "data", "host.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    host = await Host.start({ root, configuration, driver: new MailboxDriver() });
    expect(host.sessions()).toHaveLength(0);
  } finally {
    clearTimeout(timeout);
  }
});
