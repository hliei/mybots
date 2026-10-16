import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runSetup } from "../setup/auto.ts";
import { registerBearerSecret } from "../setup/onecli.ts";
import { installSlug, launchdPlistPath } from "../setup/service-files.ts";
import { type CommandResult, runSetupStep, type SetupContext } from "../setup/steps.ts";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function installRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mybots-setup-"));
  roots.push(root);
  await cp(join(process.cwd(), "examples"), join(root, "examples"), { recursive: true });
  return root;
}

function context(
  root: string,
  overrides: Partial<SetupContext> = {},
): SetupContext & { commands: string[] } {
  const commands: string[] = [];
  const base: SetupContext & { commands: string[] } = {
    root,
    env: {},
    platform: "darwin",
    uid: 501,
    home: join(root, "home"),
    nodePath: "/usr/local/bin/node",
    isTTY: false,
    commands,
    async fetch() {
      return new Response("{}", { status: 200 });
    },
    async exec(command, args) {
      commands.push([command, ...args].join(" "));
      return { code: 0, stdout: "", stderr: "" };
    },
    async prompt() {
      throw new Error("prompt was not expected");
    },
    log() {},
    ...overrides,
  };
  return base;
}

function ok(stdout = ""): CommandResult {
  return { code: 0, stdout, stderr: "" };
}

describe("gateway setup", () => {
  it("reuses a healthy local gateway without installing it", async () => {
    const root = await installRoot();
    const ctx = context(root, {
      async exec(command, args) {
        ctx.commands.push([command, ...args].join(" "));
        if (command === "onecli" && args[0] === "api-host") return ok("http://127.0.0.1:10254\n");
        if (command === "onecli" && args[0] === "api-key") return ok("oc_local_key\n");
        if (args[0] === "inspect") return { code: 1, stdout: "", stderr: "missing" };
        return ok();
      },
    });
    await runSetupStep("gateway", ctx);
    expect(ctx.commands.some((line) => line.includes("install"))).toBe(false);
    expect(
      ctx.commands.some((line) => line.startsWith("docker network connect --alias onecli")),
    ).toBe(true);
    expect(
      ctx.commands.some(
        (line) => line.includes("onecli") && line.includes("--network mybots-isolated"),
      ),
    ).toBe(false);
    const env = await readFile(join(root, ".env"), "utf8");
    expect(env).toContain("ONECLI_URL=http://127.0.0.1:10254");
    expect(env).toContain("ONECLI_API_KEY=oc_local_key");
    const logs = await runAndRead(root, ctx, "gateway");
    expect(logs).not.toContain("oc_local_key");
  });

  it("stops when a remote gateway health check fails", async () => {
    const root = await installRoot();
    const ctx = context(root, {
      env: { ONECLI_URL: "http://127.0.0.1:9", ONECLI_API_KEY: "oc_remote" },
      async fetch() {
        return new Response("missing", { status: 404 });
      },
    });
    await expect(runSetupStep("gateway", ctx)).rejects.toThrow(/Upgrade OneCLI to 1.42.0/);
    expect(ctx.commands).toEqual([]);
  });

  it("only health-checks a gateway URL that is already in the env file", async () => {
    const root = await installRoot();
    await writeFile(
      join(root, ".env"),
      "ONECLI_URL=http://127.0.0.1:10254\nONECLI_API_KEY=oc_file\n",
      { mode: 0o600 },
    );
    const ctx = context(root);
    await runSetupStep("gateway", ctx);
    expect(ctx.commands.some((line) => line.startsWith("onecli"))).toBe(false);
  });

  it("rejects a non-loopback management URL and keeps the installer output out of the log", async () => {
    const root = await installRoot();
    const ctx = context(root, {
      async exec(command, args) {
        ctx.commands.push([command, ...args].join(" "));
        if (command === "onecli" && args[0] === "api-host")
          return { code: 1, stdout: "", stderr: "missing" };
        if (command === "onecli" && args[0] === "install") {
          return ok("ONECLI_URL=http://0.0.0.0:10254\nONECLI_API_KEY=oc_secret_install\n");
        }
        return ok();
      },
    });
    await expect(runSetup(ctx, ["gateway"])).rejects.toThrow(/loopback/);
    const log = await readFile(join(root, "logs", "setup-steps", "01-gateway.log"), "utf8");
    expect(log).not.toContain("oc_secret_install");
  });
});

