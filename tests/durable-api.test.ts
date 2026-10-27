import { request as httpRequest } from "node:http";
import type { Bot, ChatView } from "@mybots/contracts";
import { expect, test } from "vitest";
import { apiFixture } from "./durable-api-fixture.ts";

test("chat offers Computer and resource tools without starting Docker", async () => {
  const fixture = await apiFixture();
  try {
    const bot = (await fixture.request("bots", {
      name: "Computer user",
      instructions: "",
      model: "deepseek/deepseek-flash",
    })) as Bot;
    await fixture.request(`bots/${bot.id}/send`, { text: "Hello", requestId: "tools" });
    await settled(fixture, bot);
    expect(fixture.service.requests[0]?.tools?.map((tool) => tool.function.name).sort()).toEqual([
      "command_status",
      "history_read",
      "history_search",
      "list_files",
      "list_services",
      "memory_delete",
      "memory_read",
      "memory_write",
      "preview_service",
      "read_file",
      "shell",
      "skill_delete",
      "skill_read",
      "skill_write",
      "start_service",
      "stop_service",
      "write_file",
    ]);
  } finally {
    await fixture.close();
  }
});

async function settled(
  fixture: Awaited<ReturnType<typeof apiFixture>>,
  bot: Bot,
): Promise<ChatView> {
  let view: ChatView | undefined;
  await expect
    .poll(
      async () => {
        view = (await fixture.request(`bots/${bot.id}/chat`)) as ChatView;
        return view.busy;
      },
      { timeout: 5000 },
    )
    .toBe(false);
  if (!view) throw new Error("Chat view unavailable");
  return view;
}

