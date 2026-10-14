import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

for (const [entry, command] of [
  ["cli", "cli"],
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

console.log("CLI, bot and Pi runner startup smoke checks passed.");
