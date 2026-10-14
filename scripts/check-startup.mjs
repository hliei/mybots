import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

for (const [entry, command] of [
  ["cli", "cli"],
  ["index", "host"],
  ["server", "bot"],
]) {
  const result = spawnSync(process.execPath, [`dist/${entry}.js`, "--help"], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 5000,
  });

  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} startup failed: ${result.stderr}`);
  assert.equal(result.stderr, "");
  assert.ok(result.stdout.includes(`Usage: npm run start:${command}`));
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

const isolatedRunner = spawnSync(process.execPath, ["container/agent-runner/dist/index.js"], {
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
assert.ok(
  host.stdout.includes("Persistent host/CLI routing, reconnect and selected continuation passed"),
);

for (const entry of ["index", "cli"]) {
  const failure = spawnSync(
    process.execPath,
    [`dist/${entry}.js`, "--root", "/__mybots_missing_host_root__"],
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
      entry === "index" ? "Invalid host configuration" : "start the host first",
    ),
  );
}
console.log("Host, CLI, bot, Pi provider and isolated runner startup smoke checks passed.");
