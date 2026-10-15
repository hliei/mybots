import { connect } from "node:net";
import { join } from "node:path";

type CliSocketClose = "closed" | "disconnected" | "error" | "invalid";

export interface CliSocketClient {
  send(text: string): void;
  close(): Promise<void>;
  closed: Promise<CliSocketClose>;
}

/** Connect one interactive terminal to the host's newline-delimited text protocol. */
export async function connectCliSocket(
  root: string,
  onText: (text: string) => void,
): Promise<CliSocketClient> {
  const socket = connect(join(root, "data", "cli.sock"));
  const closed = Promise.withResolvers<CliSocketClose>();
  let reason: CliSocketClose | undefined;
  socket.on("error", () => {
    reason ??= "error";
    socket.destroy();
  });
  socket.once("close", () => closed.resolve(reason ?? "disconnected"));
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
  } catch (error) {
    socket.destroy();
    await closed.promise;
    throw error;
  }
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        const message: unknown = JSON.parse(line);
        if (
          !message ||
          typeof message !== "object" ||
          !("text" in message) ||
          typeof message.text !== "string"
        )
          throw new Error("Invalid host reply");
        onText(message.text);
      } catch {
        reason ??= "invalid";
        socket.destroy();
        return;
      }
      index = buffer.indexOf("\n");
    }
  });
  return {
    send(text) {
      socket.write(`${JSON.stringify({ text })}\n`);
    },
    async close() {
      reason ??= "closed";
      socket.end();
      socket.destroy();
      await closed.promise;
    },
    closed: closed.promise,
  };
}
