import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";

export async function pageFixture() {
  const sockets = new Set<Socket>();
  const requests: string[] = [];
  const pages = new Map<
    string,
    { body: string | Buffer; status?: number; headers?: Record<string, string> }
  >();
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    const page = pages.get(request.url ?? "") ?? { status: 404, body: "Not found" };
    response.writeHead(page.status ?? 200, { "Content-Type": "text/html", ...page.headers });
    response.end(page.body);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    server,
    pages,
    requests,
    endpoint,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