test("public API admits once, streams and reopens separate Bot Threads", async () => {
  const fixture = await apiFixture();
  try {
    const first = (await fixture.request("bots", {
      name: "Writer",
      instructions: "Write clearly",
      model: "deepseek/deepseek-flash",
    })) as Bot;
    const second = (await fixture.request("bots", {
      name: "Reader",
      instructions: "Read carefully",
      model: "deepseek/deepseek-flash",
    })) as Bot;
    expect(first.threadId).not.toBe(second.threadId);
    expect(first.conversationId).not.toBe(second.conversationId);
    expect(await fixture.request(`bots/${first.id}/submissions/send-once`)).toBeNull();
    const sent = await fixture.request(`bots/${first.id}/send`, {
      text: "Remember this original",
      requestId: "send-once",
    });
    expect(sent.id).toBeGreaterThan(0);
    const before = await settled(fixture, first);
    expect(await fixture.request(`bots/${first.id}/submissions/send-once`)).toEqual({
      ...sent,
      status: "done",
    });
    expect(await fixture.request(`bots/${second.id}/submissions/send-once`)).toBeNull();
    expect(before.messages.map((message) => message.text)).toEqual([
      "Remember this original",
      "Persistent answer",
    ]);
    expect((await settled(fixture, second)).messages).toEqual([]);
    await fixture.reopen();
    const retried = await fixture.request(`bots/${first.id}/send`, {
      text: "Remember this original",
      requestId: "send-once",
    });
    expect(retried).toEqual(sent);
    expect((await settled(fixture, first)).messages).toEqual(before.messages);
    expect((await fixture.request("bots")).bots).toEqual([first, second]);
    expect(fixture.service.requests).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});

test("busy sends use native steering and Stop retains withdrawn inputs after reopen", async () => {
  const fixture = await apiFixture(() => ({ hold: true }));
  try {
    const bot = (await fixture.request("bots", {
      name: "Busy Bot",
      instructions: "",
      model: "deepseek/deepseek-flash",
    })) as Bot;
    await fixture.request(`bots/${bot.id}/send`, { text: "Working input", requestId: "working" });
    await fixture.service.waitForRequest();
    const steering = await fixture.request(`bots/${bot.id}/send`, {
      text: "Additional instructions",
      requestId: "steering",
    });
    const busy = (await fixture.request(`bots/${bot.id}/chat`)) as ChatView;
    expect(busy.busy).toBe(true);
    expect(busy.inputs).toContainEqual({
      id: steering.id,
      requestId: "steering",
      text: "Additional instructions",
      status: "queued",
    });
    await fixture.request(`bots/${bot.id}/stop`, {});
    const stopped = await settled(fixture, bot);
    expect(stopped.inputs).toContainEqual({
      id: steering.id,
      requestId: "steering",
      text: "Additional instructions",
      status: "unanswered",
      reason: "aborted",
    });
    await fixture.crashWorker();
    await fixture.reopen();
    expect((await settled(fixture, bot)).inputs).toEqual(stopped.inputs);
    expect(fixture.service.requests).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});

test("local access rejects foreign origins and configuration hides host credentials", async () => {
  const fixture = await apiFixture();
  try {
    expect((await fetch(new URL("api/bots", fixture.url))).status).toBe(401);
    expect(
      (
        await fetch(new URL("api/bots", fixture.url), {
          headers: { Authorization: `Bearer ${fixture.credential}`, Origin: "https://example.com" },
        })
      ).status,
    ).toBe(403);
    const foreignHost = await new Promise<number | undefined>((resolve, reject) => {
      httpRequest(
        new URL("api/bots", fixture.url),
        { headers: { Authorization: `Bearer ${fixture.credential}`, Host: "example.com" } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      )
        .on("error", reject)
        .end();
    });
    expect(foreignHost).toBe(403);
    const invalid = await fetch(new URL("api/bots", fixture.url), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fixture.credential}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Invalid", instructions: "", model: "unconfigured" }),
    });
    expect(invalid.status).toBe(400);
    const bot = (await fixture.request("bots", {
      name: "Before",
      instructions: "Initial role",
      model: "deepseek/deepseek-flash",
    })) as Bot;
    const changed = (await fixture.request(
      `bots/${bot.id}`,
      { name: "After", instructions: "Updated role", model: "deepseek/deepseek-flash" },
      "PATCH",
    )) as Bot;
    expect(changed.threadId).toBe(bot.threadId);
    expect(changed.conversationId).toBe(bot.conversationId);
    await fixture.request(`bots/${bot.id}/send`, {
      text: "Read saved role",
      requestId: "configured",
    });
    await settled(fixture, bot);
    expect(JSON.stringify(fixture.service.requests)).toContain("Updated role");
    const exposed = JSON.stringify(await fixture.request("bots"));
    expect(exposed).not.toContain(fixture.service.config.apiKey);
    expect(exposed).not.toContain(fixture.service.config.baseUrl);
  } finally {
    await fixture.close();
  }
});

test("public event stream delivers partial and settled committed answers", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = await apiFixture(() => ({
    chunks: (async function* () {
      yield "Growing answer";
      await held;
      yield " complete";
    })(),
  }));
  const controller = new AbortController();
  try {
    const bot = (await fixture.request("bots", {
      name: "Streaming",
      instructions: "",
      model: "deepseek/deepseek-flash",
    })) as Bot;
    const response = await fetch(new URL(`api/bots/${bot.id}/events`, fixture.url), {
      headers: { Authorization: `Bearer ${fixture.credential}` },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
    });
    if (!response.body) throw new Error("Missing event stream");
    const reader = response.body.getReader();
    let buffer = "";
    const next = async (predicate: (view: ChatView) => boolean) => {
      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (frame.startsWith("event:")) continue;
          const view = JSON.parse(frame.slice(6)) as ChatView;
          if (predicate(view)) return view;
        } else {
          const chunk = await reader.read();
          if (chunk.done) throw new Error("Event stream ended early");
          buffer += new TextDecoder().decode(chunk.value);
        }
      }
    };
    await next((view) => !view.busy);
    await fixture.request(`bots/${bot.id}/send`, { text: "Stream it", requestId: "stream" });
    expect((await next((view) => !!view.partial)).partial).toBe("Growing answer");
    release();
    const final = await next(
      (view) =>
        !view.busy && view.messages.some((message) => message.text === "Growing answer complete"),
    );
    expect(final.partial).toBe("");
    controller.abort();
  } finally {
    release();
    controller.abort();
    await fixture.close();
  }
});

