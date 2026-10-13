import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/core/agent.ts";

export interface ModelRequest {
  model: string;
  messages: {
    role: string;
    content: string;
    reasoning_content?: string;
    tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
    tool_call_id?: string;
  }[];
  tools: {
    type: string;
    function: {
      name: string;
      description: string;
      parameters: {
        required: string[];
        properties: Record<string, { type: string; description: string; enum?: string[] }>;
      };
    };
  }[];
  thinking: { type: string };
  temperature: number;
  max_tokens: number;
  stream: boolean;
}

export async function chatFixture() {
  const root = await mkdtemp(join(tmpdir(), "mybots-chat-"));
  const agents: Agent[] = [];
  const requests: ModelRequest[] = [];
  const transports: { path: string | undefined; authorization: string | undefined }[] = [];
  const responses: { status: number; body: unknown; headers?: Record<string, string> }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
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
    response.writeHead(next.status, { "Content-Type": "application/json", ...next.headers });
    response.end(JSON.stringify(await next.body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

  async function workspace(path = root, settings = "", frontmatter = "") {
    await mkdir(join(path, ".agents", "bots", "helper"), { recursive: true });
    await writeFile(
      join(path, "config.user.yaml"),
      `default_agent: helper\nllm:\n  api_key: offline-test-key\n  api_base: ${endpoint}\n${settings}`,
    );
    await writeFile(
      join(path, ".agents", "bots", "helper", "AGENT.md"),
      `---\nname: Helper\n${frontmatter}---\n\nGive concise answers.\n`,
    );
    return path;
  }

  async function writeSkill(id: string, source: string, path = root) {
    await mkdir(join(path, ".agents", "skills", id), { recursive: true });
    await writeFile(join(path, ".agents", "skills", id, "SKILL.md"), source);
  }

  return {
    root,
    async openAgent(options: Parameters<typeof Agent.open>[0]) {
      const agent = await Agent.open(options);
      agents.push(agent);
      return agent;
    },
    server,
    endpoint,
    requests,
    transports,
    responses,
    workspace,
    writeSkill,
    async close() {
      await Promise.all(agents.splice(0).map((agent) => agent.close()));
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

export function unavailableResponses() {
  return Array.from({ length: 3 }, () => ({
    status: 503,
    body: { error: { message: "Unavailable" } },
    headers: { "retry-after-ms": "1" },
  }));
}
