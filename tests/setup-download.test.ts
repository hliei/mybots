import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);

it.each([true, false])(
  "handles an interrupted Node download (recovers=%s)",
  async (recovers) => {
    const root = await mkdtemp(join(tmpdir(), "mybots-download-"));
    const bins = join(root, "bin");
    const archive = "node-v24.21.0-darwin-arm64";
    await mkdir(join(root, archive, "bin"), { recursive: true });
    await mkdir(join(root, "downloads"));
    await mkdir(join(root, ".tools", "node"), { recursive: true });
    await writeFile(join(root, ".tools", "node", "existing"), "previous installation");
    await writeFile(join(root, archive, "bin", "node"), "#!/bin/bash\nexit 0\n", {
      mode: 0o755,
    });
    await run("tar", ["-czf", join(root, "node.tar.gz"), "-C", root, archive]);
    const payload = await readFile(join(root, "node.tar.gz"));
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(200, { "Content-Length": payload.length, Connection: "close" });
      if (requests === 1 || !recovers)
        response.end(payload.subarray(0, Math.floor(payload.length / 2)));
      else response.end(payload);
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing fixture address");
      await cp(join(process.cwd(), "setup.sh"), join(root, "setup.sh"));
      await mkdir(bins);
      const scripts = {
        node: "#!/bin/bash\nexit 1\n",
        uname: '#!/bin/bash\nif [[ "$1" == "-s" ]]; then echo Darwin; else echo arm64; fi\n',
        npm: '#!/bin/bash\necho "$*" >> "$SETUP_TEST_ROOT/npm.log"\n',
        curl: [
          "#!/bin/bash",
          "args=()",
          'for arg in "$@"; do',
          '  case "$arg" in',
          '    https://nodejs.org/*) args+=("$SETUP_TEST_URL") ;;',
          '    *) args+=("$arg") ;;',
          "  esac",
          "done",
          `exec /usr/bin/curl --noproxy "*" "\${args[@]}"`,
          "",
        ].join("\n"),
      };
      for (const [name, body] of Object.entries(scripts)) {
        await writeFile(join(bins, name), body, { mode: 0o755 });
      }
      const result = await run("bash", [join(root, "setup.sh")], {
        env: {
          ...process.env,
          PATH: `${bins}:/usr/bin:/bin`,
          SETUP_TEST_ROOT: root,
          SETUP_TEST_URL: `http://127.0.0.1:${address.port}/node.tar.gz`,
          TMPDIR: join(root, "downloads"),
        },
        timeout: 10_000,
      }).then(
        (output) => ({ ...output, code: 0 }),
        (error: { stdout: string; stderr: string; code: number }) => error,
      );
      expect(result.stdout).toContain("Downloading Node.js v24.21.0");
      expect(await readdir(join(root, "downloads"))).toEqual([]);
      if (recovers) {
        expect(result.code).toBe(0);
        expect(requests).toBe(2);
        expect(await readFile(join(root, ".tools", "node", "bin", "node"), "utf8")).toContain(
          "exit 0",
        );
        expect(await readFile(join(root, "npm.log"), "utf8")).toBe("ci\nrun setup:auto\n");
      } else {
        expect(result.code).not.toBe(0);
        expect(requests).toBe(3);
        expect(result.stdout).not.toContain("Extracting");
        expect(await readFile(join(root, ".tools", "node", "existing"), "utf8")).toBe(
          "previous installation",
        );
        await expect(readFile(join(root, "npm.log"))).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);
