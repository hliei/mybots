import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";

import { runHost } from "../packages/host/src/index.ts";
import { waitForCheckpoint } from "./checkpoint.ts";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const temporaryRoot = mkdtempSync(join(tmpdir(), "mybots-startup-"));
const missingWorkspace = join(temporaryRoot, "missing");

afterAll(() => rmSync(temporaryRoot, { recursive: true, force: true }));

describe("host startup", () => {
  function run(...args: string[]) {
    return spawnSync(process.execPath, ["packages/host/src/index.ts", ...args], {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 5000,
    });
  }

  it("prints help and exits without loading configuration or opening a listener", () => {
    const result = run("--help");

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: npm start");
    expect(result.stdout).toContain("persistent host");
    expect(result.stdout).toContain("Telegram");
    expect(result.stderr).toBe("");
  });

  it("fails clearly for an unusable workspace without opening a listener", () => {
    const result = run("--root", missingWorkspace);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Run setup before starting the host.");
  });

  it("requires host settings even when an old workspace configuration exists", async () => {
    const root = join(temporaryRoot, "old-workspace");
    mkdirSync(root);
    writeFileSync(join(root, "config.user.yaml"), "channels:\n  enabled: false\n");
    const result = run("--root", root);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Run setup before starting the host.");
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
      'await import("./packages/host/src/index.ts"); await import("./packages/host/src/host.ts"); await import("./packages/host/src/cli/socket-server.ts"); await import("./packages/host/src/channels/websocket.ts"); await import("./packages/host/src/cli/client.ts"); await import("./packages/host/src/channels/telegram-api.ts"); await import("./packages/host/src/channels/telegram.ts");',
    ],
    { cwd: projectRoot, encoding: "utf8", timeout: 5000 },
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
});

it.each(["--invalid-json", "--invalid-settings"])(
  "rejects unusable host startup settings (%s) before opening services",
  (mode) => {
    const file = join(temporaryRoot, `${mode}.json`);
    if (mode === "--invalid-json") writeFileSync(file, "{");
    else writeFileSync(file, '{"gateway":{"apiKey":"synthetic-secret-marker"}}');
    const result = spawnSync(
      process.execPath,
      ["packages/host/src/index.ts", "--root", temporaryRoot, "--config", file],
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
    ["packages/host/src/index.ts", "--root", temporaryRoot, "--config", file],
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
  const result = spawnSync(
    process.execPath,
    ["packages/host/src/cli/client.ts", "--root", missingWorkspace],
    {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 5000,
    },
  );
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("start the host first");
});

it("rolls back the CLI listener and host after WebSocket binding fails, then starts cleanly", async () => {
  const root = mkdtempSync(join(temporaryRoot, "rollback-"));
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  const address = occupied.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  const settings = JSON.parse(readFileSync(join(projectRoot, "examples/host/host.json"), "utf8"));
  settings.websocket.port = address.port;
  const file = join(root, "host.json");
  writeFileSync(file, JSON.stringify(settings));
  const controller = new AbortController();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const log = vi.spyOn(console, "log").mockImplementation(() => controller.abort());
  try {
    await expect(
      waitForCheckpoint(
        runHost(["--root", root], { inspectNetwork: async () => "internal" }),
        "failed host startup",
      ),
    ).resolves.toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain("EADDRINUSE");
    for (const path of ["host.lock", "cli.sock"])
      await expect(access(join(root, "data", path))).rejects.toMatchObject({ code: "ENOENT" });
    settings.websocket.port = 0;
    writeFileSync(file, JSON.stringify(settings));
    error.mockClear();
    await expect(
      waitForCheckpoint(
        runHost(["--root", root], {
          inspectNetwork: async () => "internal",
          signal: controller.signal,
        }),
        "restarted host shutdown",
      ),
    ).resolves.toBe(0);
    expect(error).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
    for (const path of ["host.lock", "cli.sock"])
      await expect(access(join(root, "data", path))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    controller.abort();
    await new Promise<void>((resolve, reject) =>
      occupied.close((error) => (error ? reject(error) : resolve())),
    );
    error.mockRestore();
    log.mockRestore();
  }
});

it.each([
  [["run", "dev", "--", "--help"], "Usage: npm start"],
  [["run", "mbt", "--", "--help"], "Usage: mbt"],
] as const)("runs the source command %j without services", (args, usage) => {
  const result = spawnSync("npm", [...args], {
    cwd: projectRoot,
    env: { ...process.env, NODE_OPTIONS: "" },
    encoding: "utf8",
    timeout: 5000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(usage);
  expect(result.stderr).toBe("");
});
