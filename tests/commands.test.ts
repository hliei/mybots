import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ConversationHistory } from "../src/core/history.ts";
import { chatFixture } from "./chat-fixture.ts";

let fixture: Awaited<ReturnType<typeof chatFixture>> | undefined;
afterEach(async () => {
  const current = fixture;
  fixture = undefined;
  await current?.close();
});

const weatherSkill = `---
name: Weather
description: Look up the weather
---

Always mention the temperature unit.
`;

// Literal expected command output, independent of the command registry.
const helpText = [
  "**Available Commands:**",
  "/help, /? - Show available commands",
  "/skills - List all skills or show skill details",
  "/session - Show current session details",
  "/context - Show active context and token budget",
  "/compact - Summarize older active context",
].join("\n");

it("lists available commands through /help and its aliases regardless of case", async () => {
  fixture = await chatFixture();
  const agent = await fixture.openAgent({ workspace: await fixture.workspace() });
  expect(await agent.runCommand("/help")).toBe(helpText);
  expect(await agent.runCommand("/?")).toBe(helpText);
  expect(await agent.runCommand("/HELP")).toBe(helpText);
});

it("leaves unknown slash input, a lone slash, and ordinary input to chat", async () => {
  fixture = await chatFixture();
  const agent = await fixture.openAgent({ workspace: await fixture.workspace() });
  expect(await agent.runCommand("/unknown")).toBeUndefined();
  expect(await agent.runCommand("/")).toBeUndefined();
  expect(await agent.runCommand("//")).toBeUndefined();
  expect(await agent.runCommand("hello")).toBeUndefined();
});

it("reports the current session without creating or switching sessions", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  const agent = await fixture.openAgent({ workspace });
  const sessionId = agent.sessionId;
  const created = await agent.runCommand("/session");
  expect(created).toContain(`**Session ID:** \`${sessionId}\``);
  expect(created).toContain("**Agent:** Helper (`helper`)");
  expect(created).toMatch(/\*\*Created:\*\* \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  expect(created).toContain("**Messages:** 0");

  await agent.chat("Hello");
  // The message count excludes the system prompt.
  expect(await agent.runCommand("/session")).toContain("**Messages:** 2");
  expect(agent.sessionId).toBe(sessionId);
  const history = await ConversationHistory.open(join(workspace, ".history"));
  expect(await history.listSessions()).toHaveLength(1);
});

it("lists discovered Skill IDs and descriptions and reports an empty collection", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  await fixture.writeSkill("weather", weatherSkill, workspace);
  const agent = await fixture.openAgent({ workspace });
  expect(await agent.runCommand("/skills")).toBe("**Skills:**\n- `weather`: Look up the weather");

  const empty = await fixture.openAgent({
    workspace: await fixture.workspace(join(fixture.root, "empty")),
  });
  expect(await empty.runCommand("/skills")).toBe("No skills configured.");
});

it("shows one Skill's instructions and a not-found error for an unknown ID", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  await fixture.writeSkill("weather", weatherSkill, workspace);
  const agent = await fixture.openAgent({ workspace });
  expect(await agent.runCommand("/skills weather")).toBe(
    "**Skill:** `weather`\n" +
      "**Name:** Weather\n" +
      "**Description:** Look up the weather\n\n" +
      "---\n\n" +
      "**SKILL.md:**\n```\nAlways mention the temperature unit.\n```",
  );
  expect(await agent.runCommand("/SKILLS weather")).toContain(
    "Always mention the temperature unit.",
  );
  expect(await agent.runCommand("/skills missing")).toBe("✗ Skill `missing` not found.");
});

it("inspects Skills without loading them into context or recording messages", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace(fixture.root, "", "allow_skills: true\n");
  await fixture.writeSkill("weather", weatherSkill, workspace);
  const agent = await fixture.openAgent({ workspace });
  await agent.runCommand("/help");
  await agent.runCommand("/session");
  await agent.runCommand("/skills weather");
  expect(await agent.runCommand("/session")).toContain("**Messages:** 0");
  expect(fixture.requests).toHaveLength(0);
  const history = await ConversationHistory.open(join(workspace, ".history"));
  expect(await history.getMessages(agent.sessionId)).toEqual([]);

  await agent.chat("Hi");
  expect(fixture.requests[0].messages).toEqual([
    { role: "system", content: "Give concise answers." },
    { role: "user", content: "Hi" },
  ]);
});
