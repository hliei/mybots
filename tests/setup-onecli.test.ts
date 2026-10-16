import { createServer, type Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import { registerBearerSecret } from "../setup/onecli.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

it("creates, rotates and grants hostname keys using database Agent IDs while preserving grants", async () => {
  let agentExists = false;
  const secrets: { id: string; hostPattern: string; value: string }[] = [];
  let grants = ["existing-grant"];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : undefined;
    const route = `${request.method} ${request.url}`;
    const reply = (status: number, value: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (
      request.headers.authorization !== "Bearer oc_fixture" ||
      request.headers["x-project-id"] !== "project-1"
    ) {
      reply(401, {});
    } else if (route === "POST /v1/agents") {
      reply(agentExists ? 409 : 201, { id: "database-agent-id", identifier: "personal" });
      agentExists = true;
    } else if (route === "GET /v1/agents") {
      reply(200, [{ id: "database-agent-id", identifier: "personal" }]);
    } else if (route === "GET /v1/secrets") {
      reply(200, secrets);
    } else if (route === "POST /v1/secrets") {
      const secret = { ...body, id: `secret-${secrets.length + 1}` };
      secrets.push(secret);
      reply(201, secret);
    } else if (request.method === "PATCH" && request.url?.startsWith("/v1/secrets/")) {
      const secret = secrets.find((item) => request.url === `/v1/secrets/${item.id}`);
      if (!secret) return reply(404, {});
      Object.assign(secret, body);
      reply(200, { success: true });
    } else if (route === "GET /v1/agents/database-agent-id/secrets") {
      reply(200, grants);
    } else if (
      route === "PUT /v1/agents/database-agent-id/secrets" &&
      Array.isArray(body.secretIds)
    ) {
      grants = body.secretIds;
      reply(200, { success: true });
    } else {
      reply(405, {});
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const input = {
    url: `http://127.0.0.1:${address.port}`,
    apiKey: "oc_fixture",
    projectId: "project-1",
    agentId: "personal",
    fetchImpl: fetch,
  };
  await expect(
    registerBearerSecret({ ...input, hostname: "model.test", value: "first" }),
  ).resolves.toEqual({ id: "secret-1", created: true });
  await expect(
    registerBearerSecret({ ...input, hostname: "model.test", value: "rotated" }),
  ).resolves.toEqual({ id: "secret-1", created: false });
  await registerBearerSecret({ ...input, hostname: "search.test", value: "search-key" });
  expect(secrets.map(({ hostPattern, value }) => ({ hostPattern, value }))).toEqual([
    { hostPattern: "model.test", value: "rotated" },
    { hostPattern: "search.test", value: "search-key" },
  ]);
  expect(grants).toEqual(["existing-grant", "secret-1", "secret-2"]);
});