test("one worker owns a data root and another startup cannot disrupt admitted chat", async () => {
  const fixture = await apiFixture();
  let duplicate:
    | Awaited<ReturnType<typeof import("../apps/api/src/server.ts").startApi>>
    | undefined;
  try {
    const { startApi } = await import("../apps/api/src/server.ts");
    await expect(async () => {
      duplicate = await startApi(fixture.root);
    }).rejects.toThrow("Worker unavailable");
    const bot = (await fixture.request("bots", {
      name: "Owner",
      instructions: "",
      model: "deepseek/deepseek-flash",
    })) as Bot;
    await fixture.request(`bots/${bot.id}/send`, { text: "Still available", requestId: "owner" });
    expect((await settled(fixture, bot)).messages.at(-1)?.text).toBe("Persistent answer");
  } finally {
    await duplicate?.close();
    await fixture.close();
  }
});

test("removing a configured model preserves startup and permits changing the saved choice", async () => {
  const fixture = await apiFixture();
  try {
    const bot = (await fixture.request("bots", {
      name: "Existing Bot",
      instructions: "",
      model: "deepseek/deepseek-flash",
    })) as Bot;
    await fixture.request(`bots/${bot.id}/send`, {
      text: "Original message",
      requestId: "original",
    });
    const before = await settled(fixture, bot);
    await fixture.request("providers/deepseek", undefined, "DELETE");
    await fixture.reopen();
    expect((await settled(fixture, bot)).messages).toEqual(before.messages);
    const changed = (await fixture.request(
      `bots/${bot.id}`,
      { name: bot.name, instructions: "Use the replacement", model: "opencode-go/glm-5.3" },
      "PATCH",
    )) as Bot;
    expect(changed.conversationId).toBe(bot.conversationId);
    await fixture.request(`bots/${bot.id}/send`, { text: "Continue", requestId: "replacement" });
    expect((await settled(fixture, bot)).messages.at(-1)?.text).toBe("Persistent answer");
    expect(JSON.stringify(fixture.service.requests.at(-1))).toContain("Use the replacement");
  } finally {
    await fixture.close();
  }
});

test("invalid Computer tool paths produce a visible failure without reading host files", async () => {
  let first = true;
  const fixture = await apiFixture(() => {
    if (first) {
      first = false;
      return { tool: "read_file", arguments: { path: "../models.json" } };
    }
    return { text: "The file operation failed" };
  });
  try {
    const bot = await fixture.request("bots", {
      name: "Reader",
      instructions: "",
      model: "deepseek/deepseek-flash",
    });
    await fixture.request(`bots/${bot.id}/send`, { text: "Read", requestId: "invalid-path" });
    const view = await settled(fixture, bot);
    expect(view.messages.flatMap((message) => message.tools)).toEqual(["read_file"]);
    expect(view.messages.find((message) => message.role === "tool")?.text).toContain(
      "Path escapes",
    );
    expect(JSON.stringify(view)).not.toContain("fixture-key");
    expect(view.messages.at(-1)?.text).toBe("The file operation failed");
  } finally {
    await fixture.close();
  }
});

