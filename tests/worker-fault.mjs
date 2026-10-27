import { readFileSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Test-only process boundary: production never imports this startup fault injector.
if (/\/worker\/(?:src|dist)\/index\.(?:ts|js)$/.test(process.argv[1] ?? "")) {
  const root = process.argv[2];
  const { SqliteStorage } = await import("@earendil-works/pi-durable/storage/sqlite");
  const commit = SqliteStorage.prototype.commit;
  SqliteStorage.prototype.commit = async function (writes, context) {
    const result = await commit.call(this, writes, context);
    const fault = await readFile(join(root, "worker-fault"), "utf8").catch(() => "");
    if (fault === "admission-crash" && writes.some((write) =>
      write.type === "submission" && write.value.type === "input" && write.value.requestId === "gap-input")) {
      await writeFile(join(root, "worker-fault"), "");
      process.kill(process.pid, "SIGKILL");
    }
    return result;
  };
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
