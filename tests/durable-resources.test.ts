import type { Bot, ChatView } from "@mybots/contracts";
import { expect, test } from "vitest";
import { apiFixture } from "./durable-api-fixture.ts";

test("shared user Skills survive reopen and load full instructions only on demand", async () => {
  let read = false;
  const fixture = await apiFixture(() => {
    if (!read) {
      read = true;
      return { tool: "skill_read", arguments: { name: "writing" } };
    }
    return { text: "Skill loaded" };
  });
  try {
    const skill = {
      name: "writing",
      description: "Writing guidance",
      content: "USE_SHORT_SENTENCES",
    };
    await fixture.request("skills/writing", skill, "PUT");
    await fixture.reopen();
    expect(await fixture.request("skills/writing")).toMatchObject(skill);
    const bot = await fixture.request("bots", {
      name: "Writer",
      instructions: "",
      model: "deepseek/deepseek-flash",
    });
    await fixture.request(`bots/${bot.id}/send`, { text: "Use writing", requestId: "skill-read" });
    await settled(fixture, bot);
    const first = JSON.stringify(fixture.service.requests[0]?.messages);
    expect(first).toContain("Writing guidance");
    expect(first).not.toContain("USE_SHORT_SENTENCES");
    expect(JSON.stringify(fixture.service.requests[1]?.messages)).toContain("USE_SHORT_SENTENCES");
    await fixture.request("skills/writing", { ...skill, content: "Updated guidance" }, "PUT");
    expect(await fixture.request("skills/writing")).toMatchObject({ content: "Updated guidance" });
    await fixture.request("skills/writing", undefined, "DELETE");
    expect(
      (await fixture.request("skills")).skills.some(
        (item: { name: string }) => item.name === "writing",
      ),
    ).toBe(false);
  } finally {
    await fixture.close();
  }
});

test("owner and Agent memory edits reach later requests with Bot scope preserved across restart", async () => {
  let maintain = false;
  let round = 0;
  const fixture = await apiFixture(() => {
    if (maintain && round++ === 0)
      return {
        tools: [
          { name: "memory_read", arguments: { scope: "bot" } },
          { name: "memory_write", arguments: { scope: "bot", content: "AGENT_PRIVATE" } },
          { name: "memory_write", arguments: { scope: "owner", content: "AGENT_SHARED" } },
          {
            name: "skill_write",
            arguments: {
              name: "agent-guide",
              description: "Agent guide",
              content: "Agent instructions",
            },
          },
        ],
      };
    return { text: "Saved" };
  });
  try {
    const first = (await fixture.request("bots", {
      name: "First",
      instructions: "Keep role",
      model: "deepseek/deepseek-flash",
    })) as Bot;
    const second = (await fixture.request("bots", {
      name: "Second",
      instructions: "",
      model: "deepseek/deepseek-flash",
    })) as Bot;
    await fixture.request("memory/owner", { content: "OWNER_PREFERENCE" }, "PUT");
    await fixture.request(`bots/${first.id}/memory`, { content: "FIRST_PRIVATE" }, "PUT");
    await fixture.request(`bots/${second.id}/memory`, { content: "SECOND_PRIVATE" }, "PUT");
    await fixture.request(`bots/${first.id}/send`, {
      text: "Inspect context",
      requestId: "memory-owner",
    });
    await settled(fixture, first);
    const initial = JSON.stringify(fixture.service.requests.at(-1)?.messages);
    expect(initial).toContain("OWNER_PREFERENCE");
    expect(initial).toContain("FIRST_PRIVATE");
    expect(initial).toContain("Keep role");
    expect(initial).not.toContain("SECOND_PRIVATE");
    maintain = true;
    await fixture.request(`bots/${first.id}/send`, {
      text: "Maintain resources",
      requestId: "memory-agent",
    });
    const maintained = await settled(fixture, first);
    expect(maintained.messages.flatMap((message) => message.tools)).toContain("memory_write");
    expect(await fixture.request(`bots/${first.id}/memory`)).toEqual({ content: "AGENT_PRIVATE" });
    expect(await fixture.request("memory/owner")).toEqual({ content: "AGENT_SHARED" });
    expect(await fixture.request("skills/agent-guide")).toMatchObject({
      content: "Agent instructions",
      readOnly: false,
    });
    expect(JSON.stringify(fixture.service.requests.at(-1)?.messages[0])).toContain("AGENT_PRIVATE");
    await fixture.reopen();
    await fixture.request(`bots/${second.id}/send`, {
      text: "Check shared records",
      requestId: "memory-second",
    });
    await settled(fixture, second);
    const other = JSON.stringify(fixture.service.requests.at(-1)?.messages);
    expect(other).toContain("AGENT_SHARED");
    expect(other).toContain("SECOND_PRIVATE");
    expect(other).toContain("Agent guide");
    expect(other).not.toContain("AGENT_PRIVATE");
    expect(await fixture.request(`bots/${first.id}/memory`)).toEqual({ content: "AGENT_PRIVATE" });
    await fixture.request(`bots/${first.id}/memory`, undefined, "DELETE");
    await fixture.request("memory/owner", undefined, "DELETE");
    expect(await fixture.request(`bots/${first.id}/memory`)).toEqual({ content: "" });
    await fixture.request(`bots/${first.id}/send`, {
      text: "After removal",
      requestId: "memory-removed",
    });
    const after = await settled(fixture, first);
    const system = JSON.stringify(fixture.service.requests.at(-1)?.messages[0]);
    expect(system).not.toContain("AGENT_PRIVATE");
    expect(system).not.toContain("AGENT_SHARED");
    expect(after.messages).toEqual(expect.arrayContaining(maintained.messages));
  } finally {
    await fixture.close();
  }
});

