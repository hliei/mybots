import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { HostMailbox, initializeMailbox } from "@mybots/mailbox/node";
import { expect, test } from "vitest";

const execute = promisify(execFile);

test("the production image resolves runner workspace source without host or repository dependencies", async () => {
  const result = await execute(
    "docker",
    [
      "run",
      "--rm",
      "--network=none",
      "--entrypoint",
      "bun",
      "mybots-agent:mailbox",
      "--conditions=mybots-source",
      "-e",
      `import assert from "node:assert/strict";
     import { existsSync } from "node:fs";
     const mailbox = await import("@mybots/mailbox");
     const bun = await import("@mybots/mailbox/bun");
     await import("@earendil-works/pi-coding-agent");
     assert.equal(typeof mailbox.clearMailboxLocks, "function");
     assert.equal(typeof bun.RunnerMailbox, "function");
     assert.ok(import.meta.resolve("@mybots/mailbox/bun").endsWith("/packages/mailbox/src/bun.ts"));
     for (const id of ["@mybots/host", "@onecli-sh/sdk", "typescript", "vitest"]) {
       assert.throws(() => import.meta.resolve(id));
     }
     assert.equal(existsSync("/app/packages/host"), false);
     assert.equal(existsSync("/app/packages/agent-runner/dist"), false);
     console.log("Isolated runner workspace imports passed.");`,
    ],
    { timeout: 15000 },
  );
  expect(result.stdout.trim()).toBe("Isolated runner workspace imports passed.");
});

test("directional readers tolerate concurrent writes on actual container mounts", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "mybots-mounted-sqlite-"));
  const root = await realpath(temporary);
  const name = `mybots-sqlite-${randomUUID()}`;
  const signal = AbortSignal.timeout(30000);
  try {
    initializeMailbox(root);
    const host = new HostMailbox(root);
    host.submit({
      id: "input",
      content: "Work",
      channel_type: "cli",
      platform_id: "owner",
      thread_id: null,
    });
    const start = async (script: string) =>
      execute(
        "docker",
        [
          "run",
          "--detach",
          "--name",
          name,
          "--network=none",
          "--user",
          `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
          "--mount",
          `type=bind,source=${root},target=/session`,
          "--mount",
          `type=bind,source=${root}/inbound.db,target=/session/inbound.db,readonly`,
          "--entrypoint",
          "bun",
          "mybots-agent:mailbox",
          "--conditions=mybots-source",
          "-e",
          script,
        ],
        { timeout: 10000 },
      );
    const script = `import { RunnerMailbox } from "@mybots/mailbox/bun";
      const mailbox = new RunnerMailbox("/session"); const input = mailbox.pending()[0];
      for (let i = 0; i < 1000; i++) { mailbox.activity("write"); if (i % 100 === 0) mailbox.reply(input, "Checkpoint " + i); }
      mailbox.reply(input, "Done");`;
    await start(script);
    while (!signal.aborted) {
      const outputs = host.outputs();
      if (outputs.at(-1)?.content === "Done") break;
      await setTimeout(1, undefined, { signal });
    }
    expect(host.outputs().at(-1)?.content).toBe("Done");
    const result = await execute("docker", ["wait", name], { timeout: 10000 });
    expect(result.stdout.trim()).toBe("0");
    await execute("docker", ["rm", name], { timeout: 10000 });
    await start(`import { RunnerMailbox } from "@mybots/mailbox/bun";
      const mailbox = new RunnerMailbox("/session");
      while (true) { const inputs = mailbox.pending(); if (inputs.length === 1001) { mailbox.reply(inputs.at(-1), "Observed 1001 inputs"); break; } await Bun.sleep(1); }`);
    for (let i = 0; i < 1000; i++)
      host.submit({
        id: `inbound-${i}`,
        content: "Fresh input",
        channel_type: "cli",
        platform_id: "owner",
        thread_id: null,
      });
    const read = await execute("docker", ["wait", name], { timeout: 10000 });
    if (read.stdout.trim() !== "0") {
      const diagnostic = await execute("docker", ["logs", name], { timeout: 10000 });
      throw new Error(`Mounted inbound reader failed: ${diagnostic.stderr}`);
    }
    expect(host.outputs().at(-1)?.content).toBe("Observed 1001 inputs");
  } finally {
    try {
      await execute("docker", ["rm", "--force", name], { timeout: 10000 }).catch(() => {});
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
});
