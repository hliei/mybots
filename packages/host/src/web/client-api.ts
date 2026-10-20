import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileLimitMessage } from "../attachments.ts";
import { BotRequestError } from "../bots.ts";
import { ChatRequestError } from "../chat.ts";
import type { Host } from "../host.ts";
import { MemoryConflictError } from "../memory.ts";
import type { LocalAccess } from "./local-access.ts";

const ASSETS = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/main.js", ["main.js", "text/javascript; charset=utf-8"]],
  ["/history.js", ["history.js", "text/javascript; charset=utf-8"]],
  ["/chat.js", ["chat.js", "text/javascript; charset=utf-8"]],
  ["/attachments.js", ["attachments.js", "text/javascript; charset=utf-8"]],
  ["/skills.js", ["skills.js", "text/javascript; charset=utf-8"]],
  ["/memory.js", ["memory.js", "text/javascript; charset=utf-8"]],
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
  const artifactRoute = /^\/api\/bots\/([^/]+)\/runs\/([^/]+)\/artifacts\/([^/]+)$/.exec(path);
  if (artifactRoute) {
    try {
      if (request.method !== "GET") {
        response.writeHead(405, { Allow: "GET" });
        response.end();
        return;
      }
      const result = await host.downloadArtifact(
        decodeURIComponent(artifactRoute[1] as string),
        decodeURIComponent(artifactRoute[2] as string),
        decodeURIComponent(artifactRoute[3] as string),
      );
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": contentDisposition(result.filename),
        "Content-Length": result.bytes.length,
      });
      response.end(result.bytes);
    } catch (error) {
      response.writeHead(error instanceof ChatRequestError ? error.status : 503, {
        "Content-Type": "application/json",
      });
      response.end(
        JSON.stringify({
          error:
            error instanceof ChatRequestError ? error.message : "Delivered artifact unavailable.",
        }),
      );
    }
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
  const threadRoute = /^\/api\/bots\/([^/]+)\/thread(?:\/(messages|tasks|reset))?$/.exec(path);
  const taskRoute = /^\/api\/bots\/([^/]+)\/tasks\/([^/]+)\/inputs$/.exec(path);
  if (threadRoute || taskRoute) {
    try {
      let result: object;
      if (request.method === "GET" && threadRoute && !threadRoute[2]) {
        result = await host.threadDetail(threadRoute[1] as string);
      } else if (request.method === "POST" && threadRoute?.[2] === "reset") {
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
        result = await host.resetThread(threadRoute[1] as string, input);
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
  const workspaceRoute = /^\/api\/bots\/([^/]+)\/workspace\/files$/.exec(path);
  if (workspaceRoute && request.method === "GET") {
    try {
      const botId = decodeURIComponent(workspaceRoute[1] as string);
      const filePath = new URL(request.url ?? "/", "http://localhost").searchParams.get("path");
      if (filePath === null) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(await host.listWorkspace(botId)));
      } else {
        const result = await host.readWorkspace(botId, filePath);
        response.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": result.bytes.length,
        });
        response.end(result.bytes);
      }
    } catch (error) {
      response.writeHead(error instanceof ChatRequestError ? error.status : 503, {
        "Content-Type": "application/json",
      });
      response.end(
        JSON.stringify({
          error: error instanceof ChatRequestError ? error.message : "Workspace file unavailable.",
        }),
      );
    }
    return;
  }
  const attachmentRoute =
    /^\/api\/bots\/([^/]+)\/tasks\/([^/]+)\/attachments(?:\/([^/]+)(?:\/(workspace))?)?$/.exec(
      path,
    );
  if (attachmentRoute) {
    try {
      const botId = decodeURIComponent(attachmentRoute[1] as string);
      const taskId = decodeURIComponent(attachmentRoute[2] as string);
      const attachmentId = attachmentRoute[3] ? decodeURIComponent(attachmentRoute[3]) : undefined;
      const workspace = attachmentRoute[4] === "workspace";
      if (request.method === "GET" && !attachmentId) {
        const result = await host.listAttachments(botId, taskId);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(result));
        return;
      }
      if (request.method === "GET" && attachmentId && !workspace) {
        const result = await host.downloadAttachment(botId, taskId, attachmentId);
        response.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": contentDisposition(result.filename),
          "Content-Length": result.bytes.length,
        });
        response.end(result.bytes);
        return;
      }
      if (request.method === "POST" && !attachmentId) {
        const header = request.headers["x-filename"];
        if (typeof header !== "string" || !header)
          throw new ChatRequestError("A file name is required.");
        let filename: string;
        try {
          filename = decodeURIComponent(header);
        } catch {
          throw new ChatRequestError("A file name is required.");
        }
        const bytes = await readLimited(request, host.maxFileBytes());
        const result = await host.uploadAttachment(botId, taskId, filename, bytes);
        response.writeHead(201, { "Content-Type": "application/json" });
        response.end(JSON.stringify(result));
        return;
      }
      if (request.method === "POST" && attachmentId && workspace) {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request.iterator({ destroyOnReturn: false })) {
          size += chunk.length;
          if (size > 65536) {
            request.resume();
            throw new ChatRequestError("Workspace save exceeds 64 KiB.", 413);
          }
          chunks.push(chunk);
        }
        let input: unknown;
        try {
          input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          throw new ChatRequestError("Workspace save requires valid JSON.");
        }
        if (!input || typeof input !== "object" || Array.isArray(input) || !("path" in input))
          throw new ChatRequestError("Workspace save requires a path.");
        const result = await host.saveAttachmentToWorkspace(
          botId,
          taskId,
          attachmentId,
          (input as { path: unknown }).path,
        );
        response.writeHead(201, { "Content-Type": "application/json" });
        response.end(JSON.stringify(result));
        return;
      }
      response.writeHead(405, {
        Allow: attachmentId ? (workspace ? "POST" : "GET") : "GET, POST",
      });
      response.end();
    } catch (error) {
      response.writeHead(error instanceof ChatRequestError ? error.status : 503, {
        "Content-Type": "application/json",
      });
      response.end(
        JSON.stringify({
          error: error instanceof ChatRequestError ? error.message : "Task attachment unavailable.",
        }),
      );
    }
    return;
  }
  const memoryTopicRoute = /^\/api\/bots\/([^/]+)\/memory\/topics\/([^/]+)$/.exec(path);
  const memoryCoreRoute = /^\/api\/bots\/([^/]+)\/memory\/(index|definition)$/.exec(path);
  const memoryRoute = /^\/api\/bots\/([^/]+)\/memory$/.exec(path);
  if (memoryRoute && request.method === "GET") {
    try {
      const result = await host.readMemory(decodeURIComponent(memoryRoute[1] as string));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(error instanceof BotRequestError ? error.status : 503, {
        "Content-Type": "application/json",
      });
      response.end(
        JSON.stringify({
          error: error instanceof BotRequestError ? error.message : "Memory unavailable.",
        }),
      );
    }
    return;
  }
  if ((memoryCoreRoute || memoryTopicRoute) && ["PUT", "DELETE"].includes(request.method ?? "")) {
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length;
        if (bytes > 2_000_000) {
          request.resume();
          throw new BotRequestError("Memory request exceeds 2 MB.", 413);
        }
        chunks.push(chunk);
      }
      let input: unknown;
      try {
        input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new BotRequestError("Memory operations require valid JSON.");
      }
      const botId = decodeURIComponent((memoryCoreRoute?.[1] ?? memoryTopicRoute?.[1]) as string);
      const kind = memoryTopicRoute ? "topic" : (memoryCoreRoute?.[2] as "index" | "definition");
      const topicId = memoryTopicRoute
        ? decodeURIComponent(memoryTopicRoute[2] as string)
        : undefined;
      const result =
        request.method === "DELETE"
          ? await host.deleteMemory(botId, kind, input, topicId)
          : await host.saveMemory(botId, kind, input, topicId);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(error instanceof BotRequestError ? error.status : 503, {
        "Content-Type": "application/json",
      });
      response.end(
        JSON.stringify({
          error: error instanceof BotRequestError ? error.message : "Memory unavailable.",
          ...(error instanceof MemoryConflictError ? { observed: error.observed } : {}),
        }),
      );
    }
    return;
  }
  const skillsRoute = /^\/api\/bots\/([^/]+)\/skills$/.exec(path);
  if (skillsRoute && ["GET", "POST"].includes(request.method ?? "")) {
    try {
      const botId = skillsRoute[1] as string;
      let result: object;
      if (request.method === "GET") result = { revisions: host.localSkills(botId) };
      else {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request.iterator({ destroyOnReturn: false })) {
          bytes += chunk.length;
          if (bytes > 65536) {
            request.resume();
            throw new BotRequestError("Skill request exceeds 64 KiB.", 413);
          }
          chunks.push(chunk);
        }
        let input: unknown;
        try {
          input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          throw new BotRequestError("Skill import requires valid JSON.");
        }
        result = host.importSkill(botId, input);
      }
      response.writeHead(request.method === "GET" ? 200 : 201, {
        "Content-Type": "application/json",
      });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(error instanceof BotRequestError ? error.status : 503, {
        "Content-Type": "application/json",
      });
      response.end(
        JSON.stringify({
          error: error instanceof BotRequestError ? error.message : "Local Skills unavailable.",
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
    path === "/api/bot-options" ||
    memoryRoute ||
    memoryCoreRoute ||
    memoryTopicRoute
  ) {
    response.writeHead(405, {
      Allow:
        path === "/api/pair"
          ? "POST"
          : path === "/api/bots"
            ? "GET, POST"
            : memoryCoreRoute || memoryTopicRoute
              ? "PUT, DELETE"
              : memoryRoute
                ? "GET"
                : "GET, HEAD",
    });
  } else {
    response.writeHead(path === socketPath ? 426 : 404);
  }
  response.end();
}

function contentDisposition(filename: string): string {
  const ascii = [...filename]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code <= 126 && character !== '"' && character !== "\\" ? character : "_";
    })
    .join("");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function readLimited(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = request.headers["content-length"];
  if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > maxBytes)) {
    request.resume();
    throw new ChatRequestError(fileLimitMessage(maxBytes), 413);
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      request.resume();
      throw new ChatRequestError(fileLimitMessage(maxBytes), 413);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
