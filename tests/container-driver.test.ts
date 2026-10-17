import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { provisionSession } from "../packages/host/src/container-runner.ts";
import { DockerDriver } from "../packages/host/src/drivers/docker-driver.ts";

test("an unavailable gateway fails before any session runtime is launched", async () => {
  const root = await mkdtemp(join(tmpdir(), "mybots-driver-"));
  try {
    const material = await provisionSession({
      root,
      key: { agentGroupId: "personal", sessionId: "cli" },
      folder: "personal",
      model: {
        provider: "deepseek",
        id: "deepseek-chat",
        baseUrl: "https://api.deepseek.com",
        contextWindow: 65536,
        maxTokens: 8192,
      },
    });
    const driver = new DockerDriver({
      gateway: {
        ensure: async () => {
          throw new Error("Gateway unavailable");
        },
      },
      image: "mybots-agent",
      network: "session-network",
    });
    await expect(driver.start(material, new AbortController().signal)).rejects.toThrow(
      "Gateway unavailable",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provisioned immutable context cannot silently accept a different model endpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "mybots-context-"));
  const input = {
    root,
    key: { agentGroupId: "personal", sessionId: "cli" },
    folder: "personal",
    model: {
      provider: "deepseek",
      id: "deepseek-chat",
      baseUrl: "https://api.deepseek.com",
      contextWindow: 65536,
      maxTokens: 8192,
    },
  };
  try {
    await provisionSession(input);
    await expect(
      provisionSession({ ...input, model: { ...input.model, baseUrl: "https://other.test" } }),
    ).rejects.toThrow("Immutable runner context differs");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adoption rejects an observation that does not match the session", async () => {
  const root = await mkdtemp(join(tmpdir(), "mybots-driver-adopt-"));
  try {
    const material = await provisionSession({
      root,
      key: { agentGroupId: "personal", sessionId: "cli" },
      folder: "personal",
      model: {
        provider: "deepseek",
        id: "deepseek-chat",
        baseUrl: "https://api.deepseek.com",
        contextWindow: 65536,
        maxTokens: 8192,
      },
    });
    const driver = new DockerDriver({
      gateway: { ensure: async () => ({ env: {}, trustFile: "" }) },
      image: "mybots-agent",
      network: "session-network",
    });
    const signal = new AbortController().signal;
    await expect(
      driver.adopt(
        { key: { agentGroupId: "other", sessionId: "cli" }, ref: "mybots-other-cli-x" },
        material,
        signal,
      ),
    ).rejects.toThrow("does not belong to this session");
    await expect(
      driver.adopt({ key: material.key, ref: "foreign-container" }, material, signal),
    ).rejects.toThrow("does not belong to this session");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("container termination can retry after a transient Docker failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "mybots-driver-stop-"));
  try {
    const material = await provisionSession({
      root,
      key: { agentGroupId: "personal", sessionId: "cli" },
      folder: "personal",
      model: {
        provider: "deepseek",
        id: "deepseek-chat",
        baseUrl: "https://api.deepseek.com",
        contextWindow: 65536,
        maxTokens: 8192,
      },
    });
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "docker"),
      `#!${process.execPath}
import { existsSync, writeFileSync } from "node:fs";
const marker = ${JSON.stringify(join(root, "stop-attempted"))};
const operation = process.argv[2];
if (operation === "inspect") process.stdout.write("true\\tpersonal\\tcli\\n");
if (operation === "stop" && !existsSync(marker)) {
  writeFileSync(marker, "failed once");
  process.exit(1);
}
`,
      { mode: 0o700 },
    );
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    const driver = new DockerDriver({
      gateway: { ensure: async () => ({ env: {}, trustFile: "" }) },
      image: "mybots-agent",
      network: "session-network",
    });
    const handle = await driver.adopt(
      { key: material.key, ref: "mybots-personal-cli" },
      material,
      new AbortController().signal,
    );
    await expect(handle.stop()).rejects.toThrow("Docker session cleanup failed");
    await expect(handle.stop()).resolves.toBeUndefined();
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});

test("start and adoption repair a recreated gateway before admitting execution and fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "mybots-driver-network-"));
  try {
    const material = await provisionSession({
      root,
      key: { agentGroupId: "personal", sessionId: "cli" },
      folder: "personal",
      model: {
        provider: "controlled",
        id: "model",
        baseUrl: "https://model.test",
        contextWindow: 32768,
        maxTokens: 4096,
      },
    });
    const trustFile = join(root, "data", "gateway-trust", "ca.pem");
    await mkdir(join(root, "data", "gateway-trust"));
    await writeFile(trustFile, "public trust fixture");
    const stateFile = join(root, "docker-state.json");
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "docker"),
      `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
const file = ${JSON.stringify(stateFile)};
const s = JSON.parse(readFileSync(file, "utf8"));
const args = process.argv.slice(2);
if (args[0] === "network" && args[1] === "inspect") console.log("true");
if (args[0] === "inspect") {
  if (args[1] === "fixture-gateway") console.log(JSON.stringify({State:{Running:true},NetworkSettings:{Networks:{backend:{IPAddress:"172.20.0.2"},...(s.connected?{session:{IPAddress:"172.21.0.2",Aliases:["proxy"]}}:{})}}}));
  else console.log("true\\tpersonal\\tcli");
}
if (args[0] === "network" && args[1] === "connect") {
  if (s.fail) process.exit(1);
  s.connected = args.at(-1) === "fixture-gateway" && args.includes("proxy");
}
if (args[0] === "run") { s.launched++; console.log("mybots-personal-cli"); }
writeFileSync(file, JSON.stringify(s));
`,
      { mode: 0o700 },
    );
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    const driver = new DockerDriver({
      gateway: {
        ensure: async () => ({
          env: {
            HTTP_PROXY: "http://x:fixture@proxy:10255",
            HTTPS_PROXY: "http://x:fixture@proxy:10255",
            NODE_EXTRA_CA_CERTS: "/run/gateway/ca.pem",
          },
          trustFile,
          target: { container: "fixture-gateway", alias: "proxy" },
        }),
      },
      image: "mybots-agent",
      network: "session",
    });
    const readState = async () => JSON.parse(await readFile(stateFile, "utf8"));
    await writeFile(stateFile, JSON.stringify({ connected: false, launched: 0 }));
    const handle = await driver.start(material, new AbortController().signal);
    expect(await readState()).toMatchObject({ connected: true, launched: 1 });
    await handle.stop();
    await writeFile(stateFile, JSON.stringify({ connected: false, launched: 1 }));
    const adopted = await driver.adopt(
      { key: material.key, ref: "mybots-personal-cli" },
      material,
      new AbortController().signal,
    );
    expect(await readState()).toMatchObject({ connected: true, launched: 1 });
    await adopted.stop();
    await writeFile(stateFile, JSON.stringify({ connected: false, launched: 1, fail: true }));
    await expect(driver.start(material, new AbortController().signal)).rejects.toThrow();
    expect(await readState()).toMatchObject({ connected: false, launched: 1 });
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent session starts share a gateway attachment repaired by either caller", async () => {
  const root = await mkdtemp(join(tmpdir(), "mybots-driver-concurrent-network-"));
  try {
    const materials = await Promise.all(
      ["cli", "telegram"].map((sessionId) =>
        provisionSession({
          root,
          key: { agentGroupId: "personal", sessionId },
          folder: "personal",
          model: {
            provider: "controlled",
            id: "model",
            baseUrl: "https://model.test",
            contextWindow: 32768,
            maxTokens: 4096,
          },
        }),
      ),
    );
    const trustFile = join(root, "data", "gateway-trust", "ca.pem");
    await mkdir(join(root, "data", "gateway-trust"));
    await writeFile(trustFile, "public trust fixture");
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "docker"),
      `#!${process.execPath}
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
const root = ${JSON.stringify(root)};
const endpoint = root + "/gateway-endpoint";
const args = process.argv.slice(2);
if (args[0] === "network" && args[1] === "inspect") console.log("true");
if (args[0] === "inspect" && args[1] === "onecli") {
  const attached = existsSync(endpoint);
  writeFileSync(root + "/inspect-" + process.pid, "");
  const deadline = Date.now() + 3000;
  while (readdirSync(root).filter(x => x.startsWith("inspect-")).length < 2) {
    if (Date.now() > deadline) process.exit(1);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  console.log(JSON.stringify({State:{Running:true},NetworkSettings:{Networks:{backend:{IPAddress:"172.20.0.2"},...(attached?{session:{IPAddress:"172.21.0.2",Aliases:["proxy"]}}:{})}}}));
}
if (args[0] === "network" && args[1] === "connect") {
  try { mkdirSync(endpoint); } catch { process.exit(1); }
}
if (args[0] === "run") console.log(args[args.indexOf("--name")+1]);
`,
      { mode: 0o700 },
    );
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    const driver = new DockerDriver({
      gateway: {
        ensure: async () => ({
          trustFile,
          target: { container: "onecli", alias: "proxy" },
          env: {
            HTTPS_PROXY: "http://x:fixture@proxy:10255",
            HTTP_PROXY: "http://x:fixture@proxy:10255",
            NODE_EXTRA_CA_CERTS: "/run/gateway/ca.pem",
          },
        }),
      },
      image: "mybots-agent",
      network: "session",
    });
    const results = await Promise.allSettled(
      materials.map((material) => driver.start(material, new AbortController().signal)),
    );
    try {
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    } finally {
      await Promise.all(
        results
          .filter((result) => result.status === "fulfilled")
          .map((result) => result.value.stop()),
      );
    }
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
