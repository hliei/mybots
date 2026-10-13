import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { Agent } from "../src/core/agent.ts";
import { chatFixture, toolReply } from "./chat-fixture.ts";

it("exchanges reference Workspace, Agent, and Skill contracts through the Agent", async () => {
  const fixture = await chatFixture();
  const workspace = await mkdtemp(join(tmpdir(), "mybots-reference-"));
  try {
    await cp(fileURLToPath(new URL("./fixtures/reference/workspace", import.meta.url)), workspace, {
      recursive: true,
    });
    const agent = await Agent.open({ workspace });
    expect(agent.config).toMatchObject({
      default_agent: "helper",
      agents_path: join(workspace, "agents"),
      skills_path: join(workspace, "skills"),
      history_path: join(workspace, ".history"),
      llm: {
        provider: "deepseek",
        model: "reference-model",
        api_key: "fixture-key-not-a-credential",
        api_base: "https://example.invalid/v1",
        temperature: 0.4,
        max_tokens: 1024,
        thinking: true,
      },
    });
    expect(agent.definition).toMatchObject({
      id: "helper",
      name: "Reference helper",
      description: "Contract acceptance helper",
      agent_md: "Follow the loaded Skill and answer concisely.",
      allow_skills: true,
      llm: { model: "reference-override", temperature: 0.2, max_tokens: 3072 },
    });
    expect(await agent.runCommand("/skills brief")).toContain(
      "Answer in one sentence and retain the requested fact.",
    );
    // Replace only transport fields; the shared reference fields remain literal fixtures.
    await writeFile(
      join(workspace, "config.user.yaml"),
      `llm:\n  provider: deepseek\n  model: reference-model\n  api_key: fixture-key-not-a-credential\n  api_base: ${fixture.endpoint}\n  temperature: 0.4\n  max_tokens: 1024\ndefault_agent: helper\nagents_path: agents\nskills_path: skills\nhistory_path: .history\n`,
    );
    fixture.responses.push({
      status: 200,
      body: toolReply([{ name: "skill", id: "reference-skill", args: { skill_name: "brief" } }]),
    });
    const connected = await Agent.open({ workspace });
    expect(await connected.chat("Load brief")).toBe("Hello!");
    expect(fixture.requests[1].messages.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "reference-skill",
      content: "Answer in one sentence and retain the requested fact.",
    });
    expect(fixture.requests[0]).toMatchObject({
      model: "reference-override",
      temperature: 0.2,
      max_tokens: 3072,
      thinking: { type: "enabled" },
    });
  } finally {
    await fixture.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
