import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export async function searchFixture() {
  const requests: { method?: string; url: string; token?: string; accept?: string }[] = [];
  const responses: { status: number; body: unknown }[] = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method,
      url: request.url ?? "",
      token: request.headers["x-subscription-token"] as string | undefined,
      accept: request.headers.accept,
    });
    const next = responses.shift() ?? {
      status: 200,
      body: {
        web: {
          results: [
            {
              title: "Brave docs",
              url: "https://example.test/docs",
              description: "Search documentation.",
            },
            { title: "Release", url: "https://example.test/news", description: "New release." },
          ],
        },
      },
    };
    response.writeHead(next.status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(next.body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/res/v1/web/search`;
  return {
    server,
    requests,
    responses,
    endpoint,
    settings: `websearch:\n  api_key: offline-search-key\n  api_base: ${endpoint}\n`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
