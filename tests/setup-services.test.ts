import { execFile, fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { proxyAssignments, renderStartScript } from "../setup/service-files.ts";

const run = promisify(execFile);
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function withProxy(proxy: Record<string, string>, script: string) {
  const root = await mkdtemp(join(tmpdir(), "mybots-service-proxy-"));
  roots.push(root);
  const file = join(root, "proxy.env");
  await writeFile(file, proxyAssignments(proxy));
  return run(
    "bash",
    [
      "-c",
      'set -a\nsource "$1"\nexec "$2" --input-type=module -e "$3"',
      "fixture",
      file,
      process.execPath,
      script,
    ],
    {
      env: { PATH: process.env.PATH },
      timeout: 5000,
    },
  );
}

it("routes native Node fetch through the configured host proxy", async () => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.end("proxied");
  });
  server.on("connect", (request, socket) => {
    requests.push(request.url ?? "");
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.once("data", () =>
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nproxied"),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing proxy address");
  const result = await withProxy(
    { ALL_PROXY: `http://127.0.0.1:${address.port}` },
    'console.log(await (await fetch("http://model.invalid/check")).text())',
  );
  expect(result.stdout.trim()).toBe("proxied");
  expect(requests).toEqual(["model.invalid:80"]);
});

it("preserves proxy credentials as literal shell values", async () => {
  const value = "http://user:p'a$ss&word@proxy.invalid:8080";
  const result = await withProxy({ HTTPS_PROXY: value }, "console.log(process.env.HTTPS_PROXY)");
  expect(result.stdout.trim()).toBe(value);
});

it("waits for the previous host to release its lock before starting a replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "mybots-service-restart-"));
  roots.push(root);
  await mkdir(join(root, "packages/host/dist"), { recursive: true });
  await writeFile(
    join(root, "old.mjs"),
    `
    import fs from 'node:fs';
    fs.writeFileSync('old.lock', 'owned');
    process.on('SIGTERM', () => {
      setTimeout(() => { fs.unlinkSync('old.lock'); process.exit(0); }, 500);
    });
    setInterval(() => {}, 1000);
    process.send('ready');
  `,
  );
  await writeFile(
    join(root, "packages/host/dist/index.js"),
    "const fs = require('node:fs'); fs.writeFileSync('replacement.status', fs.existsSync('old.lock') ? 'blocked' : 'ready');",
  );
  const previous = fork(join(root, "old.mjs"), [], {
    cwd: root,
    execPath: process.execPath,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  try {
    await once(previous, "message");
    await writeFile(join(root, "mybots.pid"), String(previous.pid));
    const file = join(root, "start-mybots.sh");
    await writeFile(
      file,
      renderStartScript({
        root,
        home: root,
        nodePath: process.execPath,
        slug: "fixture",
        path: process.env.PATH ?? "",
        proxy: {},
      }),
    );
    await run("bash", [file], { timeout: 3000 });
    await vi.waitFor(
      async () => expect(await readFile(join(root, "replacement.status"), "utf8")).toBe("ready"),
      { timeout: 2000 },
    );
  } finally {
    if (previous.exitCode === null && previous.signalCode === null) {
      const exited = once(previous, "exit");
      previous.kill("SIGKILL");
      await exited;
    }
  }
});
