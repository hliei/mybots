import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiProvider } from "../packages/agent-runner/dist/providers/pi.js";
import { startPiService } from "../tests/pi-fixture.ts";

const root = await mkdtemp(join(tmpdir(), "mybots-pi-demo-"));
const workspace = join(root, "groups", "personal");
await mkdir(workspace, { recursive: true });
const sessionDir = join(root, "data", "sessions", "personal", "cli", "pi");
const service = await startPiService((request) => {
  const lastUser = request.messages.findLast((message) => message.role === "user");
  if (JSON.stringify(lastUser?.content).includes("Reopen")) {
    assert.ok(request.messages.some((message) => message.role === "tool"));
    return { text: "The saved conversation includes the note tool result." };
  }
  return request.messages.some((message) => message.role === "tool")
    ? { text: "The note is saved." }
    : { tool: "write", arguments: { path: "note.txt", content: "Saved by Pi\n" } };
});
const provider = new PiProvider({ modelRuntime: service.runtime, model: service.model });
const queries = [];
try {
  const first = provider.query({ prompt: "Save a note", cwd: workspace, sessionDir });
  queries.push(first);
  let continuation;
  for await (const event of first.events) {
    if (event.type === "init") continuation = event.continuation;
    if (event.type === "result") {
      assert.equal(event.isError, undefined);
      assert.equal(event.text, "The note is saved.");
      console.log(`Reply: ${event.text}`);
    }
  }
  assert.equal(await readFile(join(workspace, "note.txt"), "utf8"), "Saved by Pi\n");
  assert.ok(continuation);
  const reopened = new PiProvider({ modelRuntime: service.runtime, model: service.model }).query({
    prompt: "Reopen the saved conversation",
    cwd: workspace,
    sessionDir,
    continuation,
  });
  queries.push(reopened);
  for await (const event of reopened.events) {
    if (event.type === "init") assert.equal(event.continuation, continuation);
    if (event.type === "result") {
      assert.equal(event.isError, undefined);
      assert.equal(event.text, "The saved conversation includes the note tool result.");
      console.log(`Reopened reply: ${event.text}`);
    }
  }
  assert.equal(service.requests.length, 3);
  console.log("Workspace tool effect and selected-session reopening passed.");
} finally {
  for (const query of queries) await query.abort();
  await service.close();
  await rm(root, { recursive: true, force: true });
}
