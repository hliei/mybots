import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:https";

const requests = [];
let injected = true;
const probes = `
set -eu
for path in /data/host.db /data/channel-token /data/mount-policy.json /var/run/docker.sock /root/.onecli /host; do
  test ! -e "$path" || exit 42
done
if printf corrupt > /run/mybots/context.json 2>/dev/null; then exit 43; fi
if printf corrupt > /run/gateway/ca.pem 2>/dev/null; then exit 44; fi
bun -e 'import { Database } from "bun:sqlite"; try { new Database("/session/inbound.db").exec("delete from messages_in"); process.exit(45); } catch {}'
printf 'Shared Agent note\\n' > note.txt
printf 'Mount isolation passed\\n'
`;

createServer({ key: readFileSync("/tls/key.pem"), cert: readFileSync("/tls/cert.pem") }, async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const validAuth = request.headers.authorization === `Bearer ${process.env.FIXTURE_CREDENTIAL}`;
  injected &&= validAuth;
  requests.push(body);
  if (!validAuth) { response.writeHead(401); response.end(); return; }
  const latest = body.messages.findLast((message) => message.role === "user");
  const latestIndex = body.messages.findLastIndex((message) => message.role === "user");
  const tools = body.messages.slice(latestIndex + 1).filter((message) => message.role === "tool");
  const reopened = JSON.stringify(latest?.content).includes("Continue");
  const reply = reopened
    ? tools.length > 0 ? { text: "Reopened the saved conversation and read the shared note." } : { tool: "read", arguments: { path: "note.txt" } }
    : tools.length ? { text: "Saved the shared note in the isolated container." } : { tool: "bash", arguments: { command: probes } };
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const send = (delta, finishReason = null) => response.write(`data: ${JSON.stringify({ id: "fixture-reply", object: "chat.completion.chunk", created: 1, model: "controlled-model", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
  send({ role: "assistant", content: reply.text ?? null });
  if (reply.tool) send({ tool_calls: [{ index: 0, id: `call-${requests.length}`, type: "function", function: { name: reply.tool, arguments: JSON.stringify(reply.arguments) } }] });
  send({}, reply.tool ? "tool_calls" : "stop");
  response.end("data: [DONE]\n\n");
}).listen(8443, "0.0.0.0");

createHttpServer((_request, response) => {
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ injected, requests }));
}).listen(8080, "0.0.0.0");
