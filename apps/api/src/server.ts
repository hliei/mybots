import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { botConfiguration, type ModelChoice } from "@mybots/contracts";
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

export async function startApi(root: string, port = 0, signal?: AbortSignal): Promise<ApiServer> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const access = await LocalAccess.load(root);
  const worker = await startWorker(root, signal);
  const database = new ProductDatabase(join(root, "product.sqlite"));
  const streams = new Set<ServerResponse>();
  worker.onStatus.add((status) => {
    for (const stream of streams)
      stream.write(`event: worker\ndata: ${JSON.stringify(status)}\n\n`);
  });
  function openStream(response: ServerResponse): void {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();
    streams.add(response);
    response.write(`event: worker\ndata: ${JSON.stringify(worker.status)}\n\n`);
    response.once("close", () => streams.delete(response));
  }
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      const unavailable =
        error instanceof Error &&
        /^(Model unavailable\.|Worker |Computer recovery cleanup failed\.)/.test(error.message);
      if (!response.headersSent)
        json(
          response,
          { error: unavailable ? (error as Error).message : "Request failed" },
          unavailable && worker.status.state !== "ready" && worker.status.state !== "recovered"
            ? 503
            : 400,
        );
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
    if (path === "/api/worker/events" && request.method === "GET") {
      openStream(response);
      return;
    }
    if (path === "/api/worker" && request.method === "GET") {
      json(response, worker.status);
      return;
    }
    if (path === "/api/providers" && request.method === "GET") {
      json(response, await worker.request({ action: "providers" }));
      return;
    }
    const provider = /^\/api\/providers\/(deepseek|opencode-go)$/.exec(path);
    if (provider && (request.method === "PUT" || request.method === "DELETE")) {
      const value = request.method === "PUT" ? await body(request) : undefined;
      json(
        response,
        await worker.request({
          action: "provider-update",
          provider: provider[1] as "deepseek" | "opencode-go",
          apiKey:
            value && typeof value === "object"
              ? (value as Record<string, unknown>).apiKey
              : undefined,
          remove: request.method === "DELETE",
        }),
      );
      return;
    }
    const modelChoices = async () => (await worker.request({ action: "models" })) as ModelChoice[];
    if (path === "/api/bots" && request.method === "GET") {
      const models = await modelChoices().catch((error: unknown) => {
        if (worker.status.state === "recovering" || worker.status.state === "failed") return [];
        throw error;
      });
      json(response, { bots: database.bots(), models, worker: worker.status });
      return;
    }
    if (path === "/api/bots" && request.method === "POST") {
      const configuration = botConfiguration(await body(request), await modelChoices());
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
    const history = /^\/api\/bots\/([^/]+)\/history(?:\/([^/]+))?$/.exec(path);
    if (history && request.method === "GET") {
      const botId = history[1] as string;
      database.bot(botId);
      const entryId = history[2];
      json(
        response,
        await worker.request(
          entryId === undefined
            ? {
                action: "history-search",
                botId,
                query: url.searchParams.get("query") ?? "",
                before: url.searchParams.has("before")
                  ? Number(url.searchParams.get("before"))
                  : undefined,
              }
            : {
                action: "history-read",
                botId,
                entryId: Number(entryId),
                offset: url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : 0,
              },
        ),
      );
      return;
    }
    const match = /^\/api\/bots\/([^/]+)(?:\/(chat|events|send|stop))?$/.exec(path);
    if (match) {
      const botId = match[1] as string;
      database.bot(botId);
      const action = match[2];
      if (!action && request.method === "PATCH") {
        const current = database.bot(botId);
        const choices = await modelChoices();
        const bot = database.update(
          botId,
          botConfiguration(await body(request), [
            ...choices,
            { id: current.model, name: "Unavailable saved model" },
          ]),
        );
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
        openStream(response);
        worker.subscribe(subscription, botId, (view) => {
          if (response.writableLength > 1024 * 1024) response.destroy();
          else response.write(`data: ${JSON.stringify(view)}\n\n`);
        });
        response.once("close", () => {
          worker.unsubscribe(subscription);
        });
        if (response.destroyed) worker.unsubscribe(subscription);
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
    try {
      await worker.close();
    } finally {
      database.close();
    }
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
      try {
        await worker.close();
      } finally {
        database.close();
      }
    },
  };
}
