import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

describe.each([{ entry: "server", command: "bot", message: "Bot server is not implemented yet." }])(
  "$command startup",
  ({ entry, command, message }) => {
    function run(...args: string[]) {
      return spawnSync(process.execPath, [`src/${entry}.ts`, ...args], {
        cwd: projectRoot,
        encoding: "utf8",
        timeout: 5000,
      });
    }

    it("prints help and exits without connecting to services", () => {
      const result = run("--help");

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`Usage: npm run start:${command}`);
      expect(result.stderr).toBe("");
    });

    it("reports that application functionality is not implemented", () => {
      const result = run();

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(message);
      expect(result.stderr).toBe("");
    });

    it("rejects unsupported arguments with a failing exit status", () => {
      const result = run("--unknown");

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Unsupported arguments: --unknown");
    });
  },
);

it("imports Agent and CLI modules without reading configuration or starting services", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'await import("./src/core/agent.ts"); await import("./src/core/events.ts"); await import("./src/core/runtime.ts"); await import("./src/cli.ts");',
    ],
    { cwd: projectRoot, encoding: "utf8", timeout: 5000 },
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
});
