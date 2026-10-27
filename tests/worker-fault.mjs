import { readFileSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Test-only process boundary: production never imports this startup fault injector.
if (/\/worker\/(?:src|dist)\/index\.(?:ts|js)$/.test(process.argv[1] ?? "")) {
  const root = process.argv[2];
  await appendFile(join(root, "worker-spawns"), `${process.pid}\n`);
  process.on("message", ({ command }) => {
    let fault = "";
    try { fault = readFileSync(join(root, "worker-fault"), "utf8"); } catch {}
    if (fault === "request-crash" && command.action === "providers") process.kill(process.pid, "SIGKILL");
  });
  while (true) {
    const fault = await readFile(join(root, "worker-fault"), "utf8").catch(() => "");
    if (fault === "crash") process.exit(42);
    if (fault !== "hold") break;
    await delay(20);
  }
}
