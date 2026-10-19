import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BotRequestError } from "../bots.ts";
import { ChatRequestError } from "../chat.ts";
import type { Host } from "../host.ts";
import type { LocalAccess } from "./local-access.ts";

const ASSETS = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/main.js", ["main.js", "text/javascript; charset=utf-8"]],
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
  if (path === "/api/sessions" || path.startsWith("/api/sessions/")) {
    try {
      const match = /^\/api\/sessions\/([^/]+)(?:\/(name|messages))?$/.exec(path);
      let result: object;
      let status = 200;
      if (request.method === "GET" && path === "/api/sessions") {
        result = host.chatSessions(
          new URL(request.url ?? "/", "http://localhost").searchParams.get("botId") ?? "",
        );
      } else if (request.method === "GET" && match && !match[2]) {
        result = await host.chatDetail(match[1] as string);
      } else if (request.method === "POST" && (path === "/api/sessions" || match?.[2])) {
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
        if (path === "/api/sessions") {
          const created = host.createChat(input);
          status = created.replayed ? 200 : 201;
          result = created;
        } else if (match?.[2] === "messages") {
          result = await host.messageChat(match[1] as string, input);
          status = 202;
        } else result = host.renameChat(match?.[1] as string, input);
      } else {
        response.writeHead(match || path === "/api/sessions" ? 405 : 404);
        response.end();
        return;
      }
      response.writeHead(status, { "Content-Type": "application/json" });
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
              : "Chat operation unavailable. Retry with the same requestId.",
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
