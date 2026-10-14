import { connect, Socket } from "node:net";
import { join, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { parseArgs } from "node:util";

export async function runCli(args: string[]): Promise<number> {
  let socket: Socket | undefined;
  let lines: Interface | undefined;
  let interrupted = false;
  let outputFailed = false;
  const interrupt = () => {
    interrupted = true;
    lines?.close();
    socket?.destroy();
    if (process.stdout instanceof Socket && process.stdout.writableLength > 0) {
      process.stdout._destroy = Socket.prototype._destroy;
      process.stdout.destroy();
    }
  };
  const outputError = () => {
    outputFailed = true;
    lines?.close();
    socket?.destroy();
  };
  try {
    const { values } = parseArgs({
      args,
      options: { root: { type: "string", short: "r" }, help: { type: "boolean", short: "h" } },
    });
    if (values.help) {
      console.log("Usage: npm run start:cli -- [--root PATH | -r PATH]");
      console.log(
        "Connect to the owner-local host at PATH/data/cli.sock (PATH defaults to the current directory).",
      );
      console.log(
        "Enter messages; quit, exit, q, EOF or Ctrl+C disconnect the terminal. Agent work stays on the host.",
      );
      return 0;
    }
    const socketPath = join(resolve(values.root ?? "."), "data", "cli.sock");
    socket = connect(socketPath);
    const connection = socket;
    await new Promise<void>((resolve, reject) => {
      connection.once("connect", resolve);
      connection.once("error", reject);
    });
    console.log("Connected to Mybots host. Type quit to disconnect.");
    lines = createInterface({ input: process.stdin, output: process.stdout, prompt: "You: " });
    const terminal = lines;
    const closed = Promise.withResolvers<void>();
    let voluntary = false;
    let connectionFailed = false;
    let buffer = "";
    connection.setEncoding("utf8");
    terminal.once("close", () => {
      voluntary = true;
      closed.resolve();
    });
    connection.on("error", () => {
      connectionFailed = true;
      terminal.close();
    });
    connection.once("close", () => {
      if (!voluntary) {
        connectionFailed = true;
        console.error("Error: Host disconnected");
      }
      terminal.close();
    });
    connection.on("data", (chunk: string) => {
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
            throw new Error();
          process.stdout.write(`${message.text}\n`);
          if (message.text === "[superseded by a newer client]") terminal.close();
          else if (!voluntary) terminal.prompt();
        } catch {
          connectionFailed = true;
          terminal.close();
        }
        index = buffer.indexOf("\n");
      }
    });
    terminal.on("line", (line) => {
      const text = line.trim();
      if (["quit", "exit", "q"].includes(text.toLowerCase())) {
        terminal.close();
        return;
      }
      if (text) connection.write(`${JSON.stringify({ text })}\n`);
      terminal.prompt();
    });
    process.once("SIGINT", interrupt);
    terminal.once("SIGINT", interrupt);
    process.stdout.on("error", outputError);
    terminal.prompt();
    await closed.promise;
    connection.end();
    return interrupted ? 130 : connectionFailed || outputFailed ? 1 : 0;
  } catch {
    console.error(
      "Error: Cannot connect to the local host; check --root and start the host first.",
    );
    return 1;
  } finally {
    lines?.close();
    socket?.destroy();
    process.removeListener("SIGINT", interrupt);
    process.stdout.removeListener("error", outputError);
  }
}
