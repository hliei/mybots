import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { chatFixture } from "./chat-fixture.ts";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const temporaryRoot = mkdtempSync(join(tmpdir(), "mybots-startup-"));
const missingWorkspace = join(temporaryRoot, "missing");

let fixture: Awaited<ReturnType<typeof chatFixture>> | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

afterAll(() => rmSync(temporaryRoot, { recursive: true, force: true }));

describe("bot startup", () => {
  function run(...args: string[]) {
    return spawnSync(process.execPath, ["src/server.ts", ...args], {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 5000,
    });
  }

  it("prints help and exits without loading configuration or opening a listener", () => {
    const result = run("--help");

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: npm run start:bot");
    expect(result.stdout).toContain("/ws");
    expect(result.stdout).toContain("Telegram");
    expect(result.stderr).toBe("");
  });

  it("fails clearly for an unusable workspace without opening a listener", () => {
    const result = run("--workspace", missingWorkspace);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Invalid configuration");
  });

  it("reports disabled interfaces without credentials or network", async () => {
    fixture = await chatFixture();
    const result = run("--workspace", await fixture.workspace());
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("disabled");
    expect(result.stderr).toBe("");
  });

  it("rejects unsupported arguments with a failing exit status", () => {
    const result = run("--unknown");

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown option");
  });
});

it("imports runtime, CLI, and WebSocket modules without reading configuration or starting services", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'await import("./src/index.ts"); await import("./src/host.ts"); await import("./src/channels/cli.ts"); await import("./src/channels/websocket.ts"); await import("./src/core/agent.ts"); await import("./src/core/events.ts"); await import("./src/core/runtime.ts"); await import("./src/cli.ts"); await import("./src/websocket/interface.ts"); await import("./src/websocket/protocol.ts"); await import("./src/bot/startup.ts"); await import("./src/bot/telegram.ts"); await import("./src/channels/telegram-api.ts"); await import("./src/channels/telegram.ts");',
    ],
    { cwd: projectRoot, encoding: "utf8", timeout: 5000 },
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
});

it.each(["--missing-file", "--invalid-json", "--invalid-settings"])(
  "rejects unusable host startup settings (%s) before opening services",
  (mode) => {
    const file = join(temporaryRoot, `${mode}.json`);
    if (mode !== "--missing-file")
      writeFileSync(
        file,
        mode === "--invalid-json" ? "{" : '{"gateway":{"apiKey":"synthetic-secret-marker"}}',
      );
    const result = spawnSync(
      process.execPath,
      ["src/index.ts", "--root", temporaryRoot, "--config", file],
      { cwd: projectRoot, encoding: "utf8", timeout: 5000 },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Invalid host configuration");
    expect(result.stderr).not.toContain("synthetic-secret-marker");
  },
);

it("rejects a non-loopback WebSocket bind in host settings", () => {
  const base = JSON.parse(readFileSync(join(projectRoot, "examples/host/host.json"), "utf8"));
  base.websocket = { host: "0.0.0.0", port: 8787, path: "/ws" };
  const file = join(temporaryRoot, "websocket.json");
  writeFileSync(file, JSON.stringify(base));
  const result = spawnSync(
    process.execPath,
    ["src/index.ts", "--root", temporaryRoot, "--config", file],
    {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 5000,
    },
  );
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("Invalid host configuration");
});

it("reports an unavailable CLI host without opening an embedded runtime", () => {
  const result = spawnSync(process.execPath, ["src/cli.ts", "--root", missingWorkspace], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 5000,
  });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("start the host first");
});