test("resource edits leave an in-flight request unchanged and affect its next model boundary", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  const fixture = await apiFixture(async () => {
    if (first) {
      first = false;
      await held;
      return { tool: "memory_read", arguments: { scope: "owner" } };
    }
    return { text: "Updated context" };
  });
  try {
    const bot = await fixture.request("bots", {
      name: "Working",
      instructions: "",
      model: "deepseek/deepseek-flash",
    });
    await fixture.request("memory/owner", { content: "BEFORE_EDIT" }, "PUT");
    await fixture.request("skills/shared", { description: "OLD_CATALOG", content: "old" }, "PUT");
    await fixture.request(`bots/${bot.id}/send`, { text: "Start", requestId: "in-flight" });
    await fixture.service.waitForRequest();
    await fixture.request("memory/owner", { content: "AFTER_EDIT" }, "PUT");
    await fixture.request("skills/shared", { description: "NEW_CATALOG", content: "new" }, "PUT");
    const inFlight = JSON.stringify(fixture.service.requests[0]?.messages);
    expect(inFlight).toContain("BEFORE_EDIT");
    expect(inFlight).toContain("OLD_CATALOG");
    expect(inFlight).not.toContain("AFTER_EDIT");
    release();
    await settled(fixture, bot);
    const next = JSON.stringify(fixture.service.requests[1]?.messages);
    expect(next).toContain("AFTER_EDIT");
    expect(next).toContain("NEW_CATALOG");
    expect(next).not.toContain("BEFORE_EDIT");
  } finally {
    release();
    await fixture.close();
  }
});

