import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { PiProvider } from "../packages/agent-runner/src/providers/pi.ts";
import type { ProviderEvent } from "../packages/agent-runner/src/providers/types.ts";
import { waitForCheckpoint } from "./checkpoint.ts";
import { startPiService } from "./pi-fixture.ts";

test("records steering at a tool boundary and reopens only its Run without replaying known tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "mybots-run-sdk-"));
  const release = Promise.withResolvers<void>();
  const service = await startPiService(async (request) => {
    if (!request.messages.some((row) => row.role === "tool")) {
      await release.promise;
      return { tool: "bash", arguments: { command: "echo once >> effects.txt" } };
    }
    return { text: "Recorded final" };
  });
  const provider = new PiProvider({ modelRuntime: service.runtime, model: service.model });
  const input = {
    cwd: root,
    sessionDir: join(root, "run-one"),
    inputId: "source",
    prompt: "Perform request",
    runContext: {
      sourceMessageId: "source",
      backgroundBoundary: 0,
      references: [{ id: "old", role: "assistant", content: "Historical reference" }],
    },
  };
  const query = provider.query(input);
  const events: ProviderEvent[] = [];
  const collecting = (async () => {
    for await (const event of query.events) events.push(event);
  })();
  try {
    await service.waitForRequest();
    expect(query.push("Change the final reply", "steering")).toBe(true);
    release.resolve();
    await waitForCheckpoint(collecting, "SDK steering and final");
    expect(events.filter((row) => row.type === "recorded")).toEqual([
      { type: "recorded", inputId: "source" },
      { type: "recorded", inputId: "steering" },
    ]);
    expect(events.filter((row) => row.type === "result")).toEqual([
      { type: "result", text: "Recorded final", inputIds: ["source", "steering"] },
    ]);
    expect(await readFile(join(root, "effects.txt"), "utf8")).toBe("once\n");
    const continuation = events.find((row) => row.type === "init");
    expect(continuation?.type).toBe("init");
    const reopened = provider.query({
      ...input,
      continuation: continuation?.type === "init" ? continuation.continuation : undefined,
    });
    const recovered: ProviderEvent[] = [];
    for await (const event of reopened.events) recovered.push(event);
    expect(recovered.find((row) => row.type === "result")).toMatchObject({
      text: "Recorded final",
      inputIds: ["source"],
    });
    const noPointer = provider.query(input);
    const recoveredWithoutPointer: ProviderEvent[] = [];
    for await (const event of noPointer.events) recoveredWithoutPointer.push(event);
    expect(recoveredWithoutPointer.find((row) => row.type === "result")).toMatchObject({
      text: "Recorded final",
      inputIds: ["source"],
    });
    expect(service.requests).toHaveLength(2);
    expect(JSON.stringify(service.requests[0])).toContain("Historical reference");
    expect(JSON.stringify(service.requests[1])).toContain("Change the final reply");
  } finally {
    release.resolve();
    await query.abort();
    await collecting;
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("drops older Thread references before long live steering and fails visibly when required input cannot fit", async () => {
  const root = await mkdtemp(join(tmpdir(), "mybots-run-budget-"));
  const release = Promise.withResolvers<void>();
  const service = await startPiService(async (_request) => {
    if (service.requests.length === 1) {
      await release.promise;
      return { tool: "read", arguments: { path: "missing.txt" } };
    }
    return { text: "Complete" };
  });
  const provider = new PiProvider({ modelRuntime: service.runtime, model: service.model });
  const references = Array.from({ length: 7 }, (_, index) => ({
    id: `reference-${index}`,
    role: "assistant",
    content: `Old-${index}:${"history ".repeat(500)}`,
  }));
  const input = {
    cwd: root,
    sessionDir: join(root, "bounded-run"),
    inputId: "source",
    prompt: "Current source",
    runContext: { sourceMessageId: "source", backgroundBoundary: 0, references },
  };
  const query = provider.query(input);
  const events: ProviderEvent[] = [];
  const collecting = (async () => {
    for await (const event of query.events) events.push(event);
  })();
  try {
    await service.waitForRequest();
    const steering = `Keep every live instruction: ${"最新指示".repeat(700)}`;
    expect(query.push(steering, "steering")).toBe(true);
    release.resolve();
    await waitForCheckpoint(collecting, "bounded steering");
    const before = JSON.stringify(service.requests[0]);
    const after = JSON.stringify(service.requests[1]);
    expect(before).toContain("Old-6");
    expect(after).toContain(steering);
    expect(after.split("Historical Thread reference").length).toBeLessThan(
      before.split("Historical Thread reference").length,
    );
    expect(events.at(-1)).toMatchObject({ type: "result", text: "Complete" });
    const oversized = provider.query({
      ...input,
      inputId: "large",
      sessionDir: join(root, "large"),
      prompt: "live ".repeat(7000),
    });
    const failed: ProviderEvent[] = [];
    for await (const event of oversized.events) failed.push(event);
    expect(failed.at(-1)).toMatchObject({
      type: "result",
      isError: true,
      error: "Required Run input exceeds model capacity.",
    });
    expect(service.requests).toHaveLength(2);
  } finally {
    release.resolve();
    await query.abort();
    await collecting;
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
