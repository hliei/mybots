import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { PiProvider } from "../packages/agent-runner/src/providers/pi.ts";
import type { ProviderEvent, QueryInput } from "../packages/agent-runner/src/providers/types.ts";
import { startPiService } from "./pi-fixture.ts";

async function exchange(provider: PiProvider, input: QueryInput) {
  const events: ProviderEvent[] = [];
  for await (const event of provider.query(input).events) events.push(event);
  return events;
}

test("loads truncated per-Bot memory through ordinary file tools and keeps it out of another Bot", async () => {
  const root = await mkdtemp(join(tmpdir(), "mybots-pi-memory-"));
  const alpha = join(root, "alpha");
  const beta = join(root, "beta");
  await mkdir(join(alpha, "memory", "topics"), { recursive: true });
  await mkdir(join(beta, "memory"), { recursive: true });
  await writeFile(join(alpha, "memory", "index.md"), `${"a".repeat(16000)}Ω`);
  await writeFile(join(alpha, "memory", "definition.md"), `${"字".repeat(16000)}尾`);
  await writeFile(join(alpha, "memory", "topics", "orchid.md"), "topic-body-orchid");
  await writeFile(join(beta, "memory", "index.md"), "bot-b-only-lilac");
  const service = await startPiService((request) => {
    const body = JSON.stringify(request);
    if (
      body.includes("Remember the orchard") &&
      !request.messages.some((message) => message.role === "tool")
    )
      return { tool: "write", arguments: { path: "memory/index.md", content: "agent kept plum" } };
    return { text: "noted" };
  });
  try {
    const provider = new PiProvider({ modelRuntime: service.runtime, model: service.model });
    const alphaInput = { cwd: alpha, sessionDir: join(root, "alpha-session") };
    const events = await exchange(provider, { ...alphaInput, prompt: "Remember the orchard" });
    expect(events.find((event) => event.type === "result")).toMatchObject({
      type: "result",
      text: "noted",
    });
    const first = JSON.stringify(service.requests[0]);
    expect(first).toContain("No approval is required for these edits.");
    expect(first).toContain(
      "16000 of 16001 characters. Read memory/index.md for the omitted detail.",
    );
    expect(first).toContain(
      "16000 of 16001 characters. Read memory/definition.md for the omitted detail.",
    );
    expect(first).toContain("a".repeat(100));
    expect(first).toContain("字".repeat(100));
    expect(first).not.toContain("Ω");
    expect(first).not.toContain("尾");
    expect(first).toContain("Topics: orchid.");
    expect(first).toContain("Topic text is not copied here.");
    expect(first).not.toContain("topic-body-orchid");
    expect(first).not.toContain("bot-b-only-lilac");
    expect(await readFile(join(alpha, "memory", "index.md"), "utf8")).toBe("agent kept plum");
    const init = events.find((event) => event.type === "init");
    if (init?.type !== "init") throw new Error("Missing SDK continuation");
    const ledger = init.continuation.slice(3);
    const before = await readFile(ledger, "utf8");
    expect(before).toContain("Remember the orchard");
    const reopened = await exchange(provider, {
      ...alphaInput,
      prompt: "Use the current index",
      continuation: init.continuation,
    });
    expect(reopened.find((event) => event.type === "result")).toMatchObject({ text: "noted" });
    const current = JSON.stringify(service.requests.at(-1));
    expect(current).toContain("agent kept plum");
    expect(current).toContain("supersede older recollections");
    expect(current).toContain("Earlier ledger entries stay unchanged.");
    expect(await readFile(ledger, "utf8")).toContain("Remember the orchard");
    await rm(join(alpha, "memory"), { recursive: true, force: true });
    await exchange(provider, {
      ...alphaInput,
      prompt: "After deletion",
      continuation: init.continuation,
    });
    const removedRequest = service.requests.at(-1);
    const removedSystem = JSON.stringify(removedRequest?.messages[0]?.content);
    expect(removedSystem).toContain("Long-term memory files were deleted.");
    expect(removedSystem).toContain(
      "does not erase retained conversation evidence or guarantee forgetting",
    );
    expect(removedSystem).not.toContain("Index:");
    expect(JSON.stringify(removedRequest?.messages)).toContain("agent kept plum");
    const retained = await readFile(ledger, "utf8");
    expect(retained).toContain("Remember the orchard");
    expect(retained.length).toBeGreaterThan(0);
    const betaEvents = await exchange(provider, {
      cwd: beta,
      sessionDir: join(root, "beta-session"),
      prompt: "What do you know",
    });
    expect(betaEvents.find((event) => event.type === "result")).toMatchObject({ text: "noted" });
    const isolated = JSON.stringify(service.requests.at(-1));
    expect(isolated).toContain("bot-b-only-lilac");
    expect(isolated).not.toContain("agent kept plum");
    expect(isolated).not.toContain("topic-body-orchid");
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

test("keeps an in-flight request on its original memory and supplies the owner correction later", async () => {
  const root = await mkdtemp(join(tmpdir(), "mybots-pi-memory-correction-"));
  await mkdir(join(root, "memory"), { recursive: true });
  await writeFile(join(root, "memory", "index.md"), "color blue");
  let holding = true;
  const service = await startPiService(() => (holding ? { hold: true } : { text: "corrected" }));
  const provider = new PiProvider({ modelRuntime: service.runtime, model: service.model });
  const input = { cwd: root, sessionDir: join(root, "pi") };
  const query = provider.query({ ...input, prompt: "State the color" });
  try {
    const events: ProviderEvent[] = [];
    const collected = (async () => {
      for await (const event of query.events) events.push(event);
    })();
    await service.waitForRequest();
    await writeFile(join(root, "memory", "index.md"), "owner-correction-pine");
    expect(JSON.stringify(service.requests[0])).toContain("color blue");
    expect(JSON.stringify(service.requests[0])).not.toContain("owner-correction-pine");
    await query.abort();
    await collected;
    const init = events.find((event) => event.type === "init");
    if (init?.type !== "init") throw new Error("Missing SDK continuation");
    const ledger = init.continuation.slice(3);
    holding = false;
    const reopened = await exchange(provider, {
      ...input,
      prompt: "State the corrected color",
      continuation: init.continuation,
    });
    expect(reopened.find((event) => event.type === "result")).toMatchObject({ text: "corrected" });
    const next = JSON.stringify(service.requests.at(-1));
    expect(next).toContain("owner-correction-pine");
    expect(next).toContain("supersede older recollections");
    expect(await readFile(ledger, "utf8")).not.toContain("owner-correction-pine");
    expect(await readFile(ledger, "utf8")).toContain("State the color");
  } finally {
    await query.abort();
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test("keeps current memory across SDK compaction and same-Run reopening", async () => {
  const root = await mkdtemp(join(tmpdir(), "mybots-pi-memory-compact-"));
  await mkdir(join(root, "memory"), { recursive: true });
  await writeFile(join(root, "memory", "definition.md"), "current-memory-cedar");
  const service = await startPiService((request) => {
    const system = JSON.stringify(request.messages[0]?.content);
    if (system.includes("summar")) return { text: "Retained fact: the owner's orchard is amber." };
    const latest = JSON.stringify(
      request.messages.findLast((message) => message.role === "user")?.content,
    );
    return { text: latest.includes("Long") ? "orchard amber ".repeat(16000) : "amber" };
  });
  try {
    const provider = new PiProvider({ modelRuntime: service.runtime, model: service.model });
    const input = { cwd: root, sessionDir: join(root, "pi") };
    const events = await exchange(provider, {
      ...input,
      prompt: "Long conversation about the amber orchard",
    });
    const init = events.find((event) => event.type === "init");
    if (init?.type !== "init") throw new Error("Missing SDK continuation");
    const ledger = init.continuation.slice(3);
    expect(await readFile(ledger, "utf8")).toContain('"type":"compaction"');
    expect(JSON.stringify(service.requests[0])).toContain("current-memory-cedar");
    await writeFile(join(root, "memory", "definition.md"), "current-memory-pine");
    const reopened = await exchange(provider, {
      ...input,
      prompt: "Recall the orchard",
      continuation: init.continuation,
    });
    expect(reopened.find((event) => event.type === "result")).toMatchObject({ text: "amber" });
    const next = JSON.stringify(service.requests.at(-1)?.messages);
    expect(next).toContain("Retained fact: the owner's orchard is amber.");
    expect(next).toContain("current-memory-pine");
    expect(next).toContain("supersede older recollections");
    const retained = await readFile(ledger, "utf8");
    expect(retained).toContain("Long conversation about the amber orchard");
    expect(retained).toContain("Retained fact: the owner's orchard is amber.");
    expect(retained).not.toContain("current-memory-pine");
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
