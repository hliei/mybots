import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { startApi } from "../apps/api/src/server.ts";
import { apiFixture } from "./durable-api-fixture.ts";

test("unconfigured startup supports local provider settings without revealing keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "mybots-settings-"));
  let api: Awaited<ReturnType<typeof startApi>> | undefined;
  try {
    api = await startApi(root);
    const credential = (await readFile(join(root, "client-credential"), "utf8")).trim();
    const request = async (path: string, method = "GET", body?: unknown) => {
      const response = await fetch(new URL(`api/${path}`, api?.url), {
        method,
        headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      return response.json();
    };
    expect(await request("providers")).toEqual([
      { id: "deepseek", name: "DeepSeek", configured: false },
      { id: "opencode-go", name: "OpenCode Go", configured: false },
    ]);
    const saved = await request("providers/deepseek", "PUT", { apiKey: "secret-one" });
    expect(JSON.stringify(saved)).not.toContain("secret-one");
    expect(saved[0].configured).toBe(true);
    expect((await stat(join(root, "providers", "credentials.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, "providers"))).mode & 0o777).toBe(0o700);
    await request("providers/deepseek", "PUT", { apiKey: "" });
    expect((await request("providers"))[0].configured).toBe(true);
    await api.close();
    api = await startApi(root);
    expect((await request("providers"))[0].configured).toBe(true);
    await request("providers/deepseek", "DELETE");
    expect((await request("providers"))[0].configured).toBe(false);
  } finally {
    await api?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["deepseek", "opencode-go"] as const)(
  "%s key replacement takes effect at the next request within a turn",
  async (provider) => {
    let release: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = await apiFixture(async () => {
      const count = fixture.service.requests.length;
      if (count === 1) {
        await barrier;
        return {
          tools: [
            { name: "memory_read", arguments: { scope: "owner" } },
            { name: "memory_read", arguments: { scope: "bot" } },
          ],
          reasoning: "First reasoning",
        };
      }
      return { text: "Finished", reasoning: "Second reasoning" };
    });
    try {
      const bot = await fixture.request("bots", {
        name: "Reasoning",
        instructions: "",
        model: provider === "deepseek" ? "deepseek/deepseek-flash" : "opencode-go/glm-5.3",
      });
      await fixture.request(`bots/${bot.id}/send`, {
        text: "Read both memories",
        requestId: "replace",
      });
      await fixture.service.waitForRequest();
      expect(fixture.service.wire[0]?.headers.authorization).toBe(
        provider === "deepseek" ? "Bearer fixture-key" : "Bearer fixture-go-key",
      );
      await fixture.request(`providers/${provider}`, { apiKey: "replacement-key" }, "PUT");
      expect(fixture.service.requests).toHaveLength(1);
      release();
      await expect
        .poll(async () => (await fixture.request(`bots/${bot.id}/chat`)).busy)
        .toBe(false);
      expect(fixture.service.wire[1]?.headers.authorization).toBe("Bearer replacement-key");
      if (provider === "deepseek")
        expect(fixture.service.wire[0]?.body.thinking).toEqual({ type: "enabled" });
      const second = fixture.service.requests[1];
      expect(second?.messages.filter((message) => message.role === "tool")).toHaveLength(2);
      expect(
        second?.messages.find((message) => message.tool_calls?.length)?.reasoning_content,
      ).toBe("First reasoning");
      const before = await fixture.request(`bots/${bot.id}/chat`);
      await fixture.request(`providers/${provider}`, undefined, "DELETE");
      expect((await fixture.request(`bots/${bot.id}/chat`)).messages).toEqual(before.messages);
      expect(fixture.service.requests).toHaveLength(2);
    } finally {
      release();
      await fixture.close();
    }
  },
);

test.each([
  ...[
    "glm-5.3",
    "glm-5.3-flash",
    "glm-5.2",
    "kimi-k3.1-pro",
    "kimi-k3",
    "kimi-k2.7-code",
    "longcat-2.0",
    "deepseek-v4.1-flash",
    "deepseek-v4-pro",
    "mimo-v2.6-flash",
    "mimo-v2.6-pro",
    "mimo-v2.5",
    "mimo-v2.5-pro",
    "minimax-m3.1-flash",
    "hy3",
    "hy4-preview",
    "step-5-preview",
  ].map((id) => [id, "/inference/go/openai/v1/chat/completions"]),
  ...["minimax-m3", "claude-haiku-5-5", "qwen3.7-plus", "qwen3.8-flash", "qwen3.8-max"].map(
    (id) => [id, "/inference/go/anthropic/v1/messages?beta=true"],
  ),
  ...[
    "gpt-6-luna",
    "gpt-5.6-luna",
    "grok-4.7",
    "muse-spark-1.2-contributor",
    "muse-spark-1.3-contributor",
  ].map((id) => [id, "/inference/go/openai/v1/responses"]),
  [
    "gemini-4-argon",
    "/inference/go/google/v1beta/models/gemini-4-argon:streamGenerateContent?alt=sse",
  ],
])(
  "Go %s preserves tool history, client identity and session across reopen",
  async (model, path) => {
    const fixture = await apiFixture(() =>
      fixture.service.requests.length === 1
        ? {
            tools: [
              { name: "memory_read", arguments: { scope: "owner" } },
              { name: "memory_read", arguments: { scope: "bot" } },
            ],
            reasoning: "Read memories before answering",
          }
        : { text: "Protocol complete" },
    );
    try {
      const bot = await fixture.request("bots", {
        name: "Coder",
        instructions: "",
        model: `opencode-go/${model}`,
      });
      await fixture.request(`bots/${bot.id}/send`, {
        text: "Read memories",
        requestId: "protocol",
      });
      await expect
        .poll(async () => (await fixture.request(`bots/${bot.id}/chat`)).busy)
        .toBe(false);
      const view = await fixture.request(`bots/${bot.id}/chat`);
      expect(view.messages.at(-1)?.text).toBe("Protocol complete");
      expect(
        view.messages.filter((message: { role: string }) => message.role === "tool"),
      ).toHaveLength(2);
      expect(fixture.service.wire[0]?.path).toBe(path);
      const first = fixture.service.wire[0]?.headers;
      expect(first?.["user-agent"]).toBe("mybots/0.0.0");
      if (path?.includes("/google/")) expect(first?.["x-goog-api-key"]).toBe("fixture-go-key");
      else if (path?.includes("/anthropic/")) expect(first?.["x-api-key"]).toBe("fixture-go-key");
      else expect(first?.authorization).toBe("Bearer fixture-go-key");
      expect(first?.["x-opencode-session"]).toEqual(expect.any(String));
      expect(fixture.service.wire[1]?.headers["x-opencode-session"]).toBe(
        first?.["x-opencode-session"],
      );
      await fixture.reopen();
      await fixture.request(`bots/${bot.id}/send`, {
        text: "Continue",
        requestId: "reopened-protocol",
      });
      await expect
        .poll(async () => (await fixture.request(`bots/${bot.id}/chat`)).busy)
        .toBe(false);
      expect(fixture.service.wire[2]?.headers["x-opencode-session"]).toBe(
        first?.["x-opencode-session"],
      );
    } finally {
      await fixture.close();
    }
  },
);

test.each(["deepseek", "opencode-go"] as const)(
  "removing %s while a request is issued blocks its next tool follow-up",
  async (provider) => {
    let release: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = await apiFixture(async () => {
      await barrier;
      return { tool: "memory_read", arguments: { scope: "owner" }, reasoning: "Before removal" };
    });
    try {
      const bot = await fixture.request("bots", {
        name: "Removal",
        instructions: "",
        model: provider === "deepseek" ? "deepseek/deepseek-flash" : "opencode-go/glm-5.3",
      });
      await fixture.request(`bots/${bot.id}/send`, {
        text: "Read memory",
        requestId: "remove-in-flight",
      });
      await fixture.service.waitForRequest();
      await fixture.request(`providers/${provider}`, undefined, "DELETE");
      release();
      await expect
        .poll(async () => (await fixture.request(`bots/${bot.id}/chat`)).busy)
        .toBe(false);
      const view = await fixture.request(`bots/${bot.id}/chat`);
      expect(
        view.messages.filter((message: { role: string }) => message.role === "tool"),
      ).toHaveLength(1);
      expect(view.inputs[0]?.detail).toContain("API key in Provider settings");
      expect(fixture.service.requests).toHaveLength(1);
    } finally {
      release();
      await fixture.close();
    }
  },
);

test.each([401, 403, 404])(
  "provider error %s stays actionable without saving echoed credentials",
  async (status) => {
    const fixture = await apiFixture(() => ({
      status,
      error: `Rejected fixture-key and private account details`,
    }));
    try {
      const bot = await fixture.request("bots", {
        name: "Failure",
        instructions: "",
        model: "deepseek/deepseek-flash",
      });
      await fixture.request(`bots/${bot.id}/send`, {
        text: "Check access",
        requestId: "access-failure",
      });
      await expect
        .poll(async () => (await fixture.request(`bots/${bot.id}/chat`)).busy)
        .toBe(false);
      const view = await fixture.request(`bots/${bot.id}/chat`);
      expect(view.inputs[0]?.detail).toContain(
        status === 401 ? "authentication" : status === 403 ? "subscription" : "model unavailable",
      );
      expect(JSON.stringify(view)).not.toMatch(/fixture-key|private account/);
      await fixture.reopen();
      expect(JSON.stringify(await fixture.request(`bots/${bot.id}/chat`))).not.toMatch(
        /fixture-key|private account/,
      );
      expect(fixture.service.requests).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  },
);

test("DeepSeek Pro preserves reasoning across multiple tools", async () => {
  const fixture = await apiFixture(() =>
    fixture.service.requests.length === 1
      ? {
          tools: [
            { name: "memory_read", arguments: { scope: "owner" } },
            { name: "memory_read", arguments: { scope: "bot" } },
          ],
          reasoning: "Pro reasoning",
        }
      : { text: "Pro complete" },
  );
  try {
    const bot = await fixture.request("bots", {
      name: "Pro",
      instructions: "",
      model: "deepseek/deepseek-v4-pro",
    });
    await fixture.request(`bots/${bot.id}/send`, { text: "Read memories", requestId: "pro" });
    await expect.poll(async () => (await fixture.request(`bots/${bot.id}/chat`)).busy).toBe(false);
    expect((await fixture.request(`bots/${bot.id}/chat`)).messages.at(-1)?.text).toBe(
      "Pro complete",
    );
    expect(
      fixture.service.requests[1]?.messages.find((message) => message.tool_calls?.length)
        ?.reasoning_content,
    ).toBe("Pro reasoning");
  } finally {
    await fixture.close();
  }
});
