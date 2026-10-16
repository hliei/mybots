import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { proxyAssignments } from "../setup/service-files.ts";

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
