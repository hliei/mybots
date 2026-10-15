import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { RawData } from "ws";
import { WebSocket, WebSocketServer } from "ws";
import type { ChannelDelivery, Host, HostConfiguration, HostEvent } from "../host.ts";
import type { OutboundMessage } from "../mailbox/types.ts";

export interface WebSocketChannelAddress {
  host: string;
  port: number;
  path: string;
}

export interface WebSocketChannelOptions {
  host: Host;
  configuration: HostConfiguration;
  /** Loopback bind address; defaults to `127.0.0.1`. */
  bindHost?: string;
  /** Configured bind port, or 0 to select an ephemeral port for embedding/tests. */
  port: number;
  /** Request path; defaults to `/ws`. */
  path?: string;
  /** Bounded wait for one client frame before that peer is dropped. */
  sendTimeoutMs?: number;
}

interface Peer {
  socket: WebSocket;
  writes: Promise<void>;
  pendingWrites: number;
  inputs: Promise<void>;
  closed: boolean;
}

const DEFAULT_PATH = "/ws";
const DEFAULT_SEND_TIMEOUT_MS = 1000;
const DEFAULT_MAX_QUEUED_FRAMES = 64;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function textFrame(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Validate one client text frame into the destination and content it requests. */
function parseInput(raw: string): { destination: string; content: string } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Input must be valid JSON.");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Input must be a JSON object.");
  const data = value as Record<string, unknown>;
  if (data.type !== "input") throw new Error("Input type must be 'input'.");
  if (typeof data.destination !== "string" || !data.destination.trim())
    throw new Error("Input destination must be a nonempty string.");
  if (typeof data.content !== "string" || !data.content.trim())
    throw new Error("Input content must be a nonempty string.");
  return { destination: data.destination, content: data.content };
}

function serializeInbound(event: Extract<HostEvent, { type: "input" }>): string {
  return JSON.stringify({
    type: "inbound",
    session_id: event.sessionId,
    message_id: event.messageId,
    destination: event.destinationId,
    channel_type: event.channelType,
    platform_id: event.platformId,
    thread_id: event.threadId,
    content: event.content,
    timestamp: event.timestamp,
  });
}

function serializeOutbound(
  sessionId: string,
  destinationId: string,
  message: OutboundMessage,
): string {
  return JSON.stringify({
    type: "outbound",
    session_id: sessionId,
    message_id: message.id,
    in_reply_to: message.in_reply_to,
    destination: destinationId,
    channel_type: message.channel_type,
    platform_id: message.platform_id,
    thread_id: message.thread_id,
    kind: message.kind,
    content: message.content,
    timestamp: message.timestamp,
  });
}

/**
 * Serve the owner-local WebSocket control and observation interface for one host.
 * Clients submit validated input for a configured WebSocket messaging
 * destination and observe live host input/output/failure envelopes. Delivery of
 * a WebSocket destination's own output uses this channel's sender; observation of
 * another channel's output never acknowledges that channel's delivery. Importing
 * or constructing this module opens no resource.
 */
export class WebSocketChannel {
  private readonly host: Host;
  private readonly owner: string;
  private readonly channelType = "websocket";
  private readonly instance: string;
  private readonly destinations: Set<string>;
  private readonly platformIds: Set<string>;
  private readonly bindHost: string;
  private readonly port: number;
  private readonly path: string;
  private readonly sendTimeoutMs: number;
  private readonly peers = new Set<Peer>();
  private readonly inputs = new Set<Promise<void>>();
  private server: Server | undefined;
  private webSocketServer: WebSocketServer | undefined;
  private bound: WebSocketChannelAddress | undefined;
  private detach: (() => void) | undefined;
  private unobserve: (() => void) | undefined;
  private admission = true;
  private stopping: Promise<void> | undefined;

