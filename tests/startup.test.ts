import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const temporaryRoot = mkdtempSync(join(tmpdir(), "mybots-startup-"));
const missingWorkspace = join(temporaryRoot, "missing");

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
    expect(result.stderr).toBe("");
  });

  it("fails clearly for an unusable workspace without opening a listener", () => {
    const result = run("--workspace", missingWorkspace);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Invalid configuration");
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
      'await import("./src/core/agent.ts"); await import("./src/core/events.ts"); await import("./src/core/runtime.ts"); await import("./src/cli.ts"); await import("./src/websocket/interface.ts"); await import("./src/websocket/protocol.ts"); await import("./src/bot/startup.ts");',
    ],
    { cwd: projectRoot, encoding: "utf8", timeout: 5000 },
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
});
