import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { Agent } from "../core/agent.ts";

export async function runCli(args: string[]): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        workspace: { type: "string", short: "w" },
        agent: { type: "string", short: "a" },
        help: { type: "boolean", short: "h" },
      },
    });
    if (values.help) {
      console.log(
        "Usage: npm run start:cli -- [--workspace PATH | -w PATH] [chat] [--agent ID | -a ID]",
      );
      console.log(
        "Workspace defaults to ../default_workspace; Agent defaults to default_agent in config.user.yaml.",
      );
      console.log(
        "Type /help for commands. Type quit, exit, or q to end; Ctrl+C and EOF also exit.",
      );
      return 0;
    }
    if (positionals.length > 1 || (positionals.length === 1 && positionals[0] !== "chat")) {
      throw new Error(`Unsupported arguments: ${positionals.join(" ")}`);
    }
    const agent = await Agent.open({ workspace: values.workspace, agent: values.agent });
    const lines = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "You: ",
    });
    let closed = false;
    lines.once("close", () => {
      closed = true;
    });
    const controller = new AbortController();
    const interrupt = () => {
      controller.abort();
      lines.close();
    };
    process.once("SIGINT", interrupt);
    lines.once("SIGINT", interrupt);
    console.log(`Chat with ${agent.definition.name}. Type /help for commands, or quit to end.`);
    lines.prompt();
    try {
      for await (const line of lines) {
        if (controller.signal.aborted) break;
        const input = line.trim();
        if (["quit", "exit", "q"].includes(input.toLowerCase())) break;
        if (input) {
          try {
            const command = await agent.runCommand(input, controller.signal);
            if (command !== undefined) {
              console.log(command);
            } else {
              console.log(`${agent.definition.id}: ${await agent.chat(input, controller.signal)}`);
            }
          } catch (error) {
            if (controller.signal.aborted) break;
            console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (!closed) lines.prompt();
      }
    } finally {
      lines.close();
      await agent.close();
      process.removeListener("SIGINT", interrupt);
    }
    console.log("Goodbye!");
    return controller.signal.aborted ? 130 : 0;
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
