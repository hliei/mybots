import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { chatFixture } from "./chat-fixture.ts";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
let fixture: Awaited<ReturnType<typeof chatFixture>> | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

describe("bot startup", () => {
  function run(...args: string[]) {
    return spawnSync(process.execPath, ["src/server.ts", ...args], {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 5000,
    });
  }

  it("prints help and exits without connecting to services", () => {
    const result = run("--help");

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: npm run start:bot");
    expect(result.stderr).toBe("");
  });

  it("reports a disabled Telegram channel without credentials or network", async () => {
    fixture = await chatFixture();
    const result = run("--workspace", await fixture.workspace());

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Telegram is disabled");
    expect(result.stderr).toBe("");
  });

  it("rejects unsupported arguments with a failing exit status", () => {
    const result = run("--unknown");

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--unknown");
  });
});

it("imports Agent, CLI and bot modules without reading configuration or starting services", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'await import("./src/core/agent.ts"); await import("./src/core/events.ts"); await import("./src/core/runtime.ts"); await import("./src/cli.ts"); await import("./src/bot/startup.ts"); await import("./src/bot/telegram.ts"); await import("./src/bot/telegram-api.ts");',
    ],
    { cwd: projectRoot, encoding: "utf8", timeout: 5000 },
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
});