  private constructor(options: WebSocketChannelOptions) {
    const destinations = options.configuration.destinations.filter(
      (destination) => destination.channelType === "websocket",
    );
    if (destinations.length === 0)
      throw new Error("WebSocket interface requires a configured websocket destination");
    const instances = new Set(destinations.map((destination) => destination.instance));
    if (instances.size !== 1)
      throw new Error("WebSocket destinations must share one channel instance");
    if (
      new Set(destinations.map((destination) => destination.platformId)).size !==
      destinations.length
    )
      throw new Error("WebSocket destinations must have unique platform IDs");
    const bindHost = options.bindHost ?? "127.0.0.1";
    if (!LOOPBACK_HOSTS.has(bindHost))
      throw new Error("WebSocket interface must bind a loopback address");
    if (
      typeof options.port !== "number" ||
      !Number.isInteger(options.port) ||
      options.port < 0 ||
      options.port > 65535
    )
      throw new Error("WebSocket bind port must be an integer between 0 and 65535");
    const path = options.path ?? DEFAULT_PATH;
    if (typeof path !== "string" || !path.startsWith("/") || /\s/u.test(path))
      throw new Error("WebSocket path must start with '/' and contain no whitespace");
    const sendTimeoutMs = options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
    if (!Number.isSafeInteger(sendTimeoutMs) || sendTimeoutMs <= 0)
      throw new Error("WebSocket send timeout must be a positive integer");
    this.host = options.host;
    const owner = options.configuration.owners.find((owner) => owner.startsWith("cli:"));
    if (!owner) throw new Error("WebSocket interface requires a CLI owner identity");
    this.owner = owner;
    this.instance = [...instances][0];
    this.destinations = new Set(destinations.map((destination) => destination.id));
    this.platformIds = new Set(destinations.map((destination) => destination.platformId));
    this.bindHost = bindHost;
    this.port = options.port;
    this.path = path;
    this.sendTimeoutMs = sendTimeoutMs;
  }

