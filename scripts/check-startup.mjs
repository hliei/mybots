import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

for (const [command, args, usage] of [
  [process.execPath, ["packages/host/dist/cli/client.js", "--help"], "Usage: mbt"],
  [process.execPath, ["packages/host/dist/cli/client.js", "start", "--help"], "mbt start"],
  ["npm", ["start", "--", "--help"], "Usage: npm start"],
]) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env: { ...process.env, NODE_OPTIONS: "--no-strip-types" },
    encoding: "utf8",
    timeout: 5000,
  });

  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Startup failed: ${result.stderr}`);
  assert.equal(result.stderr, "");
  assert.ok(result.stdout.includes(usage));
}

// Exercise the built composition entry, including listener ownership and shutdown.
const root = await mkdtemp(join(tmpdir(), "mybots-built-startup-"));
let child;
let exited;
try {
  const settings = JSON.parse(
    await readFile(new URL("../examples/host/host.json", import.meta.url), "utf8"),
  );
  settings.websocket.port = 0;
  await writeFile(join(root, "host.json"), JSON.stringify(settings));
  await writeFile(join(root, "docker"), "#!/bin/sh\necho true\n", { mode: 0o755 });
  await chmod(join(root, "docker"), 0o755);
  child = spawn(
    process.execPath,
    ["--no-strip-types", "packages/host/dist/index.js", "--root", root],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        NODE_OPTIONS: "",
        PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
      },
      stdio: "pipe",
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  exited = new Promise((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", reject);
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const listening = new Promise((resolve) => {
      let stdout = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        stdout += chunk;
        const localClient = stdout.match(/Local client on (http:\/\/\S+)/u);
        if (localClient) resolve(localClient[1]);
      });
    });
    const clientUrl = await Promise.race([
      listening,
      exited.then(() => {
        throw new Error(`Built host stopped before listening: ${stderr}`);
      }),
    ]);
    assert.equal((await stat(join(root, "data", "cli.sock"))).mode & 0o777, 0o600);
    const shell = await fetch(clientUrl);
    assert.equal(shell.status, 200);
    assert.ok((await shell.text()).includes("Connection credential"));
    assert.equal((await fetch(`${clientUrl}api/status`)).status, 401);
    const credential = (await readFile(join(root, "data", "client-credential"), "utf8")).trim();
    const paired = await fetch(`${clientUrl}api/pair`, {
      method: "POST",
      headers: { Authorization: `Bearer ${credential}`, Origin: new URL(clientUrl).origin },
    });
    assert.equal(paired.status, 204);
    const snapshot = await fetch(`${clientUrl}api/status`, {
      headers: { Cookie: paired.headers.get("set-cookie").split(";")[0] },
    });
    assert.equal(snapshot.status, 200);
    assert.deepEqual(await snapshot.json(), {
      bots: [{ id: settings.agent.id, name: settings.agent.name }],
      sessions: [],
    });
    child.kill("SIGTERM");
    assert.equal(await exited, 0, `Built host shutdown failed: ${stderr}`);
    assert.equal(stderr, "");
    for (const file of ["cli.sock", "host.lock"])
      await assert.rejects(stat(join(root, "data", file)), { code: "ENOENT" });
  } finally {
    clearTimeout(timeout);
  }
} finally {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  await exited;
  await rm(root, { recursive: true, force: true });
}

// The root entry must remain usable without loading either native SQLite driver.
for (const source of [false, true]) {
  const result = spawnSync(
    process.execPath,
    [
      ...(source ? ["--conditions=mybots-source"] : ["--no-strip-types"]),
      "--input-type=module",
      "-e",
      `import assert from "node:assert/strict";
       import { registerHooks } from "node:module";
       registerHooks({ resolve(specifier, context, nextResolve) {
         assert.ok(!["node:sqlite", "bun:sqlite"].includes(specifier), "SQLite imported by root entry");
         return nextResolve(specifier, context);
       }});
       const expected = ${source ? '"/src/index.ts"' : '"/dist/index.js"'};
       assert.ok(import.meta.resolve("@mybots/mailbox").endsWith(expected));
       const mailbox = await import("@mybots/mailbox");
       assert.equal(typeof mailbox.clearMailboxLocks, "function");`,
    ],
    {
      cwd: projectRoot,
      env: { ...process.env, NODE_OPTIONS: "" },
      encoding: "utf8",
      timeout: 5000,
    },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Mailbox package boundary failed: ${result.stderr}`);
  assert.equal(result.stderr, "");
}

const runner = spawnSync(process.execPath, ["scripts/pi-session-demo.mjs"], {
  cwd: projectRoot,
  encoding: "utf8",
  timeout: 15000,
});
if (runner.error) throw runner.error;
assert.equal(runner.status, 0, `Pi runner demo failed: ${runner.stderr}`);
assert.equal(runner.stderr, "");
assert.ok(runner.stdout.includes("Workspace tool effect and selected-session reopening passed."));

const isolatedRunner = spawnSync(process.execPath, ["packages/agent-runner/dist/index.js"], {
  cwd: projectRoot,
  encoding: "utf8",
  timeout: 5000,
});
if (isolatedRunner.error) throw isolatedRunner.error;
assert.equal(isolatedRunner.status, 1);
assert.ok(isolatedRunner.stderr.includes("ERR_UNSUPPORTED_ESM_URL_SCHEME"));
assert.ok(isolatedRunner.stderr.includes("Received protocol 'bun:'"));
assert.equal(isolatedRunner.stdout, "");

const host = spawnSync(process.execPath, ["scripts/host-cli-demo.mjs"], {
  cwd: projectRoot,
  encoding: "utf8",
  timeout: 15000,
});
if (host.error) throw host.error;
assert.equal(host.status, 0, `Host CLI demo failed: ${host.stderr}`);
assert.equal(host.stderr, "");
assert.ok(host.stdout.includes("Persistent host routing, CLI/WebSocket conversations"));

for (const entry of ["index", "cli/client"]) {
  const failure = spawnSync(
    process.execPath,
    [`packages/host/dist/${entry}.js`, "--root", "/__mybots_missing_host_root__"],
    {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 5000,
    },
  );
  if (failure.error) throw failure.error;
  assert.equal(failure.status, 1);
  assert.equal(failure.stdout, "");
  assert.ok(
    failure.stderr.includes(
      entry !== "cli/client" ? "Run setup before starting the host." : "start the host first",
    ),
  );
}
console.log("Host, CLI, Pi provider and isolated runner startup smoke checks passed.");
