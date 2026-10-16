import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function bin(root: string, name: string, body: string): Promise<void> {
  const file = join(root, name);
  await writeFile(file, body, { mode: 0o755 });
  await chmod(file, 0o755);
}

async function preflight(
  scripts: Record<string, string>,
): Promise<{ code: number; stderr: string }> {
  const root = await mkdtemp(join(tmpdir(), "mybots-preflight-"));
  roots.push(root);
  await mkdir(root, { recursive: true });
  for (const [name, body] of Object.entries(scripts)) await bin(root, name, body);
  try {
    await run(
      "bash",
      ["-c", `source ${JSON.stringify(join(process.cwd(), "mybots.sh"))}; preflight`],
      {
        env: { ...process.env, PATH: `${root}:/usr/bin:/bin` },
      },
    );
    return { code: 0, stderr: "" };
  } catch (error) {
    const failed = error as { code?: number; stderr?: string };
    return { code: failed.code ?? 1, stderr: failed.stderr ?? "" };
  }
}

describe("install preflight", () => {
  it("stops when memory is below 3700 MB", async () => {
    const result = await preflight({
      uname: "#!/bin/bash\necho Darwin\n",
      sysctl: "#!/bin/bash\necho 1000000\n",
      docker: "#!/bin/bash\nexit 0\n",
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("3700 MB");
  });

  it("stops when Docker is not available", async () => {
    const result = await preflight({
      uname: "#!/bin/bash\necho Darwin\n",
      sysctl: "#!/bin/bash\necho 17179869184\n",
      docker: "#!/bin/bash\nexit 1\n",
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Docker is not running");
  });

  it("stops on an unsupported operating system", async () => {
    const result = await preflight({
      uname: "#!/bin/bash\necho FreeBSD\n",
      docker: "#!/bin/bash\nexit 0\n",
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("macOS, Linux, and WSL");
  });

  it("continues when memory and Docker are available", async () => {
    const result = await preflight({
      uname: "#!/bin/bash\necho Darwin\n",
      sysctl: "#!/bin/bash\necho 17179869184\n",
      docker: "#!/bin/bash\nexit 0\n",
    });
    expect(result).toEqual({ code: 0, stderr: "" });
  });
});
