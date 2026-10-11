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

console.log("CLI and bot startup smoke checks passed.");
