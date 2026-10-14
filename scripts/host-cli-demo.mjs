import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliChannel } from "../dist/channels/cli.js";
import { Host } from "../dist/host.js";
import { MailboxDriver } from "../tests/host-fixture.ts";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const root = await realpath(await mkdtemp(join(tmpdir(), "mybots-host-demo-")));
const driver = new MailboxDriver();
const configuration = {
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
let host;
let channel;

async function open() {
  host = await Host.start({ root, configuration, driver });
  channel = await CliChannel.listen({
    host,
    root,
    destinationId: "terminal",
    owner: configuration.owner,
  });
}
async function close() {
  await channel?.close();
  await host?.stop();
}
async function chat(text) {
  const child = spawn(process.execPath, ["dist/cli.js", "--root", root], {
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
  await chat("Remember Alice");
  const sessionId = host.sessions()[0].id;
  const continuation = (await host.inspect(sessionId)).continuation;
  await chat("CLI reconnect");
  assert.equal(host.sessions()[0].id, sessionId);
  await close();
  await open();
  await chat("Host restart");
  assert.equal(host.sessions()[0].id, sessionId);
  assert.equal(driver.launches[1].continuation, continuation);
  assert.equal(host.sessions().length, 1);
  console.log(
    "Persistent host/CLI routing, reconnect and selected continuation passed (controlled mailbox driver).",
  );
} finally {
  await close();
  await rm(root, { recursive: true, force: true });
}
