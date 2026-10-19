import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CliChannel } from "../packages/host/src/cli/socket-server.ts";
import { Host, type HostConfiguration } from "../packages/host/src/host.ts";
import { waitForCheckpoint } from "./checkpoint.ts";
import { MailboxDriver } from "./host-fixture.ts";

const configuration: HostConfiguration = {
  owners: ["cli:local"],
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
let server: Server | undefined;
const sockets: Socket[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const closed = new Promise<void>((resolve, reject) => {
          child.once("close", () => resolve());
          timeout = setTimeout(() => reject(new Error("Child cleanup timed out")), 2000);
        });
        child.kill("SIGKILL");
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        await closed;
      } finally {
        clearTimeout(timeout);
      }
    }
  }
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
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
    owner: configuration.owners[0],
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
  expect(host?.sessions()).toHaveLength(2);
  expect(host?.sessions()[0].id).toBe(session);
  expect((await host?.threadDetail("personal"))?.tasks).toHaveLength(2);
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
  expect(host?.sessions()).toHaveLength(2);
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

it("executes the CLI as a host client and reconnects to the same Thread with independent Runs", async () => {
  await setup();
  for (const text of ["First", "Continue"]) {
    const child = spawn(process.execPath, ["packages/host/src/cli/client.ts", "--root", root], {
      stdio: "pipe",
    });
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
  expect(host?.sessions()).toHaveLength(2);
});

it("disconnects a CLI process with Ctrl+C while the host keeps its conversation available", async () => {
  await setup();
  const child = spawn(process.execPath, ["packages/host/src/cli/client.ts", "--root", root], {
    stdio: "pipe",
  });
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
      owner: configuration.owners[0],
    }),
  ).rejects.toThrow("Channel already attached");
  const client = await terminal();
  client.send("Still available");
  await vi.waitFor(() => expect(client.replies).toEqual([{ text: "Reply: Still available" }]));
});

async function spawnHost(root: string): Promise<ChildProcessWithoutNullStreams> {
  const settings = JSON.parse(await readFile(join(root, "host.json"), "utf8")) as {
    websocket: { port: number };
  };
  settings.websocket.port = 0;
  await writeFile(join(root, "host.json"), JSON.stringify(settings));
  const docker = join(root, "docker");
  await writeFile(docker, "#!/bin/sh\necho true\n", { mode: 0o755 });
  return spawn(process.execPath, ["packages/host/src/index.ts", "--root", root], {
    stdio: "pipe",
    env: { ...process.env, PATH: `${root}${delimiter}${process.env.PATH ?? ""}` },
  });
}

