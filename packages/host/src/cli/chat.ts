import { Socket } from "node:net";
import { createInterface, type Interface } from "node:readline";
import { type CliSocketClient, connectCliSocket } from "./socket-client.ts";

export async function runChat(root: string): Promise<number> {
  let connection: CliSocketClient | undefined;
  let lines: Interface | undefined;
  let interrupted = false;
  let outputFailed = false;
  const interrupt = () => {
    interrupted = true;
    lines?.close();
    if (process.stdout instanceof Socket && process.stdout.writableLength > 0) {
      process.stdout._destroy = Socket.prototype._destroy;
      process.stdout.destroy();
    }
  };
  const outputError = () => {
    outputFailed = true;
    lines?.close();
  };
  try {
    let voluntary = false;
    let connectionFailed = false;
    connection = await connectCliSocket(root, (text) => {
      process.stdout.write(`${text}\n`);
      if (text === "[superseded by a newer client]") lines?.close();
      else if (!voluntary) lines?.prompt();
    });
    console.log("Connected to Mybots host. Type quit to disconnect.");
    lines = createInterface({ input: process.stdin, output: process.stdout, prompt: "You: " });
    const terminal = lines;
    const closed = Promise.withResolvers<void>();
    terminal.once("close", () => {
      voluntary = true;
      closed.resolve();
    });
    void connection.closed.then((reason) => {
      if (reason === "error" || reason === "invalid") connectionFailed = true;
      if (reason === "disconnected" && !voluntary) {
        connectionFailed = true;
        console.error("Error: Host disconnected");
      }
      terminal.close();
    });
    const client = connection;
    terminal.on("line", (line) => {
      const text = line.trim();
      if (["quit", "exit", "q"].includes(text.toLowerCase())) {
        terminal.close();
        return;
      }
      if (text) client.send(text);
      terminal.prompt();
    });
    process.once("SIGINT", interrupt);
    terminal.once("SIGINT", interrupt);
    process.stdout.on("error", outputError);
    terminal.prompt();
    await closed.promise;
    return interrupted ? 130 : connectionFailed || outputFailed ? 1 : 0;
  } finally {
    lines?.close();
    await connection?.close();
    process.removeListener("SIGINT", interrupt);
    process.stdout.removeListener("error", outputError);
  }
}
