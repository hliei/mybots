import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BotRequestError } from "../bots.ts";
import { ChatRequestError } from "../chat.ts";
import type { Host } from "../host.ts";
import type { LocalAccess } from "./local-access.ts";

const ASSETS = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/main.js", ["main.js", "text/javascript; charset=utf-8"]],
  ["/history.js", ["history.js", "text/javascript; charset=utf-8"]],
  ["/chat.js", ["chat.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);

/** The Host serves a fixed set of built assets and authenticated Bot operations and reads. */
export async function serveClient(
  request: IncomingMessage,
  response: ServerResponse,
  host: Host,
  access: LocalAccess,
  socketPath: string,
): Promise<void> {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  const asset = ASSETS.get(path);
  const denial = access.rejection(request, !asset);
  if (denial) {
    response.writeHead(denial);
    response.end();
    return;
  }
  if (path === "/api/pair" && request.method === "POST") {
    response.writeHead(204, { "Set-Cookie": access.cookie() });
    response.end();
    return;
  }
  if (path === "/api/status" && request.method === "GET") {
    const snapshot = await host.clientStatus();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(snapshot));
    return;
  }
  if (path === "/api/bot-options" && request.method === "GET") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(host.botOptions()));
    return;
  }
  if (path === "/api/bots" && request.method === "GET") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ bots: host.managedBots() }));
    return;
  }
  const runHistoryRoute = /^\/api\/bots\/([^/]+)\/runs\/([^/]+)\/history$/.exec(path);
  const historyRoute = /^\/api\/bots\/([^/]+)\/thread\/history$/.exec(path);
  if ((historyRoute || runHistoryRoute) && request.method === "GET") {
    try {
      const params = new URL(request.url ?? "/", "http://localhost").searchParams;
      const input = Object.fromEntries(
        [...params].map(([key, value]) => [
          key,
          ["beforeSeq", "textOffset"].includes(key) ? Number(value) : value,
        ]),
      );
      const result = runHistoryRoute
        ? await host.runHistory(runHistoryRoute[1] as string, runHistoryRoute[2] as string, input)
        : await host.threadHistory(historyRoute?.[1] as string, input);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(error instanceof ChatRequestError ? error.status : 503, {
        "Content-Type": "application/json",
      });
      response.end(
        JSON.stringify({
          error: error instanceof ChatRequestError ? error.message : "History unavailable.",
        }),
      );
    }
    return;
  }
  const runOperation = /^\/api\/bots\/([^/]+)\/runs\/([^/]+)\/(stop|retry|close)$/.exec(path);
  const taskStop = /^\/api\/bots\/([^/]+)\/tasks\/([^/]+)\/stop$/.exec(path);
  if ((runOperation || taskStop) && request.method === "POST") {
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length;
        if (bytes > 65536) {
          request.resume();
          throw new ChatRequestError("Chat request exceeds 64 KiB.", 413);
        }
        chunks.push(chunk);
      }
      let input: unknown;
      try {
        input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new ChatRequestError("Chat operations require valid JSON.");
      }
      const botId = (runOperation?.[1] ?? taskStop?.[1]) as string;
      const result = taskStop
        ? await host.stopTask(botId, taskStop[2] as string, input)
        : runOperation?.[3] === "retry"
          ? await host.retryRun(botId, runOperation[2] as string, input)
          : runOperation?.[3] === "close"
            ? await host.closeRun(botId, runOperation[2] as string, input)
            : await host.stopRun(botId, runOperation?.[2] as string, input);
      response.writeHead(202, { "Content-Type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(error instanceof ChatRequestError ? error.status : 503, {
        "Content-Type": "application/json",
      });
      response.end(
        JSON.stringify({
          error:
            error instanceof ChatRequestError
              ? error.message
              : "Run operation unavailable. Retry with the same requestId.",
        }),
      );
    }
    return;
  }
  const threadRoute = /^\/api\/bots\/([^/]+)\/thread(?:\/(messages|tasks))?$/.exec(path);
  const taskRoute = /^\/api\/bots\/([^/]+)\/tasks\/([^/]+)\/inputs$/.exec(path);
  if (threadRoute || taskRoute) {
    try {
      let result: object;
      if (request.method === "GET" && threadRoute && !threadRoute[2]) {
        result = await host.threadDetail(threadRoute[1] as string);
      } else if (request.method === "POST" && (threadRoute?.[2] || taskRoute)) {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request.iterator({ destroyOnReturn: false })) {
          bytes += chunk.length;
          if (bytes > 262144) {
            request.resume();
            throw new ChatRequestError("Chat request exceeds 256 KiB.", 413);
          }
          chunks.push(chunk);
        }
        let input: unknown;
        try {
          input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          throw new ChatRequestError("Chat operations require valid JSON.");
        }
        result = await host.sendThread(
          (threadRoute?.[1] ?? taskRoute?.[1]) as string,
          input,
          threadRoute?.[2] === "tasks" ? "new-task" : "message",
          taskRoute?.[2],
        );
      } else {
        response.writeHead(405);
        response.end();
        return;
      }
      response.writeHead(request.method === "POST" ? 202 : 200, {
        "Content-Type": "application/json",
      });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(error instanceof ChatRequestError ? error.status : 503, {
        "Content-Type": "application/json",
      });
      response.end(
        JSON.stringify({
          error:
            error instanceof ChatRequestError
              ? error.message
              : "Thread operation unavailable. Retry with the same requestId.",
        }),
      );
    }
    return;
  }
  const settingsRoute = /^\/api\/bots\/([^/]+)\/settings$/.exec(path);
  if (settingsRoute && request.method === "POST") {
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length;
        if (bytes > 65536) {
          request.resume();
          throw new BotRequestError("Bot request exceeds 64 KiB.", 413);
        }
        chunks.push(chunk);
      }
      let input: unknown;
      try {
        input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new BotRequestError("Bot settings require valid JSON.");
      }
      const result = host.updateBot(decodeURIComponent(settingsRoute[1] as string), input);
      response.writeHead(result.replayed ? 200 : 201, { "Content-Type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(error instanceof BotRequestError ? error.status : 503, {
        "Content-Type": "application/json",
      });
      response.end(
        JSON.stringify({
          error:
            error instanceof BotRequestError
              ? error.message
              : "Bot settings unavailable. Retry with the same requestId.",
        }),
      );
    }
    return;
  }
  if (path === "/api/bots" && request.method === "POST") {
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length;
        if (bytes > 65536) {
          request.resume();
          throw new BotRequestError("Bot request exceeds 64 KiB.", 413);
        }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString("utf8");
      let input: unknown;
      try {
        input = JSON.parse(body);
      } catch {
        throw new BotRequestError("Bot creation requires valid JSON.");
      }
      const result = host.createBot(input);
      response.writeHead(result.replayed ? 200 : 201, { "Content-Type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(error instanceof BotRequestError ? error.status : 503, {
        "Content-Type": "application/json",
      });
      response.end(
        JSON.stringify({
          error:
            error instanceof BotRequestError
              ? error.message
              : "Bot creation unavailable. Retry with the same requestId.",
        }),
      );
    }
    return;
  }
  if (asset && (request.method === "GET" || request.method === "HEAD")) {
    try {
      const bytes = await readFile(new URL(`../../../client/dist/${asset[0]}`, import.meta.url));
      response.writeHead(200, { "Content-Type": asset[1] });
      response.end(request.method === "HEAD" ? undefined : bytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Build the local client with npm run build, then reload.\n");
    }
    return;
  }
  if (settingsRoute) {
    response.writeHead(405, { Allow: "POST" });
    response.end();
    return;
  }
  if (
    asset ||
    path === "/api/status" ||
    path === "/api/pair" ||
    path === "/api/bots" ||
    path === "/api/bot-options"
  ) {
    response.writeHead(405, {
      Allow: path === "/api/pair" ? "POST" : path === "/api/bots" ? "GET, POST" : "GET, HEAD",
    });
  } else {
    response.writeHead(path === socketPath ? 426 : 404);
  }
  response.end();
}
