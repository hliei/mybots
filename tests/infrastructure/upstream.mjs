import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:https";

const requests = [];
const searchRequests = [];
let injected = true;
let searchInjected = true;
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
  if (request.url?.startsWith("/res/")) {
    const token = request.headers["x-subscription-token"];
    searchRequests.push({ url: request.url, token });
    const valid = token === process.env.FIXTURE_SEARCH_CREDENTIAL;
    searchInjected &&= valid;
    if (!valid) { response.writeHead(401); response.end(); return; }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ web: { results: [{ title: "Fixture source", url: "https://example.test/source", description: "Matching fixture source." }] } }));
    return;
  }
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
  const search = JSON.stringify(latest?.content).includes("Search the web");
  const inspectMaterials = JSON.stringify(latest?.content).includes("Inspect Bot materials");
  const reply = inspectMaterials
    ? tools.length > 0
      ? { text: JSON.stringify(tools).includes("Shared Agent note") ? "Shared material visible." : "Workspace starts empty." }
      : { tool: "bash", arguments: { command: "if test -f note.txt; then cat note.txt; else printf 'No shared note'; fi" } }
    : search
    ? tools.length > 0 ? { text: "Search returned the fixture source." } : { tool: "web_search", arguments: { query: "fixture" } }
    : reopened
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
  response.end(JSON.stringify({ injected, searchInjected, requests, searchRequests }));
}).listen(8080, "0.0.0.0");