describe("provider auth", () => {
  it("stops before asking for a key when the model and search hostnames match", async () => {
    const root = await installRoot();
    await writeFile(
      join(root, ".env"),
      [
        "ONECLI_URL=http://127.0.0.1:10254",
        "ONECLI_API_KEY=oc_file",
        "MODEL_BASE_URL=https://api.example.com/v1",
        "WEB_SEARCH_PROVIDER=brave",
        "WEB_SEARCH_ENDPOINT=https://api.example.com/search",
      ].join("\n"),
      { mode: 0o600 },
    );
    const ctx = context(root, {
      async prompt() {
        throw new Error("asked for a key");
      },
      async fetch() {
        throw new Error("called the gateway");
      },
    });
    await expect(runSetupStep("provider-auth", ctx)).rejects.toThrow(/same hostname/);
  });

  it("keeps the model key out of the env file, host file, and setup logs", async () => {
    const root = await installRoot();
    await writeFile(
      join(root, ".env"),
      "ONECLI_URL=http://127.0.0.1:10254\nONECLI_API_KEY=oc_file\n",
      { mode: 0o600 },
    );
    const secret = "sk-do-not-leak";
    const ctx = context(root, {
      env: { MYBOTS_MODEL_API_KEY: secret },
      async fetch(input, init) {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.endsWith("/v1/agents") && method === "POST")
          return new Response("{}", { status: 200 });
        if (url.endsWith("/v1/secrets") && method === "GET")
          return new Response("[]", { status: 200 });
        if (url.endsWith("/v1/secrets") && method === "POST")
          return new Response('{"id":"sec-1"}', { status: 201 });
        if (url.endsWith("/secrets")) return new Response(null, { status: 200 });
        return new Response("no", { status: 500 });
      },
    });
    await runSetup(ctx, ["provider-auth"]);
    const env = await readFile(join(root, ".env"), "utf8");
    const host = await readFile(join(root, "host.json"), "utf8");
    const step = await readFile(join(root, "logs", "setup-steps", "01-provider-auth.log"), "utf8");
    expect(env).not.toContain(secret);
    expect(host).not.toContain(secret);
    expect(step).not.toContain(secret);
    expect(step).toContain("Registered the model key for api.deepseek.com.");
  });

  it("updates the secret for the same hostname instead of creating another", async () => {
    const methods: string[] = [];
    let listed = false;
    const saved = await registerBearerSecret({
      url: "http://127.0.0.1:10254",
      apiKey: "oc_file",
      hostname: "api.deepseek.com",
      value: "first",
      agentId: "personal",
      fetchImpl: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        methods.push(`${method} ${url}`);
        if (url.endsWith("/v1/secrets") && method === "GET") {
          listed = true;
          return new Response(
            JSON.stringify({ data: [{ id: "sec-1", hostPattern: "api.deepseek.com" }] }),
            {
              status: 200,
            },
          );
        }
        if (url.endsWith("/v1/secrets/sec-1") && method === "PUT")
          return new Response('{"id":"sec-1"}', { status: 200 });
        if (method === "POST") return new Response("{}", { status: 200 });
        return new Response("no", { status: 500 });
      },
    });
    expect(listed).toBe(true);
    expect(saved).toEqual({ id: "sec-1", created: false });
    expect(methods.some((line) => line.startsWith("POST") && line.endsWith("/v1/secrets"))).toBe(
      false,
    );
    expect(methods).toContain("PUT http://127.0.0.1:10254/v1/secrets/sec-1");
  });
});

describe("container network", () => {
  it("creates a missing internal network and refuses an open one", async () => {
    const root = await installRoot();
    const created = context(root, {
      async exec(command, args) {
        created.commands.push([command, ...args].join(" "));
        if (args[0] === "network" && args[1] === "inspect")
          return { code: 1, stdout: "", stderr: "missing" };
        return ok();
      },
    });
    await runSetupStep("container", created);
    expect(
      created.commands.some((line) => line.includes("network create --internal mybots-isolated")),
    ).toBe(true);

    const reused = context(await installRoot(), {
      async exec(command, args) {
        reused.commands.push([command, ...args].join(" "));
        if (args[1] === "inspect") return ok("true\n");
        return ok();
      },
    });
    await runSetupStep("container", reused);
    expect(reused.commands.some((line) => line.includes("network create"))).toBe(false);

    const open = context(await installRoot(), {
      async exec(command, args) {
        open.commands.push([command, ...args].join(" "));
        if (args[1] === "inspect") return ok("false\n");
        return ok();
      },
    });
    await expect(runSetupStep("container", open)).rejects.toThrow(/not internal/);
    expect(
      open.commands.some((line) => line.includes("network rm") || line.includes("network create")),
    ).toBe(false);
  });
});

