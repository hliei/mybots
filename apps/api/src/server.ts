import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { botConfiguration } from "@mybots/contracts";
import { ProductDatabase } from "@mybots/db";
import { LocalAccess } from "./local-access.ts";
import { startWorker } from "./worker-client.ts";

async function body(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65536) throw new Error("Request too large");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

export interface ApiServer {
  url: string;
  close(): Promise<void>;
}

export async function startApi(root: string, port = 0): Promise<ApiServer> {
  await mkdir(join(root, "data"), { recursive: true, mode: 0o700 });
  const access = await LocalAccess.load(root);
  const worker = await startWorker(root);
  const database = new ProductDatabase(join(root, "data", "product.sqlite"));
  const streams = new Set<ServerResponse>();
  void worker.closed.then(() => {
    for (const stream of streams) stream.end();
  });
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) json(response, { error: "Request failed" }, 400);
      else response.end();
    });
  });
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;
    const isApi = path.startsWith("/api/");
    const rejection = access.rejection(request, isApi);
    if (rejection) {
      json(
        response,
        { error: rejection === 401 ? "Connection required" : "Origin rejected" },
        rejection,
      );
      return;
    }
    if (path === "/api/pair" && request.method === "POST") {
      response.writeHead(204, { "Set-Cookie": access.cookie(), "Cache-Control": "no-store" });
      response.end();
      return;
    }
    if (path === "/api/bots" && request.method === "GET") {
      json(response, { bots: database.bots(), models: worker.models });
      return;
    }
    if (path === "/api/bots" && request.method === "POST") {
      const configuration = botConfiguration(await body(request), worker.models);
      json(response, await worker.request({ action: "create", configuration }), 201);
      return;
    }
    if (path === "/api/skills" && request.method === "GET") {
      json(response, { skills: database.skills().map(({ content: _content, ...skill }) => skill) });
      return;
    }
    const skill = /^\/api\/skills\/([a-z][a-z0-9-]{0,79})$/.exec(path);
    if (skill) {
      const name = skill[1] as string;
      if (request.method === "GET") json(response, database.skill(name));
      else if (request.method === "PUT")
        json(response, database.writeSkill(name, await body(request)));
      else if (request.method === "DELETE") {
        database.deleteSkill(name);
        json(response, {});
      } else json(response, { error: "Not found" }, 404);
      return;
    }
    const memory = /^\/api\/(?:memory\/(owner)|bots\/([^/]+)\/memory)$/.exec(path);
    if (memory) {
      const scope = memory[1] ? "owner" : "bot";
      const botId = memory[2];
      if (request.method === "GET") json(response, database.memory(scope, botId));
      else if (request.method === "PUT") {
        const value = (await body(request)) as { content?: unknown } | null;
        json(response, database.writeMemory(scope, value?.content, botId));
      } else if (request.method === "DELETE") {
        database.deleteMemory(scope, botId);
        json(response, {});
      } else json(response, { error: "Not found" }, 404);
      return;
    }
    const match = /^\/api\/bots\/([^/]+)(?:\/(chat|events|send|stop))?$/.exec(path);
    if (match) {
      const botId = match[1] as string;
      database.bot(botId);
      const action = match[2];
      if (!action && request.method === "PATCH") {
        const bot = database.update(botId, botConfiguration(await body(request), worker.models));
        await worker.request({ action: "configure", botId });
        json(response, bot);
        return;
      }
      if (action === "chat" && request.method === "GET") {
        json(response, await worker.request({ action: "view", botId }));
        return;
      }
      if (action === "send" && request.method === "POST") {
        const value = (await body(request)) as Record<string, unknown>;
        if (
          !value ||
          typeof value.text !== "string" ||
          !value.text.trim() ||
          value.text.length > 32000 ||
          typeof value.requestId !== "string" ||
          !/^[a-zA-Z0-9_-]{1,100}$/.test(value.requestId)
        )
          throw new Error("Invalid input");
        json(
          response,
          await worker.request({
            action: "send",
            botId,
            text: value.text,
            requestId: value.requestId,
          }),
          202,
        );
        return;
      }
      if (action === "stop" && request.method === "POST") {
        await worker.request({ action: "stop", botId });
        json(response, {});
        return;
      }
      if (action === "events" && request.method === "GET") {
        const subscription = randomUUID();
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no",
        });
        response.flushHeaders();
        streams.add(response);
        worker.subscribers.set(subscription, (view) => {
          if (response.writableLength > 1024 * 1024) response.destroy();
          else response.write(`data: ${JSON.stringify(view)}\n\n`);
        });
        response.once("close", () => {
          streams.delete(response);
          worker.subscribers.delete(subscription);
          void worker.request({ action: "unsubscribe", subscription }).catch(() => {});
        });
        await worker.request({ action: "subscribe", botId, subscription });
        if (response.destroyed) await worker.request({ action: "unsubscribe", subscription });
        return;
      }
    }
    if (!isApi && request.method === "GET") {
      const asset = path === "/" ? "index.html" : path.slice(1);
      if (!/^(index\.html|style\.css|[a-z-]+\.js|vendor\/marked\.js)$/.test(asset)) {
        json(response, { error: "Not found" }, 404);
        return;
      }
      const content = await readFile(new URL(`../../web/dist/${asset}`, import.meta.url));
      response.writeHead(200, {
        "Content-Type": asset.endsWith(".html")
          ? "text/html; charset=utf-8"
          : asset.endsWith(".css")
            ? "text/css"
            : "text/javascript",
        "Content-Security-Policy":
          "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      });
      response.end(content);
      return;
    }
    json(response, { error: "Not found" }, 404);
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
  } catch (error) {
    await worker.close();
    database.close();
    throw error;
  }
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    async close(): Promise<void> {
      for (const stream of streams) stream.end();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await worker.close();
      database.close();
    },
  };
}