  static async listen(options: WebSocketChannelOptions): Promise<WebSocketChannel> {
    const channel = new WebSocketChannel(options);
    const server = createServer((request, response) => channel.handleRequest(request, response));
    const webSocketServer = new WebSocketServer({ server, path: channel.path });
    webSocketServer.on("connection", (socket) => channel.handleConnection(socket));
    channel.server = server;
    channel.webSocketServer = webSocketServer;
    try {
      channel.detach = options.host.attachChannel({
        channelType: channel.channelType,
        instance: channel.instance,
        deliver: (message, signal, context) => channel.deliver(message, signal, context),
      });
      channel.unobserve = options.host.observe((event) => channel.observe(event));
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.removeListener("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.removeListener("error", onError);
          webSocketServer.removeListener("error", onError);
          resolve();
        };
        webSocketServer.once("error", onError);
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(channel.port, channel.bindHost);
      });
      const bound = server.address();
      channel.bound = {
        host: channel.bindHost,
        port: typeof bound === "object" && bound !== null ? bound.port : channel.port,
        path: channel.path,
      };
      return channel;
    } catch (error) {
      await channel.close();
      throw error;
    }
  }

  get address(): WebSocketChannelAddress {
    if (!this.bound) throw new Error("WebSocket interface is not listening");
    return { ...this.bound };
  }

  get clientCount(): number {
    return this.peers.size;
  }

  close(): Promise<void> {
    if (!this.stopping) this.stopping = this.shutdown();
    return this.stopping;
  }

  private async shutdown(): Promise<void> {
    this.admission = false;
    this.detach?.();
    this.unobserve?.();
    this.detach = undefined;
    this.unobserve = undefined;
    const server = this.server;
    const webSocketServer = this.webSocketServer;
    this.server = undefined;
    this.webSocketServer = undefined;
    this.bound = undefined;
    if (!server || !webSocketServer) return;
    const peers = [...this.peers];
    for (const peer of peers) this.drop(peer);
    const webSocketClosed = new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
    const serverClosed = new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    server.closeAllConnections();
    await Promise.all([webSocketClosed, serverClosed]);
    await Promise.allSettled([...this.inputs, ...peers.map((peer) => peer.writes)]);
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
    if (!this.admission) {
      socket.terminate();
      return;
    }
    const peer: Peer = {
      socket,
      writes: Promise.resolve(),
      pendingWrites: 0,
      inputs: Promise.resolve(),
      closed: false,
    };
    this.peers.add(peer);
    const remove = () => {
      peer.closed = true;
      this.peers.delete(peer);
    };
    socket.on("close", remove);
    socket.on("error", () => {
      remove();
      socket.terminate();
    });
    socket.on("message", (data, isBinary) => {
      if (!this.admission || peer.closed) return;
      if (isBinary) {
        this.sendError(peer, "Input must be a UTF-8 JSON text frame.");
        return;
      }
      const raw = textFrame(data);
      const input = peer.inputs.then(() => this.handleMessage(peer, raw));
      peer.inputs = input;
      this.inputs.add(input);
      void input.then(
        () => this.inputs.delete(input),
        () => this.inputs.delete(input),
      );
    });
  }

  private async handleMessage(peer: Peer, raw: string): Promise<void> {
    if (!this.admission || peer.closed) return;
    let input: { destination: string; content: string };
    try {
      input = parseInput(raw);
      if (!this.destinations.has(input.destination))
        throw new Error("Input destination is not a configured WebSocket destination.");
    } catch (error) {
      this.sendError(peer, errorMessage(error));
      return;
    }
    try {
      await this.host.accept({
        destinationId: input.destination,
        userId: this.owner,
        text: input.content,
      });
    } catch (error) {
      this.sendError(peer, errorMessage(error));
    }
  }

  private sendError(peer: Peer, message: string): void {
    void this.dispatch(peer, JSON.stringify({ type: "error", message })).catch(() => {});
  }

  private observe(event: HostEvent): void {
    if (!this.admission) return;
    let payload: string;
    if (event.type === "input") payload = serializeInbound(event);
    else if (event.type === "output") {
      // This channel's own destination output is sent by `deliver`, not observed.
      if (
        event.message.channel_type === this.channelType &&
        this.platformIds.has(event.message.platform_id)
      )
        return;
      payload = serializeOutbound(event.sessionId, event.destinationId, event.message);
    } else {
      payload = JSON.stringify({
        type: "failure",
        ...(event.sessionId !== undefined ? { session_id: event.sessionId } : {}),
        error: event.error,
      });
    }
    for (const peer of [...this.peers]) {
      void this.dispatch(peer, payload).catch(() => {});
    }
  }

  /**
   * Send one WebSocket destination's output to every connected client. Delivery
   * succeeds when at least one client accepted the frame. With no connected
   * client it is a no-op, matching the host's channel contract; the persisted
   * outbound row is not replayed to a later connection.
   */
  private async deliver(
    message: OutboundMessage,
    signal: AbortSignal,
    context: ChannelDelivery,
  ): Promise<void> {
    if (signal.aborted) return;
    const peers = [...this.peers];
    if (peers.length === 0) return;
    const payload = serializeOutbound(context.sessionId, context.destinationId, message);
    const results = await Promise.allSettled(
      peers.map((peer) => this.dispatch(peer, payload, signal)),
    );
    if (signal.aborted) return;
    if (!results.some((result) => result.status === "fulfilled"))
      throw new Error("WebSocket delivery failed");
  }

  private dispatch(peer: Peer, payload: string, signal?: AbortSignal): Promise<void> {
    if (peer.closed || peer.socket.readyState !== WebSocket.OPEN) {
      this.drop(peer);
      return Promise.reject(new Error("WebSocket peer is not connected"));
    }
    if (peer.pendingWrites >= DEFAULT_MAX_QUEUED_FRAMES) {
      this.drop(peer);
      return Promise.reject(new Error("WebSocket peer is not consuming frames"));
    }
    peer.pendingWrites += 1;
    const result = peer.writes.catch(() => {}).then(() => this.write(peer, payload, signal));
    peer.writes = result
      .catch(() => {
        this.drop(peer);
      })
      .finally(() => {
        peer.pendingWrites -= 1;
      });
    return result;
  }

  private write(peer: Peer, payload: string, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (peer.closed || peer.socket.readyState !== WebSocket.OPEN) {
        reject(new Error("WebSocket peer is not connected"));
        return;
      }
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => finish(new Error("WebSocket delivery cancelled"));
      const timer = setTimeout(
        () => finish(new Error("Client send timed out")),
        this.sendTimeoutMs,
      );
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      try {
        peer.socket.send(payload, (error) => finish(error ?? undefined));
      } catch (error) {
        finish(error instanceof Error ? error : new Error("Client send failed"));
      }
    });
  }

  private drop(peer: Peer): void {
    peer.closed = true;
    this.peers.delete(peer);
    try {
      peer.socket.terminate();
    } catch {
      /* The peer already closed. */
    }
  }
}