describe("service install", () => {
  it("writes a launchd job that does not source the env file or carry the gateway key", async () => {
    const root = await installRoot();
    await writeFile(
      join(root, ".env"),
      "ONECLI_API_KEY=oc_service_key\nHTTPS_PROXY=http://user:pw@proxy.example:8080\n",
      {
        mode: 0o600,
      },
    );
    const ctx = context(root);
    await runSetupStep("service", ctx);
    const slug = installSlug(root);
    const plist = await readFile(launchdPlistPath(ctx.home, slug), "utf8");
    expect(plist).toContain("/usr/local/bin/node");
    expect(plist).toContain("packages/host/dist/index.js");
    expect(plist).not.toContain("oc_service_key");
    expect(plist).not.toContain(".env");
    expect(plist).toContain("http://user:pw@proxy.example:8080");
    expect(plist).toContain("127.0.0.1,localhost,::1");
    const proxy = await readFile(join(root, "data", "service-proxy.env"), "utf8");
    expect(proxy).toContain("HTTPS_PROXY=http://user:pw@proxy.example:8080");
    expect((await stat(join(root, "data", "service-proxy.env"))).mode & 0o777).toBe(0o600);
    expect(ctx.commands.some((line) => line.includes("kickstart -k"))).toBe(true);
  });
});

describe("telegram pairing step", () => {
  it("saves a checked token without logging it and restarts the service", async () => {
    const root = await installRoot();
    const token = `123456789:${"A".repeat(35)}`;
    const ctx = context(root, {
      env: { TELEGRAM_BOT_TOKEN: token },
      async fetch(input) {
        expect(String(input)).toBe(`https://api.telegram.org/bot${token}/getMe`);
        return new Response('{"ok":true}', { status: 200 });
      },
      async waitForPairing() {},
    });
    await runSetup(ctx, ["pair-telegram"]);
    const env = await readFile(join(root, ".env"), "utf8");
    const step = await readFile(join(root, "logs", "setup-steps", "01-pair-telegram.log"), "utf8");
    const host = await readFile(join(root, "host.json"), "utf8");
    expect(env).toContain(`TELEGRAM_BOT_TOKEN=${token}`);
    expect(step).not.toContain(token);
    expect(host).toContain('"instance": "telegram"');
    expect(host).not.toContain(token);
    expect(ctx.commands.some((line) => line.includes("kickstart -k"))).toBe(true);
    const pairing = JSON.parse(
      await readFile(join(root, "data", "telegram-pairing.json"), "utf8"),
    ) as {
      code: string;
    };
    expect(pairing.code).toMatch(/^\d{6}$/u);
    expect((await stat(join(root, ".env"))).mode & 0o777).toBe(0o600);
  });

  it("tells the operator to install the service when restart fails", async () => {
    const root = await installRoot();
    const ctx = context(root, {
      env: { TELEGRAM_BOT_TOKEN: `123456789:${"B".repeat(35)}` },
      async exec() {
        return { code: 1, stdout: "", stderr: "not found" };
      },
    });
    await expect(runSetupStep("pair-telegram", ctx)).rejects.toThrow(/service step/);
  });
});

describe("verify", () => {
  it("fails with a reason when the service is not running", async () => {
    const root = await installRoot();
    await writeFile(join(root, ".env"), "ONECLI_URL=http://127.0.0.1:10254\n", { mode: 0o600 });
    const ctx = context(root, {
      async exec(command, args) {
        ctx.commands.push([command, ...args].join(" "));
        if (command === "launchctl") return { code: 1, stdout: "", stderr: "not loaded" };
        if (args[1] === "inspect") return ok("true\n");
        return ok();
      },
    });
    await expect(runSetup(ctx, ["verify"])).rejects.toThrow(/Run the service step/);
  });

  it("checks the image, internal network, health, service, and CLI socket", async () => {
    const root = await installRoot();
    await writeFile(join(root, ".env"), "ONECLI_URL=http://127.0.0.1:10254\n", { mode: 0o600 });
    await mkdir(join(root, "data"), { recursive: true });
    await listen(join(root, "data", "cli.sock"));
    const ctx = context(root, {
      async exec(_command, args) {
        if (args[1] === "inspect") return ok("true\n");
        return ok("running");
      },
    });
    await runSetupStep("verify", ctx);
  });
});

describe("setup skip", () => {
  it("rejects an unknown step name", async () => {
    const root = await installRoot();
    const ctx = context(root, { env: { MYBOTS_SKIP: "nope" } });
    await expect(runSetup(ctx)).rejects.toThrow(/Unknown MYBOTS_SKIP step: nope/);
  });
});

async function runAndRead(root: string, ctx: SetupContext, step: "gateway"): Promise<string> {
  await runSetup(ctx, [step]);
  return readFile(join(root, "logs", "setup-steps", "01-gateway.log"), "utf8");
}

function listen(file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    servers.push(server);
    server.once("error", reject);
    server.listen(file, () => resolve());
  });
}
