import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "mybots-durable-startup-"));
let child;
let exited;
try {
  await writeFile(join(root, "models.json"), "[]", { mode: 0o600 });
  child = fork(
    new URL("../apps/api/dist/index.js", import.meta.url),
    ["--root", root, "--port", "0"],
    { execArgv: ["--no-strip-types"], silent: true },
  );
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  exited = new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    const { url } = await Promise.race([
      new Promise((resolve) => child.once("message", resolve)),
      exited.then(() => {
        throw new Error(`Compiled API/worker exited before startup: ${errors}`);
      }),
    ]);
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes("Connect to Mybots"));
    assert.equal((await fetch(new URL("api/bots", url))).status, 401);
    const credential = (await readFile(join(root, "data/client-credential"), "utf8")).trim();
    const bots = await fetch(new URL("api/bots", url), {
      headers: { Authorization: `Bearer ${credential}` },
    });
    assert.deepEqual(await bots.json(), { bots: [], models: [] });
    child.kill("SIGTERM");
    assert.equal(await exited, 0);
    assert.equal(errors, "");
  } finally {
    clearTimeout(timeout);
  }
} finally {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  await exited;
  await rm(root, { recursive: true, force: true });
}
console.log("Compiled local API, Durable worker and Web startup passed.");
