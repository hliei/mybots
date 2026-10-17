import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

test("actual mounted runner uses OneCLI injection and reopens its explicit Pi conversation", async () => {
  const root = await mkdtemp(join(tmpdir(), "mybots-infrastructure-"));
  const project = `mybots-infra-${randomUUID().slice(0, 8)}`;
  const credential = randomUUID();
  const signal = AbortSignal.timeout(180000);
  const env = { ...process.env, MYBOTS_INFRA_ROOT: root, MYBOTS_FIXTURE_CREDENTIAL: credential };
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
        `Infrastructure Docker operation failed: ${detail.replaceAll(credential, "[redacted]")}`,
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
        "subjectAltName=DNS:model.test",
      ],
      { timeout: 10000 },
    );
    started = true;
    await docker([...compose, "up", "--detach", "--wait", "--wait-timeout", "120"], 150000);
    const gatewayContainer = await docker([...compose, "ps", "-q", "gateway"]);
    const gatewayNetworks = JSON.parse(
      await docker(["inspect", gatewayContainer, "--format", "{{json .NetworkSettings.Networks}}"]),
    );
    expect(gatewayNetworks[`${project}_session`]?.Aliases).toContain("proxy");
    const postgresContainer = await docker([...compose, "ps", "-q", "postgres"]);
    const postgresNetworks = JSON.parse(
      await docker([
        "inspect",
        postgresContainer,
        "--format",
        "{{json .NetworkSettings.Networks}}",
      ]),
    );
    expect(Object.keys(postgresNetworks)).toEqual([`${project}_backend`]);
    const gatewayUrl = `http://${await docker([...compose, "port", "gateway", "10254"])}`;
    const upstreamUrl = `http://${await docker([...compose, "port", "upstream", "8080"])}`;
    await request(`${gatewayUrl}/v1/secrets`, {
      name: "controlled-model",
      type: "generic",
      value: credential,
      hostPattern: "model.test",
      injectionConfig: { headerName: "Authorization", valueFormat: "Bearer {value}" },
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
    });
    await writeFile(join(root, "data", "host.db"), "Host-owned operational store");
    await writeFile(join(root, "data", "channel-token"), randomUUID());
    await writeFile(join(root, "data", "mount-policy.json"), "Host-owned mount policy");
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
    await expect(
      new DockerDriver({
        gateway,
        image: "mybots-agent:mailbox",
        network: `${project}_backend`,
      }).start(material, signal),
    ).rejects.toThrow("Docker session unavailable or invalid");
    handle = await driver.start(material, signal);
    // Use direct sockets without the runner's proxy environment for these probes.
    const networkEvidence = JSON.parse(
      await docker([
        "exec",
        "--env",
        "HTTP_PROXY=",
        "--env",
        "HTTPS_PROXY=",
        handle.ref,
        "bun",
        "-e",
        'import { lookup } from "node:dns/promises"; import { createConnection } from "node:net"; const denied = (host,port) => new Promise(resolve => { const socket = createConnection({host,port}); socket.setTimeout(1500); socket.once("connect", () => { socket.destroy(); resolve(false); }); socket.once("error", () => { socket.destroy(); resolve(true); }); socket.once("timeout", () => { socket.destroy(); resolve(true); }); }); const management = await fetch("http://proxy:10254/v1/agents", {signal: AbortSignal.timeout(5000)}); console.log(JSON.stringify({address:(await lookup("proxy")).address, management:management.status, internetDenied:await denied("1.1.1.1",443), databaseDenied:await denied(process.argv[1],5432)}));',
        postgresNetworks[`${project}_backend`].IPAddress,
      ]),
    );
    expect(networkEvidence).toEqual({
      address: gatewayNetworks[`${project}_session`].IPAddress,
      management: 200,
      internetDenied: true,
      databaseDenied: true,
    });
    host.submit({
      id: "first",
      content: "Save a shared note and check the mount isolation",
      channel_type: "cli",
      platform_id: "owner",
      thread_id: null,
    });
    const stopped = handle.wait().then(() => {
      throw new Error("Runner stopped before reply");
    });
    const first = await Promise.race([eventually(() => host.outputs()[0], signal), stopped]);
    expect(first).toMatchObject({
      in_reply_to: "first",
      content: "Saved the shared note in the isolated container.",
      seq: 1,
      kind: "message",
    });
    expect(await readFile(join(material.workspace, "note.txt"), "utf8")).toBe(
      "Shared Agent note\n",
    );
    const continuation = host.continuation();
    expect(continuation).toMatch(/^pi:\/session\/pi\/sessions\//);
    expect(host.acknowledgements()).toContainEqual(
      expect.objectContaining({ message_id: "first", status: "completed" }),
    );
    host.submit({
      id: "while-running",
      content: "Continue while the container is running and read the note",
      channel_type: "cli",
      platform_id: "owner",
      thread_id: null,
    });
    const whileRunning = await Promise.race([
      eventually(() => host.outputs().find((row) => row.in_reply_to === "while-running"), signal),
      stopped,
    ]);
    expect(whileRunning).toMatchObject({
      seq: 3,
      kind: "message",
      content: "Reopened the saved conversation and read the shared note.",
    });
    // The runtime reports the live container and adoption takes it over without
    // creating a duplicate.
    const live = (await driver.list(signal)).find((item) => item.key.sessionId === "cli");
    if (!live) throw new Error("The runtime did not report the live session container");
    await docker(["network", "disconnect", `${project}_session`, gatewayContainer]);
    const adopted = await driver.adopt(live, material, signal);
    expect(adopted.ref).toBe(live.ref);
    // Stop also settles the driver wait resource.
    await handle.stop();
    await stopped.catch(() => {});
    handle = undefined;
    // Termination is visible in the observed runtime state.
    expect((await driver.list(signal)).some((item) => item.ref === live.ref)).toBe(false);
    const reopened = new HostMailbox(material.directory);
    reopened.submit({
      id: "second",
      content: "Continue the original conversation and read the note",
      channel_type: "telegram",
      platform_id: "owner-chat",
      thread_id: "thread",
    });
    await docker(
      [...compose, "up", "--detach", "--force-recreate", "--no-deps", "--wait", "gateway"],
      150000,
    );
    const recreatedGateway = await docker([...compose, "ps", "-q", "gateway"]);
    expect(recreatedGateway).not.toBe(gatewayContainer);
    await docker(["network", "disconnect", `${project}_session`, recreatedGateway]);
    // The provider tracks the stable Compose name across replacement, not a stale ID.
    const gatewayName = await docker(["inspect", recreatedGateway, "--format", "{{.Name}}"]);
    const recoveredDriver = new DockerDriver({
      gateway: new OneCliGateway({
        url: `http://${await docker([...compose, "port", "gateway", "10254"])}`,
        proxyHost: "proxy",
        containerName: gatewayName.slice(1),
        trustDirectory: join(root, "data", "gateway-trust"),
      }),
      image: "mybots-agent:mailbox",
      network: `${project}_session`,
    });
    handle = await recoveredDriver.start(material, signal);
    const second = await Promise.race([
      eventually(() => reopened.outputs().find((row) => row.in_reply_to === "second"), signal),
      handle.wait().then(() => {
        throw new Error("Recreated runner stopped before reply");
      }),
    ]);
    expect(second).toMatchObject({
      seq: 5,
      content: "Reopened the saved conversation and read the shared note.",
      platform_id: "owner-chat",
      thread_id: "thread",
    });
    expect(reopened.continuation()).toBe(continuation);
    const evidence = (await fetch(upstreamUrl, { signal }).then((response) => response.json())) as {
      injected: boolean;
      requests: Array<{ messages: unknown[] }>;
    };
    expect(evidence.injected).toBe(true);
    expect(evidence.requests).toHaveLength(6);
    expect(JSON.stringify(evidence.requests[1])).toContain("Mount isolation passed");
    expect(JSON.stringify(evidence.requests[5])).toContain("Shared Agent note");
    expect(JSON.stringify(evidence.requests[4])).toContain("Save a shared note");
    for (const directory of [
      material.directory,
      material.workspace,
      join(root, "data", "gateway-trust"),
      join(root, "data", "sessions", "personal", ".context"),
    ])
      expect(await contents(directory)).not.toContain(credential);
    reopened.syncAcknowledgements();
    expect(reopened.inputs().map(({ status }) => status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
    expect(reopened.deliveryStatus(first.id)).toBeUndefined();
    reopened.markDelivered(first.id, "delivered");
    expect(new HostMailbox(material.directory).deliveryStatus(first.id)).toBe("delivered");
    process.stdout.write(
      "Infrastructure passed: mounted freshness, tool isolation, gateway injection, streaming reply, explicit Pi reopening, runtime observation/adoption and observed container termination.\n",
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
});