it("starts the host executable with valid settings and removes its socket and ownership on SIGTERM", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-cli-")));
  await copyFile("examples/host/host.json", join(root, "host.json"));
  const child = await spawnHost(root);
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
  const timeout = setTimeout(() => child.kill("SIGKILL"), 8000);
  try {
    await vi.waitFor(
      () => {
        if (stdout.includes("Mybots host listening")) return;
        throw new Error(stderr || "host has not started");
      },
      { timeout: 7000 },
    );
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

it("stops the host even when removing the CLI socket fails during shutdown", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-cli-")));
  await copyFile("examples/host/host.json", join(root, "host.json"));
  const child = await spawnHost(root);
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
  const timeout = setTimeout(() => child.kill("SIGKILL"), 8000);
  try {
    await vi.waitFor(
      () => {
        if (stdout.includes("Mybots host listening")) return;
        throw new Error(stderr || "host has not started");
      },
      { timeout: 7000 },
    );
    await unlink(join(root, "data", "cli.sock"));
    await mkdir(join(root, "data", "cli.sock"));
    child.kill("SIGTERM");
    expect(await exit).toBe(1);
    expect(stderr).toContain("Error:");
    await expect(stat(join(root, "data", "host.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    clearTimeout(timeout);
  }
});

async function controlledTerminal() {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-cli-peer-")));
  await mkdir(join(root, "data"));
  const connected = Promise.withResolvers<Socket>();
  server = createServer((socket) => {
    sockets.push(socket);
    connected.resolve(socket);
  });
  const listener = server;
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(join(root, "data", "cli.sock"), resolve);
  });
  const child = spawn(process.execPath, ["packages/host/src/cli/client.ts", "--root", root], {
    stdio: "pipe",
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", reject);
  });
  const peer = await waitForCheckpoint(connected.promise, "CLI connection");
  await vi.waitFor(() => expect(stdout).toContain("Connected"));
  return {
    child,
    peer,
    exited,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

it("labels host replies separately from the next user input prompt", async () => {
  const terminal = await controlledTerminal();
  const received = new Promise<void>((resolve) => terminal.peer.once("data", () => resolve()));
  terminal.child.stdin.write("Read the test file\n");
  await waitForCheckpoint(received, "terminal input");
  terminal.peer.write(`${JSON.stringify({ text: "MYBOTS_FILE_OK_7D93A" })}\n`);
  await vi.waitFor(() => expect(terminal.stdout).toContain("MYBOTS_FILE_OK_7D93A"));
  expect(terminal.stdout).toContain("\nBot: MYBOTS_FILE_OK_7D93A\nYou: ");
  expect(terminal.stdout).not.toContain("You: MYBOTS_FILE_OK_7D93A");
  terminal.child.stdin.end("quit\n");
  expect(await waitForCheckpoint(terminal.exited, "terminal quit")).toBe(0);
});

it("preserves text framing across fragmented and coalesced replies", async () => {
  const terminal = await controlledTerminal();
  let input = "";
  terminal.peer.setEncoding("utf8").on("data", (chunk) => {
    input += chunk;
  });
  terminal.child.stdin.write("  Message from the terminal  \n");
  await vi.waitFor(() => expect(input).toBe('{"text":"Message from the terminal"}\n'));
  terminal.peer.write('{"text":"First reply"}\n{"text":"Second');
  await vi.waitFor(() => expect(terminal.stdout).toContain("First reply\n"));
  expect(terminal.stdout).not.toContain("Second reply");
  terminal.peer.write(' reply 😀"}\n{"text":"Third reply"}\n');
  await vi.waitFor(() => expect(terminal.stdout).toContain("Second reply 😀\n"));
  expect(terminal.stdout).toContain("Third reply\n");
  terminal.child.stdin.end("quit\n");
  expect(await waitForCheckpoint(terminal.exited, "terminal quit")).toBe(0);
  expect(terminal.stderr).toBe("");
});

it.each([
  ["EOF", 0],
  ["disconnect", 1],
  ["malformed", 1],
  ["invalid text", 1],
  ["superseded", 0],
] as const)("closes the terminal on %s with its existing exit status", async (mode, expected) => {
  const terminal = await controlledTerminal();
  if (mode === "EOF") terminal.child.stdin.end();
  if (mode === "disconnect") terminal.peer.end();
  if (mode === "malformed") terminal.peer.write("not JSON\n");
  if (mode === "invalid text") terminal.peer.write('{"text":42}\n');
  if (mode === "superseded") terminal.peer.end('{"text":"[superseded by a newer client]"}\n');
  expect(await waitForCheckpoint(terminal.exited, `terminal ${mode}`)).toBe(expected);
  if (mode === "disconnect") expect(terminal.stderr).toContain("Host disconnected");
  else expect(terminal.stderr).toBe("");
  if (mode === "superseded") expect(terminal.stdout).toContain("[superseded by a newer client]");
});

it("links mbt into an isolated npm prefix and uses the same interactive client from any directory", async () => {
  await setup();
  const prefix = join(root, "linked npm prefix");
  const linked = spawnSync("npm", ["link", "--ignore-scripts", "--offline", "--workspaces=false"], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 15000,
    env: { ...process.env, npm_config_prefix: prefix },
  });
  expect(linked.error).toBeUndefined();
  expect(linked.status, linked.stderr).toBe(0);
  const command = join(prefix, "bin", "mbt");
  expect((await stat(command)).mode & 0o111).not.toBe(0);
  for (const [cwd, args, text] of [
    [root, [], "Linked default root"],
    [tmpdir(), ["--root", root], "Linked explicit root"],
  ] as const) {
    const child = spawn(command, [...args], {
      cwd,
      stdio: "pipe",
      env: { ...process.env, NODE_OPTIONS: "" },
    });
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("close", resolve);
      child.once("error", reject);
    });
    await vi.waitFor(
      () =>
        expect(
          stdout,
          JSON.stringify({ stderr, code: child.exitCode, signal: child.signalCode }),
        ).toContain("Connected"),
      { timeout: 3000 },
    );
    child.stdin.write(`${text}\n`);
    await vi.waitFor(() => expect(stdout).toContain(`Reply: ${text}`));
    child.kill("SIGINT");
    expect(await waitForCheckpoint(exited, "linked mbt interruption")).toBe(130);
    expect(stderr).toBe("");
  }
  expect(host?.sessions()).toHaveLength(2);
  const missing = spawnSync(command, ["--root", join(root, "unavailable")], {
    cwd: tmpdir(),
    env: { ...process.env, NODE_OPTIONS: "" },
    encoding: "utf8",
    timeout: 5000,
  });
  expect(missing.status).toBe(1);
  expect(missing.stdout).toBe("");
  expect(missing.stderr).toContain("start the host first");
  await expect(stat(join(root, "unavailable", "data"))).rejects.toMatchObject({ code: "ENOENT" });
}, 15000);