test("public edits reject invalid resources and both owner and Agent cannot change built-ins", async () => {
  let first = true;
  const fixture = await apiFixture(() => {
    if (first) {
      first = false;
      return {
        tools: [
          {
            name: "skill_write",
            arguments: {
              name: "resource-maintenance",
              description: "Override",
              content: "changed",
            },
          },
          { name: "skill_delete", arguments: { name: "resource-maintenance" } },
          { name: "memory_write", arguments: { scope: "another-bot", content: "invalid" } },
        ],
      };
    }
    return { text: "Rejected" };
  });
  try {
    const builtIn = await fixture.request("skills/resource-maintenance");
    expect(builtIn.readOnly).toBe(true);
    const invalid = [
      ["skills/resource-maintenance", "PUT", { description: "override", content: "changed" }],
      ["skills/resource-maintenance", "DELETE", undefined],
      ["skills/invalid", "PUT", { description: "", content: "empty description" }],
      ["skills/invalid", "PUT", { description: "Large", content: "x".repeat(16001) }],
      ["memory/owner", "PUT", { content: 123 }],
      ["bots/missing/memory", "PUT", { content: "private" }],
    ] as const;
    for (const [path, method, body] of invalid) {
      const response = await fetch(new URL(`api/${path}`, fixture.url), {
        method,
        headers: {
          Authorization: `Bearer ${fixture.credential}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    const bot = await fixture.request("bots", {
      name: "Maintainer",
      instructions: "",
      model: "deepseek/deepseek-flash",
    });
    await fixture.request(`bots/${bot.id}/send`, {
      text: "Try invalid edits",
      requestId: "invalid-resource",
    });
    const view = await settled(fixture, bot);
    expect(
      view.messages.filter(
        (message) => message.role === "tool" && message.text.includes("read-only"),
      ),
    ).toHaveLength(2);
    expect(await fixture.request("skills/resource-maintenance")).toEqual(builtIn);
    expect(await fixture.request("memory/owner")).toEqual({ content: "" });
  } finally {
    await fixture.close();
  }
});

test("Agent tools update and remove user Skills and current Bot memory without touching another Bot", async () => {
  const calls = [
    {
      tool: "skill_write",
      arguments: {
        name: "temporary",
        description: "Temporary instructions",
        content: "First draft",
      },
    },
    {
      tool: "skill_write",
      arguments: { name: "temporary", description: "Revised instructions", content: "Final draft" },
    },
    { tool: "skill_read", arguments: { name: "temporary" } },
    { tool: "memory_write", arguments: { scope: "bot", content: "Temporary retained fact" } },
    { tool: "memory_read", arguments: { scope: "bot" } },
    { tool: "memory_delete", arguments: { scope: "bot" } },
    { tool: "skill_delete", arguments: { name: "temporary" } },
  ];
  const fixture = await apiFixture(() => calls.shift() ?? { text: "Maintenance complete" });
  try {
    const bot = await fixture.request("bots", {
      name: "Maintainer",
      instructions: "",
      model: "deepseek/deepseek-flash",
    });
    const other = await fixture.request("bots", {
      name: "Other",
      instructions: "",
      model: "deepseek/deepseek-flash",
    });
    await fixture.request(`bots/${other.id}/memory`, { content: "Other private fact" }, "PUT");
    await fixture.request("memory/owner", { content: "Owner retained fact" }, "PUT");
    await fixture.request(`bots/${bot.id}/send`, {
      text: "Maintain resources",
      requestId: "maintenance",
    });
    const view = await settled(fixture, bot);
    const results = view.messages.filter((message) => message.role === "tool");
    expect(results).toHaveLength(7);
    expect(results.map((message) => message.text).join("\n")).toContain("Final draft");
    expect(results.map((message) => message.text).join("\n")).toContain("Temporary retained fact");
    expect(view.messages.at(-1)?.text).toBe("Maintenance complete");
    expect(await fixture.request(`bots/${bot.id}/memory`)).toEqual({ content: "" });
    expect(await fixture.request(`bots/${other.id}/memory`)).toEqual({
      content: "Other private fact",
    });
    expect(await fixture.request("memory/owner")).toEqual({ content: "Owner retained fact" });
    expect(
      (await fixture.request("skills")).skills.some(
        (skill: { name: string }) => skill.name === "temporary",
      ),
    ).toBe(false);
    await fixture.reopen();
    expect(await fixture.request(`bots/${bot.id}/memory`)).toEqual({ content: "" });
    expect(
      (await fixture.request("skills")).skills.some(
        (skill: { name: string }) => skill.name === "temporary",
      ),
    ).toBe(false);
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
