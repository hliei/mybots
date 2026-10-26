import { expect, test, vi } from "vitest";
import { modelCatalog, providerModels } from "../packages/agent/src/providers.ts";
import { startDurableModel } from "./durable-model-fixture.ts";

const models = ["deepseek-flash", "glm-5.3", "minimax-m3", "gpt-6-luna", "gemini-4-argon"];

test.each(models.flatMap((id) => ["headers", "body"].map((phase) => [id, phase] as const)))(
  "%s aborts while waiting for idle %s instead of hanging",
  async (id, phase) => {
    const service = await startDurableModel(() =>
      phase === "headers" ? { hold: true } : { wire: ": keep-alive\n\n", stall: true },
    );
    const model = modelCatalog.find((model) => model.id === id);
    if (!model) throw new Error("Fixture model missing");
    let started: () => void = () => {};
    const first = new Promise<void>((resolve) => {
      started = resolve;
    });
    const cancel = new AbortController();
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const stream = providerModels(() => "fixture-key").streamSimple(
        { ...model, baseUrl: service.config.baseUrl },
        { messages: [{ role: "user", content: "Answer", timestamp: 1 }] },
        { signal: cancel.signal, maxRetries: 0 },
      );
      const completion = (async () => {
        for await (const event of stream) if (event.type === "start") started();
        return stream.result();
      })();
      await service.waitForRequest();
      if (phase === "body") await first;
      await vi.advanceTimersByTimeAsync(180001);
      const result = await completion;
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toMatch(/stream.*timed out/i);
      expect(service.requests).toHaveLength(1);
    } finally {
      cancel.abort();
      vi.useRealTimers();
      await service.close();
    }
  },
  10000,
);

test("model progress refreshes the idle deadline until the real terminal signal", async () => {
  let releaseChunk: () => void = () => {};
  let releaseEnd: () => void = () => {};
  let observeDelta: () => void = () => {};
  let observeStart: () => void = () => {};
  const chunk = new Promise<void>((resolve) => {
    releaseChunk = resolve;
  });
  const end = new Promise<void>((resolve) => {
    releaseEnd = resolve;
  });
  const delta = new Promise<void>((resolve) => {
    observeDelta = resolve;
  });
  const start = new Promise<void>((resolve) => {
    observeStart = resolve;
  });
  const service = await startDurableModel(() => ({
    chunks: (async function* () {
      await chunk;
      yield "Progress";
      await end;
    })(),
  }));
  const model = modelCatalog.find((model) => model.id === "deepseek-flash");
  if (!model) throw new Error("Fixture model missing");
  const cancel = new AbortController();
  try {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stream = providerModels(() => "fixture-key").streamSimple(
      { ...model, baseUrl: service.config.baseUrl },
      { messages: [{ role: "user", content: "Answer", timestamp: 1 }] },
      { signal: cancel.signal, maxRetries: 0 },
    );
    const completion = (async () => {
      for await (const event of stream) {
        if (event.type === "start") observeStart();
        if (event.type === "text_delta") observeDelta();
      }
      return stream.result();
    })();
    await start;
    await vi.advanceTimersByTimeAsync(179000);
    releaseChunk();
    await delta;
    await vi.advanceTimersByTimeAsync(179000);
    releaseEnd();
    expect((await completion).stopReason).toBe("stop");
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    cancel.abort();
    releaseChunk();
    releaseEnd();
    vi.useRealTimers();
    await service.close();
  }
});