test("model failure keeps admitted input visibly unanswered and resendable after reopen", async () => {
  const fixture = await apiFixture(() => ({ status: 400 }));
  try {
    const bot = await fixture.request("bots", {
      name: "Failed Bot",
      instructions: "",
      model: "deepseek/deepseek-flash",
    });
    const sent = await fixture.request(`bots/${bot.id}/send`, {
      text: "Keep this failed input",
      requestId: "model-failure",
    });
    const failed = await settled(fixture, bot);
    expect(failed.inputs).toContainEqual({
      id: sent.id,
      requestId: "model-failure",
      text: "Keep this failed input",
      status: "unanswered",
      reason: "model_error",
      detail: expect.stringContaining("model request failed"),
    });
    expect(fixture.service.requests).toHaveLength(1);
    await fixture.reopen();
    expect((await settled(fixture, bot)).inputs).toEqual(failed.inputs);
    expect(fixture.service.requests).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});

test("steering arriving behind a final answer becomes subsequent native work", async () => {
  let release: () => void = () => {};
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = await apiFixture(() =>
    fixture.service.requests.length === 1
      ? {
          chunks: (async function* () {
            yield "First answer";
            await barrier;
          })(),
        }
      : { text: "Subsequent answer" },
  );
  try {
    const bot = await fixture.request("bots", {
      name: "Steering",
      instructions: "",
      model: "deepseek/deepseek-flash",
    });
    await fixture.request(`bots/${bot.id}/send`, { text: "First work", requestId: "first-work" });
    await fixture.service.waitForRequest(1);
    await fixture.request(`bots/${bot.id}/send`, {
      text: "Then this work",
      requestId: "later-work",
    });
    expect((await fixture.request(`bots/${bot.id}/chat`)).inputs).toEqual([
      expect.objectContaining({ text: "Then this work", status: "queued" }),
    ]);
    expect(fixture.service.requests).toHaveLength(1);
    release();
    const final = await settled(fixture, bot);
    expect(final.messages.map((message) => message.text)).toEqual([
      "First work",
      "First answer",
      "Then this work",
      "Subsequent answer",
    ]);
    expect(final.inputs).toEqual([]);
    expect(fixture.service.requests).toHaveLength(2);
  } finally {
    release();
    await fixture.close();
  }
});

test("worker crash resumes admitted work and queued steering without replaying committed tools", async () => {
  let release: () => void = () => {};
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let count = 0;
  const fixture = await apiFixture(() => {
    count++;
    if (count === 1) return { tool: "memory_read", arguments: { scope: "bot" } };
    if (count === 2)
      return {
        chunks: (async function* () {
          yield "Committed partial";
          await barrier;
        })(),
      };
    return { text: count === 3 ? "Resumed answer" : "Queued answer" };
  });
  try {
    const bot = await fixture.request("bots", {
      name: "Recover",
      instructions: "",
      model: "deepseek/deepseek-flash",
    });
    const admitted = await fixture.request(`bots/${bot.id}/send`, {
      text: "Do tool work",
      requestId: "crash-work",
    });
    await expect
      .poll(async () => (await fixture.request(`bots/${bot.id}/chat`)).partial)
      .toBe("Committed partial");
    const queued = await fixture.request(`bots/${bot.id}/send`, {
      text: "Persisted steering",
      requestId: "crash-queued",
    });
    const before = (await fixture.request(`bots/${bot.id}/chat`)) as ChatView;
    expect(before.messages.filter((message) => message.role === "tool")).toHaveLength(1);
    await fixture.crashWorker();
    await expect
      .poll(
        async () => {
          try {
            return (await fixture.request(`bots/${bot.id}/chat`)).busy;
          } catch {
            return true;
          }
        },
        { timeout: 10000 },
      )
      .toBe(false);
    const after = await settled(fixture, bot);
    expect(after.threadId).toBe(bot.threadId);
    expect(after.messages.filter((message) => message.role === "tool")).toEqual(
      before.messages.filter((message) => message.role === "tool"),
    );
    expect(
      after.messages.filter((message) => message.role === "user").map((message) => message.text),
    ).toEqual(["Do tool work", "Persisted steering"]);
    expect(after.messages).toContainEqual(
      expect.objectContaining({ text: "Committed partial", status: "aborted" }),
    );
    expect(after.messages.at(-1)?.text).toBe("Queued answer");
    expect(after.inputs).toEqual([]);
    expect(
      await fixture.request(`bots/${bot.id}/send`, {
        text: "Do tool work",
        requestId: "crash-work",
      }),
    ).toEqual(admitted);
    expect(
      await fixture.request(`bots/${bot.id}/send`, {
        text: "Persisted steering",
        requestId: "crash-queued",
      }),
    ).toEqual(queued);
    expect(count).toBe(4);
  } finally {
    release();
    await fixture.close();
  }
}, 15000);

test("unanswered input survives history window eviction and a fresh worker", async () => {
  const fixture = await apiFixture(() => ({ status: 401 }));
  try {
    const bot = await fixture.request("bots", {
      name: "Old input",
      instructions: "",
      model: "deepseek/deepseek-flash",
    });
    await fixture.request(`bots/${bot.id}/send`, {
      text: "Keep this unanswered",
      requestId: "old-input",
    });
    await settled(fixture, bot);
    await fixture.shutdown();
    const { openAgent, context } = await import("@mybots/agent");
    const { join } = await import("node:path");
    const harness = await openAgent(join(fixture.root, "durable.sqlite"), []);
    try {
      const chat = await harness.conversation(bot.conversationId, context);
      if (!chat) throw new Error("Missing Conversation");
      for (let i = 0; i < 205; i++)
        await chat.submit(
          { type: "write", entry: { kind: "display.padding", data: { index: i } } },
          context,
        );
    } finally {
      await harness.close(context);
    }
    await fixture.reopen();
    const view = await settled(fixture, bot);
    expect(view.inputs).toContainEqual(
      expect.objectContaining({
        text: "Keep this unanswered",
        requestId: "old-input",
        status: "unanswered",
      }),
    );
  } finally {
    await fixture.close();
  }
});

test("input admitted before a lost display receipt remains discoverable after a crash", async () => {
  const { writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const fixture = await apiFixture(() => ({ hold: true }), { workerFaults: true });
  try {
    const bot = await fixture.request("bots", {
      name: "Admission gap",
      instructions: "",
      model: "deepseek/deepseek-flash",
    });
    await fixture.request(`bots/${bot.id}/send`, { text: "Active input", requestId: "active-gap" });
    await fixture.service.waitForRequest();
    await writeFile(join(fixture.root, "worker-fault"), "admission-crash");
    const response = await fetch(new URL(`api/bots/${bot.id}/send`, fixture.url), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fixture.credential}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "Keep the admitted input", requestId: "gap-input" }),
    });
    expect(response.status).toBe(503);
    await expect
      .poll(
        async () =>
          (
            await (
              await fetch(new URL("api/worker", fixture.url), {
                headers: { Authorization: `Bearer ${fixture.credential}` },
              })
            ).json()
          ).state,
        { timeout: 10000 },
      )
      .toBe("recovered");
    await fixture.service.waitForRequest(2);
    await fixture.request(`bots/${bot.id}/stop`, {});
    const view = await settled(fixture, bot);
    expect(view.inputs).toContainEqual(
      expect.objectContaining({
        text: "Keep the admitted input",
        requestId: "gap-input",
        status: "unanswered",
      }),
    );
    expect(fixture.service.requests).toHaveLength(2);
  } finally {
    await fixture.close();
  }
});

