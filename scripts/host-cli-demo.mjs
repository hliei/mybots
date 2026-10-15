import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { WebSocketChannel } from "../packages/host/dist/channels/websocket.js";
import { CliChannel } from "../packages/host/dist/cli/socket-server.js";
import { Host } from "../packages/host/dist/host.js";
import { MailboxDriver } from "../tests/host-fixture.ts";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const root = await realpath(await mkdtemp(join(tmpdir(), "mybots-host-demo-")));
const driver = new MailboxDriver();
const configuration = {
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
  destinations: [
    { id: "terminal", channelType: "cli", platformId: "local", instance: "cli" },
    { id: "desktop", channelType: "websocket", platformId: "desktop", instance: "ws" },
  ],
};
let host;
let channel;
let webSocket;

async function open() {
  host = await Host.start({ root, configuration, driver });
  channel = await CliChannel.listen({
    host,
    root,
    destinationId: "terminal",
    owner: configuration.owners[0],
  });
  webSocket = await WebSocketChannel.listen({ host, configuration, port: 0 });
}
async function close() {
  await webSocket?.close();
  await channel?.close();
  await host?.stop();
}
async function observe(text) {
  const address = webSocket.address;
  const socket = new WebSocket(`ws://${address.host}:${address.port}${address.path}`);
  const messages = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
  const deadline = setTimeout(() => socket.terminate(), 5000);
  try {
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "input", destination: "desktop", content: text }));
    const inbound = await waitFor(messages, (message) => message.type === "inbound");
    const outbound = await waitFor(
      messages,
      (message) => message.type === "outbound" && message.content === `Reply: ${text}`,
    );
    assert.equal(inbound.destination, "desktop");
    assert.equal(inbound.channel_type, "websocket");
    assert.equal(outbound.in_reply_to, inbound.message_id);
    assert.equal(outbound.session_id, inbound.session_id);
    console.log(`WebSocket → host → persisted mailbox → fixture reply: ${text}`);
  } finally {
    clearTimeout(deadline);
    socket.terminate();
  }
}
function waitFor(messages, predicate) {
  return new Promise((resolve, reject) => {
    const check = () => {
      const found = messages.find(predicate);
      if (found) {
        clearInterval(poll);
        clearTimeout(timer);
        resolve(found);
      }
    };
    const poll = setInterval(check, 5);
    const timer = setTimeout(() => {
      clearInterval(poll);
      reject(new Error("Timed out waiting for a WebSocket envelope"));
    }, 4000);
    check();
  });
}
async function chat(text) {
  const child = spawn(process.execPath, ["bin/mbt", "--root", root], {
    cwd: projectRoot,
    stdio: "pipe",
  });
  let stdout = "";
  let stderr = "";
  let sent = false;
  let quitting = false;
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
    if (!sent && stdout.includes("Connected")) {
      sent = true;
      child.stdin.write(`${text}\n`);
    }
    if (!quitting && stdout.includes(`Reply: ${text}`)) {
      quitting = true;
      child.stdin.end("quit\n");
    }
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const status = await new Promise((resolve, reject) => {
      child.once("close", resolve);
      child.once("error", reject);
    });
    assert.equal(status, 0, stderr || stdout);
    assert.equal(stderr, "");
    assert.ok(stdout.includes(`Reply: ${text}`));
    console.log(`CLI → host → persisted mailbox → fixture reply: ${text}`);
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}
try {
  await open();
  await observe("Observed from a local client");
  const webSession = host.sessions().find((session) => session.messaging_group_id === "desktop");
  await chat("Remember Alice");
  const sessionId = host.sessions().find((session) => session.messaging_group_id === "terminal").id;
  assert.notEqual(webSession.id, sessionId);
  const continuation = (await host.inspect(sessionId)).continuation;
  await chat("CLI reconnect");
  assert.equal(
    host.sessions().find((session) => session.messaging_group_id === "terminal").id,
    sessionId,
  );
  await close();
  await open();
  await observe("Observed after host restart");
  await chat("Host restart");
  assert.equal(
    host.sessions().find((session) => session.messaging_group_id === "terminal").id,
    sessionId,
  );
  const restarted = driver.launches.at(-1);
  assert.equal(restarted.material.directory, join(root, "data", "sessions", "personal", sessionId));
  assert.equal(restarted.continuation, continuation);
  assert.equal(host.sessions().length, 2);
  console.log(
    "Persistent host routing, CLI/WebSocket conversations, reconnect and selected continuation passed (controlled mailbox driver).",
  );
} finally {
  await close();
  await rm(root, { recursive: true, force: true });
}
