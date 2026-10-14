// Expose only the gateway proxy port to the runner's isolated network.
import { createServer, connect } from "node:net";
createServer((client) => {
  const upstream = connect(10255, "gateway");
  client.pipe(upstream).pipe(client);
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  client.on("close", () => upstream.destroy());
}).listen(10255, "0.0.0.0");
