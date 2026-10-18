import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Host } from "../host.ts";
import type { LocalAccess } from "./local-access.ts";

const ASSETS = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/main.js", ["main.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);

/** The Host serves a fixed set of built assets and authenticated public reads. */
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
  if (asset || path === "/api/status" || path === "/api/pair") {
    response.writeHead(405, { Allow: path === "/api/pair" ? "POST" : "GET, HEAD" });
  } else {
    response.writeHead(path === socketPath ? 426 : 404);
  }
  response.end();
}
