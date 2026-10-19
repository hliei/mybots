import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { WebSocketChannel } from "../packages/host/src/channels/websocket.ts";
import { loadHostSettings } from "../packages/host/src/config/host.ts";
import { Host } from "../packages/host/src/host.ts";
import { MailboxDriver } from "./host-fixture.ts";

let root: string;
let host: Host | undefined;
let channel: WebSocketChannel | undefined;

afterEach(async () => {
  await channel?.close();
  channel = undefined;
  await host?.stop();
  host = undefined;
  if (root) await rm(root, { recursive: true, force: true });
});

async function start(driver = new MailboxDriver(), readOnly = false) {
  root = await mkdtemp(join(tmpdir(), "mybots-client-"));
  const { configuration } = await loadHostSettings("examples/host/host.json");
  if (readOnly)
    configuration.destinations = configuration.destinations.filter(
      (destination) => destination.channelType !== "websocket",
    );
  host = await Host.start({ root, configuration, driver });
  channel = await WebSocketChannel.listen({ host, configuration, port: 0, root });
  return `http://127.0.0.1:${channel.address.port}`;
}

it("requires a connection credential before reading Host status", async () => {
  const base = await start();
  expect((await fetch(`${base}/api/status`)).status).toBe(401);
});

it("pairs idempotently and reads persisted Bot and session status after restarting the Host", async () => {
  const base = await start();
  const credential = (await readFile(join(root, "data", "client-credential"), "utf8")).trim();
  const pair = () =>
    fetch(`${base}/api/pair`, {
      method: "POST",
      headers: { Authorization: `Bearer ${credential}`, Origin: base },
    });
  const paired = await pair();
  expect(paired.status).toBe(204);
  const cookie = paired.headers.get("set-cookie") ?? "";
  expect(cookie).toContain("HttpOnly; SameSite=Strict");
  expect((await pair()).headers.get("set-cookie")).toBe(cookie);
  const accepted = await (host as Host).accept({
    destinationId: "terminal",
    userId: "cli:local",
    text: "Hello",
  });
  const headers = { Cookie: cookie.split(";")[0] };
  const read = async (url: string) => {
    const response = await fetch(`${url}/api/status`, { headers });
    expect(response.status).toBe(200);
    return response.json();
  };
  expect(await read(base)).toMatchObject({
    bots: [{ id: "personal", name: "Personal" }],
    sessions: [
      {
        id: accepted.sessionId,
        botId: "personal",
        destinationId: "terminal",
        containerStatus: "running",
      },
    ],
  });
  await channel?.close();
  channel = undefined;
  await host?.stop();
  const { configuration } = await loadHostSettings("examples/host/host.json");
  host = await Host.start({ root, configuration, driver: new MailboxDriver() });
  channel = await WebSocketChannel.listen({ root, host, configuration, port: 0 });
  expect(await read(`http://127.0.0.1:${channel.address.port}`)).toMatchObject({
    bots: [{ id: "personal", name: "Personal" }],
    sessions: [{ id: accepted.sessionId, botId: "personal" }],
  });
});

it("rejects invalid credential, Host and Origin on HTTP and the existing live-event listener", async () => {
  const base = await start();
  const credential = (await readFile(join(root, "data", "client-credential"), "utf8")).trim();
  const valid = { Authorization: `Bearer ${credential}`, Origin: base };
  const cookie = `mybots_connection=${credential}`;
  for (const [headers, expected] of [
    [{}, 401],
    [{ ...valid, Authorization: "Bearer wrong" }, 401],
    [{ ...valid, Authorization: "Bearer wrong", Cookie: cookie }, 401],
    [{ Cookie: "mybots_connection=wrong" }, 401],
    [{ ...valid, Authorization: credential }, 401],
    [{ ...valid, "Sec-Fetch-Site": "cross-site" }, 403],
    [{ ...valid, Host: "attacker.example" }, 403],
    [{ ...valid, Host: "localhost:9999" }, 403],
    [{ ...valid, Origin: "https://attacker.example" }, 403],
    [{ ...valid, Origin: "null" }, 403],
  ] as const) {
    for (const [path, method] of [
      ["/api/status", "GET"],
      ["/api/pair", "POST"],
      ["/api/bots", "POST"],
      ["/api/bots", "GET"],
      ["/api/bot-options", "GET"],
      ["/api/sessions", "GET"],
      ["/api/sessions", "POST"],
      ["/api/sessions/example", "GET"],
      ["/api/sessions/example/name", "POST"],
      ["/api/sessions/example/messages", "POST"],
      ["/ws", "GET"],
    ]) {
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(`${base}${path}`, { headers, method }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(expected);
    }
    const upgrade = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`${base.replace("http:", "ws:")}/ws`, {
        headers,
        handshakeTimeout: 1000,
      });
      socket.on("error", reject);
      socket.once("open", () => {
        socket.terminate();
        resolve(101);
      });
      socket.once("unexpected-response", (_req, res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
        socket.terminate();
      });
    });
    expect(upgrade).toBe(expected);
  }
  const socket = new WebSocket(`${base.replace("http:", "ws:")}/ws`, {
    headers: { Cookie: cookie, Origin: base },
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.terminate();
});

it("reads status without WebSocket input destinations and leaves execution untouched", async () => {
  const driver = new MailboxDriver();
  const base = await start(driver, true);
  const file = join(root, "data", "client-credential");
  const credential = (await readFile(file, "utf8")).trim();
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  const response = await fetch(`${base}/api/status`, {
    headers: { Authorization: `Bearer ${credential}` },
  });
  expect(await response.json()).toEqual({
    bots: [{ id: "personal", name: "Personal" }],
    sessions: [],
  });
  expect(driver.launches).toEqual([]);
  expect((await fetch(`${base}/data/client-credential`)).status).toBe(401);
});

it("shows failed container startup and pending input without claiming successful work", async () => {
  const driver = new MailboxDriver();
  driver.fail = true;
  const base = await start(driver);
  const accepted = await (host as Host).accept({
    destinationId: "terminal",
    userId: "cli:local",
    text: "Pending execution",
  });
  const credential = (await readFile(join(root, "data", "client-credential"), "utf8")).trim();
  await vi.waitFor(async () => {
    const response = await fetch(`${base}/api/status`, {
      headers: { Authorization: `Bearer ${credential}` },
    });
    expect(await response.json()).toMatchObject({
      sessions: [
        {
          id: accepted.sessionId,
          containerStatus: "failed",
          inputs: { pending: 1, processing: 0, acknowledged: 0, failed: 0 },
        },
      ],
    });
  });
});
