import { writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import type { Bot, ChatView } from "@mybots/contracts";
import { expect, test } from "vitest";
import { apiFixture } from "./durable-api-fixture.ts";

test("chat offers only Computer shell and file tools without starting Docker", async () => {
  const fixture = await apiFixture();
  try {
    const bot = (await fixture.request("bots", {
      name: "Computer user",
      instructions: "",
      model: "controlled",
    })) as Bot;
    await fixture.request(`bots/${bot.id}/send`, { text: "Hello", requestId: "tools" });
    await settled(fixture, bot);
    expect(fixture.service.requests[0]?.tools?.map((tool) => tool.function.name).sort()).toEqual([
      "read_file",
      "shell",
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
      model: "controlled",
    })) as Bot;
    const second = (await fixture.request("bots", {
      name: "Reader",
      instructions: "Read carefully",
      model: "controlled",
    })) as Bot;
    expect(first.threadId).not.toBe(second.threadId);
    expect(first.conversationId).not.toBe(second.conversationId);
    const sent = await fixture.request(`bots/${first.id}/send`, {
      text: "Remember this original",
      requestId: "send-once",
    });
    expect(sent.id).toBeGreaterThan(0);
    const before = await settled(fixture, first);
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
      model: "controlled",
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
      model: "controlled",
    })) as Bot;
    const changed = (await fixture.request(
      `bots/${bot.id}`,
      { name: "After", instructions: "Updated role", model: "controlled" },
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
      model: "controlled",
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
      model: "controlled",
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
      model: "controlled",
    })) as Bot;
    await fixture.request(`bots/${bot.id}/send`, {
      text: "Original message",
      requestId: "original",
    });
    const before = await settled(fixture, bot);
    await writeFile(
      join(fixture.root, "models.json"),
      JSON.stringify([{ ...fixture.service.config, id: "replacement" }]),
      { mode: 0o600 },
    );
    await fixture.reopen();
    expect((await settled(fixture, bot)).messages).toEqual(before.messages);
    const changed = (await fixture.request(
      `bots/${bot.id}`,
      { name: bot.name, instructions: "Use the replacement", model: "replacement" },
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
      model: "controlled",
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
