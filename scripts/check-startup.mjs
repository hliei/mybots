import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

async function joinGroup(pid) {
  // Join every member of this temporary process group, including the worker.
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    if (attempt === 99) {
      process.kill(-pid, "SIGKILL");
      assert.fail("Application left a child process running");
    }
    await delay(50);
  }
}

const root = await mkdtemp(join(tmpdir(), "mybots-startup-"));
const command = process.argv.includes("--source") ? "dev" : "start";
let credential;
try {
  await writeFile(join(root, "models.json"), "[]", { mode: 0o600 });
  await mkdir(join(root, "computer/workspace"), { recursive: true });
  await writeFile(join(root, "computer/workspace/keep.txt"), "Persistent working file");
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const child = spawn("npm", ["run", command, "--", "--root", root, "--port", "0"], {
      cwd: new URL("../", import.meta.url),
      env: { ...process.env, NODE_OPTIONS: command === "start" ? "--no-strip-types" : "" },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let errors = "";
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    const exited = new Promise((resolve, reject) => {
      child.once("close", (code, exitSignal) => resolve({ code, signal: exitSignal }));
      child.once("error", reject);
    });
    const timeout = setTimeout(() => process.kill(-child.pid, "SIGKILL"), 15000);
    try {
      const url = await Promise.race([
        new Promise((resolve) => {
          let output = "";
          child.stdout.on("data", (chunk) => {
            output += chunk;
            const match = output.match(/Local chat on (http:\/\/\S+)/u);
            if (match) resolve(match[1]);
          });
        }),
        exited.then(() => {
          throw new Error(`Startup exited before listening: ${errors}`);
        }),
      ]);
      const page = await fetch(url);
      assert.equal(page.status, 200);
      assert.ok((await page.text()).includes("Connect to Mybots"));
      for (const asset of ["main.js", "style.css", "vendor/marked.js"])
        assert.equal((await fetch(new URL(asset, url))).status, 200);
      assert.equal((await fetch(new URL("api/bots", url))).status, 401);
      const saved = (await readFile(join(root, "client-credential"), "utf8")).trim();
      if (credential) assert.equal(saved, credential);
      credential = saved;
      const headers = { Authorization: `Bearer ${credential}` };
      const bots = await fetch(new URL("api/bots", url), { headers });
      assert.deepEqual(await bots.json(), { bots: [], models: [] });
      for (const route of ["status", "sessions", "runs", "routines", "attachments"])
        assert.equal((await fetch(new URL(`api/${route}`, url), { headers })).status, 404);
      const memoryUrl = new URL("api/memory/owner", url);
      if (signal === "SIGINT") {
        assert.equal(
          (
            await fetch(memoryUrl, {
              method: "PUT",
              headers: { ...headers, "Content-Type": "application/json" },
              body: JSON.stringify({ content: "Remember across startup" }),
            })
          ).status,
          200,
        );
      } else {
        assert.equal(
          (await (await fetch(memoryUrl, { headers })).json()).content,
          "Remember across startup",
        );
      }
      process.kill(-child.pid, signal);
      const result = await exited;
      assert.ok(result.code === 0 || result.signal === signal, JSON.stringify(result));
      assert.equal(errors, "");
      assert.equal(
        await readFile(join(root, "computer/workspace/keep.txt"), "utf8"),
        "Persistent working file",
      );
      await assert.rejects(fetch(url));
    } finally {
      clearTimeout(timeout);
      await joinGroup(child.pid);
      await exited;
    }
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log(`Default ${command} API, worker, Web, shutdown and persistence passed.`);