test("chat associates concise tool steps with narration and native final answers", async () => {
  let calls = 0;
  const fixture = await apiFixture(() =>
    ++calls === 1
      ? {
          text: "I will check the saved memory.",
          tools: [
            { name: "memory_read", arguments: { scope: "bot" } },
            { name: "read_file", arguments: { path: "../private" } },
          ],
        }
      : { text: "The check is complete; the file was unavailable." },
  );
  try {
    const bot = await fixture.request("bots", {
      name: "Projection",
      instructions: "",
      model: "deepseek/deepseek-flash",
    });
    await fixture.request(`bots/${bot.id}/send`, { text: "Check", requestId: "projection" });
    const view = await settled(fixture, bot);
    const narration = view.messages.find(
      (message) => message.text === "I will check the saved memory.",
    );
    expect(narration).toMatchObject({
      status: "Narration",
      steps: [
        { name: "memory_read", status: "Completed" },
        { name: "read_file", status: "Failed" },
      ],
    });
    expect(narration?.steps?.[1]?.summary).toContain("Path escapes");
    expect(new Set(narration?.steps?.map((step) => step.callId)).size).toBe(2);
    expect(view.messages.at(-1)).toMatchObject({
      text: "The check is complete; the file was unavailable.",
      status: "Completed",
    });
    await fixture.reopen();
    expect((await settled(fixture, bot)).messages).toEqual(view.messages);
  } finally {
    await fixture.close();
  }
});

test("tool call identifiers reused in later replies keep their own results", async () => {
  let calls = 0;
  const fixture = await apiFixture(() => {
    calls++;
    if (calls % 2 === 0) return { text: `Final answer ${calls}` };
    const tool =
      calls === 1
        ? { name: "read_file", arguments: { path: "../private" } }
        : { name: "memory_read", arguments: { scope: "bot" } };
    return {
      wire: `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "reused-call", type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
    };
  });
  try {
    const bot = await fixture.request("bots", {
      name: "Call identity",
      instructions: "",
      model: "deepseek/deepseek-flash",
    });
    await fixture.request(`bots/${bot.id}/send`, { text: "First check", requestId: "call-first" });
    await settled(fixture, bot);
    await fixture.request(`bots/${bot.id}/send`, {
      text: "Second check",
      requestId: "call-second",
    });
    const view = await settled(fixture, bot);
    const steps = view.messages.flatMap((message) => message.steps ?? []);
    expect(steps).toMatchObject([
      { callId: "reused-call", name: "read_file", status: "Failed" },
      { callId: "reused-call", name: "memory_read", status: "Completed" },
    ]);
  } finally {
    await fixture.close();
  }
});
