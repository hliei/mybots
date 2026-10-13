import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { RawData, WebSocket } from "ws";
import { WebSocketServer } from "ws";
import type { RuntimeEvent } from "../core/events.ts";
import type { EventRuntime } from "../core/runtime.ts";
import {
  errorMessage,
  parseWebSocketInput,
  serializeError,
  serializeEvent,
  type WebSocketInput,
  websocketSource,
} from "./protocol.ts";

export interface WebSocketInterfaceOptions {
  runtime: EventRuntime;
  host: string;
  /** Configured bind port, or 0 to select an ephemeral port for embedding/tests. */
  port: number;
  /** Request path; defaults to `/ws`. */
  path?: string;
  /** Bounded wait for one client write or close before that peer is dropped. */
  sendTimeoutMs?: number;
}

export interface WebSocketAddress {
  host: string;
  port: number;
  path: string;
}

const DEFAULT_PATH = "/ws";
const DEFAULT_SEND_TIMEOUT_MS = 1000;

function textFrame(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

/**
 * Serve the local WebSocket interface for one shared runtime. `start` binds the
 * listener, subscribes to runtime events, and begins accepting clients; `stop`
 * unsubscribes, closes every client and the listener, and awaits their cleanup.
 * Constructing or importing this module opens no resource.
 */
export class WebSocketInterface {
  private readonly runtime: EventRuntime;
  private readonly host: string;
  private readonly port: number;
  private readonly path: string;
  private readonly sendTimeoutMs: number;
  private readonly clients = new Set<WebSocket>();
  private server: Server | undefined;
  private webSocketServer: WebSocketServer | undefined;
  private unsubscribe: (() => void) | undefined;
  private boundAddress: WebSocketAddress | undefined;

  constructor(options: WebSocketInterfaceOptions) {
    if (typeof options.host !== "string" || !options.host.trim())
      throw new Error("The WebSocket bind host must be a nonempty string.");
    if (
      typeof options.port !== "number" ||
      !Number.isInteger(options.port) ||
      options.port < 0 ||
      options.port > 65535
    )
      throw new Error("The WebSocket bind port must be an integer between 0 and 65535.");
    const path = options.path ?? DEFAULT_PATH;
    if (typeof path !== "string" || !path.startsWith("/") || /\s/u.test(path))
      throw new Error("The WebSocket path must start with '/' and contain no whitespace.");
    const sendTimeoutMs = options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
    if (!Number.isSafeInteger(sendTimeoutMs) || sendTimeoutMs <= 0)
      throw new Error("The WebSocket send timeout must be a positive integer.");
    this.runtime = options.runtime;
    this.host = options.host;
    this.port = options.port;
    this.path = path;
    this.sendTimeoutMs = sendTimeoutMs;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  async start(): Promise<WebSocketAddress> {
    if (this.server) return { ...(this.boundAddress as WebSocketAddress) };
    const server = createServer((request, response) => this.handleRequest(request, response));
    const webSocketServer = new WebSocketServer({ server, path: this.path });
    webSocketServer.on("connection", (socket) => this.handleConnection(socket));
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.removeListener("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.removeListener("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(this.port, this.host);
      });
      const bound = server.address();
      const port = typeof bound === "object" && bound !== null ? bound.port : this.port;
      this.unsubscribe = this.runtime.subscribe((event, signal) => this.broadcast(event, signal));
      this.server = server;
      this.webSocketServer = webSocketServer;
      this.boundAddress = { host: this.host, port, path: this.path };
      return { ...this.boundAddress };
    } catch (error) {
      webSocketServer.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw error;
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    const webSocketServer = this.webSocketServer;
    if (!server || !webSocketServer) return;
    this.server = undefined;
    this.webSocketServer = undefined;
    this.boundAddress = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    const webSocketClosed = new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
    const serverClosed = new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    server.closeAllConnections();
    const clients = [...this.clients];
    this.clients.clear();
    await Promise.all(clients.map((client) => this.closeClient(client)));
    await Promise.all([webSocketClosed, serverClosed]);
  }

  private handleRequest(request: IncomingMessage, response: ServerResponse): void {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const upgradeRequired = path === this.path;
    response.writeHead(upgradeRequired ? 426 : 404, {
      "Content-Type": "text/plain; charset=utf-8",
    });
    response.end(upgradeRequired ? "Upgrade Required\n" : "Not Found\n");
  }

  private handleConnection(socket: WebSocket): void {
    this.clients.add(socket);
    const remove = () => {
      this.clients.delete(socket);
    };
    socket.on("close", remove);
    socket.on("error", remove);
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.sendErrorFrame(socket, "Input must be a UTF-8 JSON text frame.");
        return;
      }
      void this.handleMessage(socket, textFrame(data));
    });
  }

  private async handleMessage(socket: WebSocket, raw: string): Promise<void> {
    let input: WebSocketInput;
    try {
      input = parseWebSocketInput(raw);
    } catch (error) {
      this.sendErrorFrame(socket, errorMessage(error));
      return;
    }
    try {
      await this.runtime.submit({
        source: websocketSource(input.source),
        content: input.content,
        ...(input.agent_id !== undefined ? { agent_id: input.agent_id } : {}),
      });
    } catch (error) {
      this.sendErrorFrame(socket, errorMessage(error));
    }
  }

  private sendErrorFrame(socket: WebSocket, message: string): void {
    if (socket.readyState !== socket.OPEN) {
      this.clients.delete(socket);
      return;
    }
    try {
      socket.send(serializeError(message));
    } catch {
      this.clients.delete(socket);
      socket.terminate();
    }
  }

  /**
   * Broadcast one envelope to every connected client. A reply is acknowledged
   * only after at least one client accepted the outbound envelope and only when
   * its pending destination is a WebSocket source; otherwise it stays pending.
   */
  private async broadcast(event: RuntimeEvent, signal: AbortSignal): Promise<void> {
    const payload = serializeEvent(event);
    const recipients = [...this.clients];
    const delivered = (
      await Promise.all(recipients.map((client) => this.sendOrDrop(client, payload, signal)))
    ).some(Boolean);
    if (!delivered) return;
    if (event.type !== "OutboundEvent" || event.reply_id === undefined) return;
    const pending = await this.runtime.getPendingReplies(event.session_id);
    const reply = pending.find((candidate) => candidate.replyId === event.reply_id);
    if (reply?.destination.startsWith("platform-ws:"))
      await this.runtime.acknowledgeReply(event.session_id, event.reply_id);
  }

  private async sendOrDrop(
    client: WebSocket,
    payload: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (client.readyState !== client.OPEN) {
      this.clients.delete(client);
      return false;
    }
    try {
      await this.send(client, payload, signal);
      return true;
    } catch {
      this.clients.delete(client);
      client.terminate();
      return false;
    }
  }

  private send(client: WebSocket, payload: string, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason ?? new Error("The WebSocket interface is stopping."));
        return;
      }
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (error !== undefined) reject(error);
        else resolve();
      };
      const abort = () =>
        finish(signal.reason ?? new Error("The WebSocket interface is stopping."));
      const timer = setTimeout(
        () => finish(new Error("Client send timed out.")),
        this.sendTimeoutMs,
      );
      signal.addEventListener("abort", abort, { once: true });
      try {
        client.send(payload, (error) => finish(error ?? undefined));
      } catch (error) {
        finish(error);
      }
    });
  }

  private closeClient(client: WebSocket): Promise<void> {
    return new Promise<void>((resolve) => {
      if (client.readyState === client.CLOSED) {
        resolve();
        return;
      }
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        client.terminate();
        finish();
      }, this.sendTimeoutMs);
      client.once("close", finish);
      try {
        client.close(1001, "Server shutting down");
      } catch {
        client.terminate();
        finish();
      }
    });
  }
}
