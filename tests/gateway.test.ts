import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { OneCliGateway } from "../packages/host/src/gateway-providers/onecli.ts";

test("OneCLI contributes only scoped proxy identity, placeholder auth and public trust", async () => {
  let modelAuth = "placeholder";
  let healthy = true;
  const certificate = await readFile(
    new URL("./fixtures/gateway/public-ca.pem", import.meta.url),
    "utf8",
  );
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/v1/health" && !healthy) {
      response.writeHead(503);
      response.end("{}");
      return;
    }
    if (request.url?.startsWith("/v1/container-config"))
      response.end(
        JSON.stringify({
          env: {
            HTTPS_PROXY: "http://x:scoped-agent@localhost:10255",
            HTTP_PROXY: "http://x:scoped-agent@localhost:10255",
            ANTHROPIC_API_KEY: modelAuth,
            NODE_EXTRA_CA_CERTS: "/tmp/onecli-gateway-ca.pem",
          },
          caCertificate: certificate,
          caCertificateContainerPath: "/tmp/onecli-gateway-ca.pem",
        }),
      );
    else
      response.end(
        JSON.stringify({ name: "personal", identifier: "personal", created: false, status: "ok" }),
      );
  });
  const root = await mkdtemp(join(tmpdir(), "mybots-gateway-"));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const gateway = new OneCliGateway({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      proxyHost: "gateway",
      trustDirectory: join(root, "trust"),
    });
    const contribution = await gateway.ensure(
      { agentGroupId: "personal", sessionId: "cli" },
      new AbortController().signal,
    );
    expect(contribution.target).toEqual({ container: "onecli", alias: "gateway" });
    expect(contribution.env).toEqual({
      HTTPS_PROXY: "http://x:scoped-agent@gateway:10255/",
      HTTP_PROXY: "http://x:scoped-agent@gateway:10255/",
      NODE_EXTRA_CA_CERTS: "/run/gateway/ca.pem",
    });
    expect(new X509Certificate(await readFile(contribution.trustFile)).subject).toBe(
      "CN=Controlled CA",
    );
    expect(contribution.trustFile).toContain(join(root, "trust"));
    modelAuth = "unexpected-credential-material";
    await expect(
      gateway.ensure({ agentGroupId: "personal", sessionId: "cli" }, new AbortController().signal),
    ).rejects.toThrow("OneCLI gateway unavailable or unusable");
    modelAuth = "placeholder";
    healthy = false;
    await expect(
      gateway.ensure({ agentGroupId: "personal", sessionId: "cli" }, new AbortController().signal),
    ).rejects.toThrow("OneCLI gateway unavailable or unusable");
  } finally {
    try {
      server.closeAllConnections();
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
