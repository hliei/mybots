import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ModelRequest {
  model: string;
  messages: {
    role: string;
    content: string;
    reasoning_content?: string;
    tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
    tool_call_id?: string;
  }[];
  tools: { type: string; function: { name: string; parameters: { required: string[] } } }[];
  thinking: { type: string };
  temperature: number;
  max_tokens: number;
  stream: boolean;
}

export async function chatFixture() {
  const root = await mkdtemp(join(tmpdir(), "mybots-chat-"));
  const requests: ModelRequest[] = [];
  const transports: { path: string | undefined; authorization: string | undefined }[] = [];
  const responses: { status: number; body: unknown }[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    transports.push({ path: request.url, authorization: request.headers.authorization });
    const next = responses.shift() ?? {
      status: 200,
      body: {
        choices: [
          {
            message: { role: "assistant", content: "Hello!", reasoning_content: "Full reasoning." },
          },
        ],
      },
    };
    response.writeHead(next.status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(await next.body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

  async function workspace(path = root, settings = "", frontmatter = "") {
    await mkdir(join(path, "bots", "helper"), { recursive: true });
    await writeFile(
      join(path, "config.user.yaml"),
      `default_agent: helper\nllm:\n  api_key: offline-test-key\n  api_base: ${endpoint}\n${settings}`,
    );
    await writeFile(
      join(path, "bots", "helper", "AGENT.md"),
      `---\nname: Helper\n${frontmatter}---\n\nGive concise answers.\n`,
    );
    return path;
  }

  return {
    root,
    server,
    endpoint,
    requests,
    transports,
    responses,
    workspace,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
    },
  };
}

export function toolReply(
  calls: { name: string; args: unknown; id: string }[],
  reasoning = "Tool reasoning.",
) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          reasoning_content: reasoning,
          tool_calls: calls.map(({ name, args, id }) => ({
            id,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          })),
        },
      },
    ],
  };
}
