import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { HostMailbox } from "@mybots/mailbox/node";
import { expect, test } from "vitest";
import { provisionSession } from "../../packages/host/src/container-runner.ts";
import { DockerDriver } from "../../packages/host/src/drivers/docker-driver.ts";
import type { SessionHandle } from "../../packages/host/src/drivers/types.ts";
import { OneCliGateway } from "../../packages/host/src/gateway-providers/onecli.ts";

const execute = promisify(execFile);

async function eventually<T>(observe: () => T | undefined, signal: AbortSignal): Promise<T> {
  while (!signal.aborted) {
    const value = observe();
    if (value !== undefined) return value;
    await setTimeout(100, undefined, { signal });
  }
  throw new Error("Infrastructure checkpoint timed out");
}

async function contents(directory: string): Promise<string> {
  const values = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    values.push(entry.isDirectory() ? await contents(path) : (await readFile(path)).toString());
  }
  return values.join("\n");
}

test("the actual runner reaches the scoped search gateway target with fixture credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "mybots-web-infrastructure-"));
  const project = `mybots-web-infra-${randomUUID().slice(0, 8)}`;
  const modelCredential = randomUUID();
  const searchCredential = randomUUID();
  const signal = AbortSignal.timeout(180000);
  const env = {
    ...process.env,
    MYBOTS_INFRA_ROOT: root,
    MYBOTS_FIXTURE_CREDENTIAL: modelCredential,
    MYBOTS_SEARCH_FIXTURE_CREDENTIAL: searchCredential,
  };
  const compose = [
    "compose",
    "--project-name",
    project,
    "-f",
    resolve("tests/infrastructure/compose.yml"),
  ];
  let handle: SessionHandle | undefined;
  let started = false;
  const docker = async (args: string[], timeout = 30000) => {
    try {
      return (
        await execute("docker", args, { env, timeout, maxBuffer: 1024 * 1024 })
      ).stdout.trim();
    } catch (error) {
      const detail = (error as { stderr?: string }).stderr ?? "No Docker diagnostic";
      throw new Error(
        `Infrastructure Docker operation failed: ${detail
          .replaceAll(modelCredential, "[redacted]")
          .replaceAll(searchCredential, "[redacted]")}`,
      );
    }
  };
  const request = async (url: string, body: unknown) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw new Error(`Fixture gateway setup failed (${response.status})`);
    return response.json();
  };
  try {
    await mkdir(join(root, "tls"));
    await execute(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(root, "tls", "key.pem"),
        "-out",
        join(root, "tls", "cert.pem"),
        "-days",
        "1",
        "-subj",
        "/CN=model.test",
        "-addext",
        "subjectAltName=DNS:model.test,DNS:search.test",
      ],
      { timeout: 10000 },
    );
    started = true;
    await docker([...compose, "up", "--detach", "--wait", "--wait-timeout", "120"], 150000);
    const gatewayUrl = `http://${await docker([...compose, "port", "gateway", "10254"])}`;
    const upstreamUrl = `http://${await docker([...compose, "port", "upstream", "8080"])}`;
    await request(`${gatewayUrl}/v1/secrets`, {
      name: "controlled-model",
      type: "generic",
      value: modelCredential,
      hostPattern: "model.test",
      injectionConfig: { headerName: "Authorization", valueFormat: "Bearer {value}" },
    });
    await request(`${gatewayUrl}/v1/secrets`, {
      name: "controlled-search",
      type: "generic",
      value: searchCredential,
      hostPattern: "search.test",
      injectionConfig: { headerName: "X-Subscription-Token", valueFormat: "{value}" },
    });
    const material = await provisionSession({
      root,
      key: { agentGroupId: "personal", sessionId: "cli" },
      folder: "personal",
      model: {
        provider: "controlled",
        id: "controlled-model",
        baseUrl: "https://model.test:8443/v1",
        contextWindow: 32768,
        maxTokens: 4096,
      },
      resources: { tools: ["read", "web_search"] },
      web: {
        search: { provider: "brave", endpoint: "https://search.test:8443/res/v1/web/search" },
      },
    });
    const gateway = new OneCliGateway({
      url: gatewayUrl,
      proxyHost: "proxy",
      containerName: await docker([...compose, "ps", "-q", "gateway"]),
      trustDirectory: join(root, "data", "gateway-trust"),
    });
    const driver = new DockerDriver({
      gateway,
      image: "mybots-agent:mailbox",
      network: `${project}_session`,
    });
    const host = new HostMailbox(material.directory);
    handle = await driver.start(material, signal);
    host.submit({
      id: "search",
      content: "Search the web for the fixture source",
      channel_type: "cli",
      platform_id: "owner",
      thread_id: null,
    });
    const stopped = handle.wait().then(() => {
      throw new Error("Runner stopped before reply");
    });
    const reply = await Promise.race([eventually(() => host.outputs()[0], signal), stopped]);
    expect(reply).toMatchObject({
      in_reply_to: "search",
      content: "Search returned the fixture source.",
      seq: 1,
      kind: "message",
    });
    const evidence = (await fetch(upstreamUrl, { signal }).then((response) => response.json())) as {
      injected: boolean;
      searchInjected: boolean;
      searchRequests: { url: string; token: string }[];
    };
    expect(evidence.injected).toBe(true);
    expect(evidence.searchInjected).toBe(true);
    expect(evidence.searchRequests).toHaveLength(1);
    expect(evidence.searchRequests[0]?.url).toContain("q=fixture");
    for (const directory of [
      material.directory,
      material.workspace,
      join(root, "data", "gateway-trust"),
    ])
      expect(await contents(directory)).not.toContain(searchCredential);
    const context = await readFile(material.contextFile, "utf8");
    expect(context).toContain("search.test");
    expect(context).not.toContain(searchCredential);
    expect(context).not.toContain(modelCredential);
    process.stdout.write(
      "Infrastructure passed: the scoped search gateway target injected fixture credentials and the runner replied through the mailbox.\n",
    );
  } finally {
    try {
      await handle?.stop();
    } finally {
      try {
        if (started) await docker([...compose, "down", "--volumes", "--remove-orphans"], 30000);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
}, 240000);
