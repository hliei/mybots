import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Agent } from "../src/core/agent.ts";
import { chatFixture, toolReply } from "./chat-fixture.ts";

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

const builtinToolNames = ["read", "write", "edit", "bash"];

it("registers the reference skill tool from discovered Skill metadata", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace(fixture.root, "", "allow_skills: true\n");
  await fixture.writeSkill("weather", weatherSkill, workspace);
  const agent = await Agent.open({ workspace });
  await agent.chat("Hi");
  expect(fixture.requests[0].tools.map((tool) => tool.function.name)).toEqual([
    ...builtinToolNames,
    "skill",
  ]);
  expect(fixture.requests[0].tools.at(-1)).toEqual({
    type: "function",
    function: {
      name: "skill",
      description:
        'Load and invoke a specialized skill. <skills>\n  <skill name="Weather">Look up the weather</skill>\n</skills>',
      parameters: {
        type: "object",
        properties: {
          skill_name: {
            type: "string",
            description: "The name of the skill to load",
            enum: ["weather"],
          },
        },
        required: ["skill_name"],
      },
    },
  });
});

it("loads a Skill body without frontmatter as the matching tool result", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace(fixture.root, "", "allow_skills: true\n");
  await fixture.writeSkill("weather", weatherSkill, workspace);
  const agent = await Agent.open({ workspace });
  fixture.responses.push({
    status: 200,
    body: toolReply(
      [{ name: "skill", id: "skill-1", args: { skill_name: "weather" } }],
      "Load the weather skill.",
    ),
  });
  expect(await agent.chat("How is the weather?")).toBe("Hello!");
  expect(fixture.requests[1].messages).toEqual([
    { role: "system", content: "Give concise answers." },
    { role: "user", content: "How is the weather?" },
    {
      role: "assistant",
      content: "",
      reasoning_content: "Load the weather skill.",
      tool_calls: [
        {
          id: "skill-1",
          type: "function",
          function: { name: "skill", arguments: JSON.stringify({ skill_name: "weather" }) },
        },
      ],
    },
    { role: "tool", tool_call_id: "skill-1", content: "Always mention the temperature unit." },
  ]);
});

it("registers only valid Skills and excludes invalid definitions", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace(fixture.root, "", "allow_skills: true\n");
  await fixture.writeSkill("weather", weatherSkill, workspace);
  await fixture.writeSkill("nameless", "---\ndescription: Missing a name\n---\nBody\n", workspace);
  await fixture.writeSkill("nodesc", "---\nname: Missing a description\n---\nBody\n", workspace);
  await fixture.writeSkill("plain", "Instructions without frontmatter.\n", workspace);
  await fixture.writeSkill(
    "wrongtype",
    "---\nname: 42\ndescription: Not a string name\n---\nBody\n",
    workspace,
  );
  await mkdir(join(workspace, ".agents", "skills", "empty"), { recursive: true });
  await writeFile(join(workspace, ".agents", "skills", "stray.txt"), "Not a Skill directory");
  const agent = await Agent.open({ workspace });
  await agent.chat("Hi");
  const tool = fixture.requests[0].tools.at(-1);
  expect(tool?.function.name).toBe("skill");
  expect(tool?.function.description).toBe(
    'Load and invoke a specialized skill. <skills>\n  <skill name="Weather">Look up the weather</skill>\n</skills>',
  );
  expect(tool?.function.parameters.properties.skill_name.enum).toEqual(["weather"]);
});

it("does not register the skill tool when the Agent disallows Skills", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace();
  await fixture.writeSkill("weather", weatherSkill, workspace);
  const agent = await Agent.open({ workspace });
  await agent.chat("Hi");
  expect(fixture.requests[0].tools.map((tool) => tool.function.name)).toEqual(builtinToolNames);
});

it.each(["empty", "missing"])(
  "does not register the skill tool when the configured Skills collection is %s",
  async (kind) => {
    fixture = await chatFixture();
    const workspace = await fixture.workspace(fixture.root, "", "allow_skills: true\n");
    if (kind === "empty") await mkdir(join(workspace, ".agents", "skills"), { recursive: true });
    const agent = await Agent.open({ workspace });
    await agent.chat("Hi");
    expect(fixture.requests[0].tools.map((tool) => tool.function.name)).toEqual(builtinToolNames);
  },
);

it("returns the reference error when the model requests an unavailable Skill", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace(fixture.root, "", "allow_skills: true\n");
  await fixture.writeSkill("weather", weatherSkill, workspace);
  const agent = await Agent.open({ workspace });
  fixture.responses.push({
    status: 200,
    body: toolReply([{ name: "skill", id: "skill-missing", args: { skill_name: "missing" } }]),
  });
  await agent.chat("Load the missing skill");
  expect(fixture.requests[1].messages.at(-1)).toEqual({
    role: "tool",
    tool_call_id: "skill-missing",
    content: "Error: Skill 'missing' not found. It may have been removed or is unavailable.",
  });
});

it("treats a path outside the discovered Skill IDs as unavailable", async () => {
  fixture = await chatFixture();
  const workspace = await fixture.workspace(fixture.root, "", "allow_skills: true\n");
  await fixture.writeSkill("weather", weatherSkill, workspace);
  await mkdir(join(workspace, "outside"), { recursive: true });
  await writeFile(join(workspace, "outside", "SKILL.md"), weatherSkill);
  const agent = await Agent.open({ workspace });
  fixture.responses.push({
    status: 200,
    body: toolReply([{ name: "skill", id: "skill-outside", args: { skill_name: "../outside" } }]),
  });
  await agent.chat("Load a path outside the Skills directory");
  expect(fixture.requests[1].messages.at(-1)).toEqual({
    role: "tool",
    tool_call_id: "skill-outside",
    content: "Error: Skill '../outside' not found. It may have been removed or is unavailable.",
  });
});

it.each([true, false])(
  "retains reasoning while loading a Skill and continuing with a local tool (thinking %s)",
  async (thinking) => {
    fixture = await chatFixture();
    const workspace = await fixture.workspace(
      fixture.root,
      `  thinking: ${thinking}\n`,
      "allow_skills: true\n",
    );
    await fixture.writeSkill("weather", weatherSkill, workspace);
    const note = join(fixture.root, "note.txt");
    await writeFile(note, "Note text");
    const agent = await Agent.open({ workspace });
    fixture.responses.push(
      {
        status: 200,
        body: toolReply(
          [{ name: "skill", id: "load", args: { skill_name: "weather" } }],
          "Load the skill first.",
        ),
      },
      {
        status: 200,
        body: toolReply([{ name: "read", id: "read", args: { path: note } }], "Read the note."),
      },
    );
    await agent.chat("Load the skill and read the note");
    expect(fixture.requests[1].messages.at(-1)).toMatchObject({
      tool_call_id: "load",
      content: "Always mention the temperature unit.",
    });
    expect(
      fixture.requests[2].messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.reasoning_content),
    ).toEqual(["Load the skill first.", "Read the note."]);
    expect(fixture.requests[2].messages.at(-1)).toMatchObject({
      tool_call_id: "read",
      content: "Note text",
    });
    expect(
      fixture.requests.every(
        (request) => request.thinking.type === (thinking ? "enabled" : "disabled"),
      ),
    ).toBe(true);
  },
);
