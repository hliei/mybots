import { chmod, lstat, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import type { Host } from "../host.ts";

export class CliChannel {
  private readonly server: Server;
  private readonly socketPath: string;
  private readonly sockets = new Set<Socket>();
  private readonly inputs = new Set<Promise<void>>();
  private client?: Socket;
  private detach?: () => void;
  private unobserve?: () => void;
  private closing?: Promise<void>;
  private ownsPath = false;
  private constructor(socketPath: string, onConnection: (socket: Socket) => void) {
    this.socketPath = socketPath;
    this.server = createServer(onConnection);
  }

  static async listen(options: {
    host: Host;
    root: string;
    destinationId: string;
    owner: string;
    instance?: string;
  }): Promise<CliChannel> {
    const socketPath = join(options.root, "data", "cli.sock");
    const channel = new CliChannel(socketPath, (socket) => channel.connection(socket, options));
    try {
      channel.detach = options.host.attachChannel({
        channelType: "cli",
        instance: options.instance ?? "cli",
        deliver: async (message, signal) => {
          if (message.platform_id !== "local")
            throw new Error("CLI delivery requires the local destination");
          const socket = channel.client;
          if (!socket || socket.destroyed) return;
          await channel.write(
            socket,
            { text: message.kind === "error" ? `Error: ${message.content}` : message.content },
            signal,
          );
        },
      });
      const previous = await lstat(socketPath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return undefined;
      });
      if (previous) {
        if (!previous.isSocket())
          throw new Error("CLI socket path is occupied by a non-socket file");
        // The host owns data/host.lock before a channel can be opened.
        await unlink(socketPath);
      }
      await new Promise<void>((resolve, reject) => {
        channel.server.once("error", reject);
        channel.server.listen(socketPath, resolve);
      });
      channel.ownsPath = true;
      await chmod(socketPath, 0o600);
      channel.unobserve = options.host.observe((event) => {
        if (event.type !== "failure" || !channel.client) return;
        if (
          event.sessionId &&
          !options.host
            .sessions()
            .some(
              (session) =>
                session.id === event.sessionId &&
                session.messaging_group_id === options.destinationId,
            )
        )
          return;
        channel.client.write(`${JSON.stringify({ text: `Error: ${event.error}` })}\n`);
      });
      return channel;
    } catch (error) {
      await channel.close();
      throw error;
    }
  }

  private connection(
    socket: Socket,
    options: { host: Host; destinationId: string; owner: string },
  ): void {
    if (this.closing) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    let claimed = false;
    let chain = Promise.resolve();
    socket.on("error", () => {
      socket.destroy();
    });
    socket.on("close", () => {
      this.sockets.delete(socket);
      if (this.client === socket) this.client = undefined;
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 1024 * 1024) {
        socket.destroy();
        return;
      }
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const task = chain.then(async () => {
          if (this.closing || socket.destroyed || (claimed && this.client !== socket)) return;
          try {
            const payload: unknown = JSON.parse(line);
            if (
              !payload ||
              typeof payload !== "object" ||
              !("text" in payload) ||
              typeof payload.text !== "string" ||
              !payload.text.trim()
            )
              throw new Error("Expected a JSON line with nonempty text");
            if (!claimed) {
              claimed = true;
              const previous = this.client;
              this.client = socket;
              if (previous && previous !== socket) {
                previous.end(`${JSON.stringify({ text: "[superseded by a newer client]" })}\n`);
                previous.setTimeout(1000, () => previous.destroy());
              }
            }
            const admitted = await options.host.accept({
              destinationId: options.destinationId,
              userId: options.owner,
              text: payload.text,
            });
            if (payload.text.trim() === "/reset" && admitted.backgroundBoundary !== undefined) {
              socket.write(
                `${JSON.stringify({
                  text: `Chat background reset. Later conversational Runs start at boundary ${admitted.backgroundBoundary}. Existing Runs are unchanged.`,
                })}\n`,
              );
            }
          } catch (error) {
            if (!socket.destroyed)
              socket.write(
                `${JSON.stringify({ text: `Error: ${error instanceof Error ? error.message : "Invalid CLI input"}` })}\n`,
              );
          }
        });
        this.inputs.add(task);
        void task.finally(() => this.inputs.delete(task));
        chain = task;
        index = buffer.indexOf("\n");
      }
    });
  }

  private write(socket: Socket, payload: { text: string }, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        signal.removeEventListener("abort", abort);
        socket.removeListener("close", closed);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => {
        socket.destroy();
        finish(new Error("CLI delivery cancelled"));
      };
      const closed = () => finish(new Error("CLI disconnected during delivery"));
      socket.once("close", closed);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      socket.write(`${JSON.stringify(payload)}\n`, (error) => finish(error ?? undefined));
    });
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      this.detach?.();
      this.unobserve?.();
      for (const socket of this.sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        this.server.close((error) => {
          if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING")
            reject(error);
          else resolve();
        });
      });
      await Promise.allSettled(this.inputs);
      if (this.ownsPath)
        await unlink(this.socketPath).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
    })();
    return this.closing;
  }
}
