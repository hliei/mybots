import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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

test("Pi discovers only selected Agent Skills and loads their instructions with the selected tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "mybots-pi-resources-"));
  const workspace = join(root, "group");
  const skill = join(workspace, "skills", "brief", "SKILL.md");
  await mkdir(join(workspace, "skills", "brief"), { recursive: true });
  await mkdir(join(workspace, ".agents", "skills", "engineering"), { recursive: true });
  await writeFile(
    skill,
    "---\nname: brief\ndescription: Produce a brief answer\n---\nUse the shared phrase: amber orchard.\n",
  );
  await writeFile(
    join(workspace, ".agents", "skills", "engineering", "SKILL.md"),
    "---\nname: engineering\ndescription: HOST ENGINEERING SECRET\n---\nHost only\n",
  );
  await writeFile(join(root, "AGENTS.md"), "HOST INSTRUCTIONS SECRET");
  await writeFile(join(workspace, "AGENTS.md"), "Shared Agent instructions: concise answers.");
  const service = await startPiService((request) => {
    if (!request.messages.some((message) => message.role === "tool"))
      return { tool: "read", arguments: { path: skill } };
    return { text: "amber orchard" };
  });
  try {
    const provider = new PiProvider({ modelRuntime: service.runtime, model: service.model });
    const resources = { skills: ["brief"], tools: ["read"] as const };
    const events = await exchange(provider, {
      prompt: "Use brief",
      cwd: workspace,
      sessionDir: join(root, "session", "pi"),
      systemContext: { instructions: "Owner instruction", ...{ resources } },
    });
    expect(events.find((event) => event.type === "result")).toEqual({
      type: "result",
      text: "amber orchard",
    });
    const request = JSON.stringify(service.requests[0]);
    expect(request).toContain("Produce a brief answer");
    expect(request).toContain("Shared Agent instructions: concise answers.");
    expect(request).toContain("Owner instruction");
    expect(request).not.toContain("HOST ENGINEERING SECRET");
    expect(request).not.toContain("HOST INSTRUCTIONS SECRET");
    expect(JSON.stringify(service.requests[1])).toContain("Use the shared phrase: amber orchard.");
    expect(service.requests[0].tools?.map((tool) => tool.function.name)).toEqual(["read"]);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi compacts long context and explicitly reopens its SDK summary", async () => {
  const root = await mkdtemp(join(tmpdir(), "mybots-pi-compaction-"));
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
    const history = await readFile(init.continuation.slice(3), "utf8");
    expect(history).toContain('"type":"compaction"');
    expect(history).toContain("Retained fact: the owner's orchard is amber.");
    const reopened = await exchange(provider, {
      ...input,
      prompt: "Recall the orchard",
      continuation: init.continuation,
    });
    expect(reopened.filter((event) => event.type === "result")).toEqual([
      { type: "result", text: "amber" },
    ]);
    expect(JSON.stringify(service.requests.at(-1)?.messages)).toContain(
      "Retained fact: the owner's orchard is amber.",
    );
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test("reset saves a fresh SDK conversation without model traffic or deleting shared material", async () => {
  const root = await mkdtemp(join(tmpdir(), "mybots-pi-reset-"));
  const service = await startPiService(() => ({ text: "Acknowledged" }));
  try {
    const provider = new PiProvider({ modelRuntime: service.runtime, model: service.model });
    const input = { cwd: root, sessionDir: join(root, "pi") };
    await writeFile(join(root, "shared.txt"), "amber orchard");
    const before = await exchange(provider, {
      ...input,
      prompt: "Private conversation before reset",
    });
    const old = before.find((event) => event.type === "init");
    if (old?.type !== "init") throw new Error("Missing SDK continuation");
    const reset = await exchange(provider, {
      ...input,
      prompt: "Conversation reset by owner.",
      continuation: old.continuation,
      ...{ control: "reset" as const },
    });
    const fresh = reset.find((event) => event.type === "init");
    if (fresh?.type !== "init") throw new Error("Missing reset continuation");
    expect(fresh.continuation).not.toBe(old.continuation);
    expect(service.requests).toHaveLength(1);
    expect(await readFile(fresh.continuation.slice(3), "utf8")).not.toContain(
      "Private conversation before reset",
    );
    await exchange(provider, { ...input, prompt: "After reset", continuation: fresh.continuation });
    expect(JSON.stringify(service.requests.at(-1))).not.toContain(
      "Private conversation before reset",
    );
    expect(await readFile(old.continuation.slice(3), "utf8")).toContain(
      "Private conversation before reset",
    );
    expect(await readFile(join(root, "shared.txt"), "utf8")).toBe("amber orchard");
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("separate Pi conversations read shared Agent material without sharing private history", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mybots-pi-shared-")));
  const workspace = join(root, "group");
  await mkdir(workspace);
  const service = await startPiService((request) => {
    const latest = JSON.stringify(
      request.messages.findLast((message) => message.role === "user")?.content,
    );
    if (request.messages.some((message) => message.role === "tool"))
      return { text: "amber orchard" };
    if (latest.includes("Save"))
      return { tool: "write", arguments: { path: "shared.txt", content: "amber orchard" } };
    return { tool: "read", arguments: { path: "shared.txt" } };
  });
  try {
    const provider = new PiProvider({ modelRuntime: service.runtime, model: service.model });
    const first = await exchange(provider, {
      cwd: workspace,
      sessionDir: join(root, "first", "pi"),
      prompt: "Save my private request's orchard in shared.txt",
    });
    const second = await exchange(provider, {
      cwd: workspace,
      sessionDir: join(root, "second", "pi"),
      prompt: "Read the shared orchard",
    });
    expect(second.filter((event) => event.type === "result")).toEqual([
      { type: "result", text: "amber orchard" },
    ]);
    expect(JSON.stringify(service.requests.at(-1)?.messages)).not.toContain(
      "Save my private request",
    );
    const a = first.find((event) => event.type === "init");
    const b = second.find((event) => event.type === "init");
    if (a?.type !== "init" || b?.type !== "init") throw new Error("Missing SDK continuations");
    expect(a.continuation).not.toBe(b.continuation);
    expect(await readFile(b.continuation.slice(3), "utf8")).not.toContain(
      "Save my private request",
    );
    expect(await readFile(a.continuation.slice(3), "utf8")).not.toContain(
      "Read the shared orchard",
    );
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing selected Skill fails before contacting the model", async () => {
  const root = await mkdtemp(join(tmpdir(), "mybots-pi-missing-skill-"));
  const service = await startPiService(() => ({ text: "Unexpected model request" }));
  try {
    const provider = new PiProvider({ modelRuntime: service.runtime, model: service.model });
    const events = await exchange(provider, {
      cwd: root,
      sessionDir: join(root, "pi"),
      prompt: "Use the selected Skill",
      systemContext: { resources: { skills: ["missing"] } },
    });
    expect(events).toEqual([
      { type: "result", text: null, isError: true, error: "Agent query failed." },
    ]);
    expect(service.requests).toEqual([]);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
