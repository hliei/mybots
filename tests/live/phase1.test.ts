import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { stringify } from "yaml";
import { loadSettings } from "../../src/config/workspace.ts";
import { Agent } from "../../src/core/agent.ts";
import { ConversationHistory } from "../../src/core/history.ts";

let root: string;
let agent: Agent;
let signal: AbortSignal;

beforeEach(async () => {
  const workspace = resolve(process.env.MYBOTS_ACCEPTANCE_WORKSPACE ?? "workspace");
  const { config, definition } = await loadSettings(workspace);
  root = await mkdtemp(join(tmpdir(), "mybots-live-"));
  await mkdir(join(root, ".agents/bots/acceptance"), { recursive: true });
  await mkdir(join(root, ".agents/skills/acceptance"), { recursive: true });
  await writeFile(
    join(root, "config.user.yaml"),
    stringify({
      default_agent: "acceptance",
      llm: { ...definition.llm, thinking: true, max_tokens: 8192, context_window: 100_000 },
      ...(config.web_search ? { web_search: config.web_search } : {}),
      fetch_content: {},
    }),
    { mode: 0o600 },
  );
  await writeFile(
    join(root, ".agents/bots/acceptance/AGENT.md"),
    "---\nname: Acceptance\nallow_skills: true\n---\n\nFollow the user's acceptance steps exactly. Use only the requested tools, paths and shell command. Keep final answers short. Never read configuration or credentials.\n",
  );
  await writeFile(
    join(root, ".agents/skills/acceptance/SKILL.md"),
    "---\nname: Acceptance Skill\ndescription: Supply the acceptance marker\n---\n\nInclude SKILL_CONFIRMED in your final reply.\n",
  );
  signal = AbortSignal.timeout(240_000);
  agent = await Agent.open({ workspace: root });
  console.log(`Live configuration: model=${agent.definition.llm.model}; thinking=enabled`);
});

afterEach(async () => {
  await agent?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

async function recorded() {
  const history = await ConversationHistory.open(join(root, ".history"));
  const messages = await history.getMessages(agent.sessionId);
  expect((await history.getSession(agent.sessionId))?.message_count).toBe(messages.length);
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      expect(call.type).toBe("function");
      expect(typeof call.function.arguments).toBe("string");
      expect(messages.filter((result) => result.tool_call_id === call.id)).toHaveLength(1);
      expect(typeof message.reasoning_content).toBe("string");
    }
  }
  // Compare a fresh reader with the raw persisted values, without printing reasoning.
  const raw = (await readFile(join(root, ".history/sessions", `${agent.sessionId}.jsonl`), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(messages).toEqual(raw);
  console.log(
    `History evidence: ${messages.length} messages; reasoning lengths=${messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.reasoning_content?.length ?? "absent")
      .join(",")}`,
  );
  return messages;
}

async function exchanges(name: string) {
  const messages = await recorded();
  return messages.flatMap((message) =>
    (message.tool_calls ?? [])
      .filter((call) => call.function.name === name)
      .map((call) => ({
        arguments: JSON.parse(call.function.arguments),
        content: messages.find((result) => result.tool_call_id === call.id)?.content ?? "",
      })),
  );
}

it("continues a real thinking conversation through Skills and local tools", async () => {
  const marker = `FACT_${randomUUID()}`;
  expect(await agent.chat(`Remember ${marker}. Reply ACK only.`, signal)).toContain("ACK");
  const path = join(root, "note.txt");
  const answer = await agent.chat(
    `Load Skill ID acceptance. Then write OLD to ${path}, edit OLD to NEW in that file, read it, and run exactly this bash command: printf SHELL_CONFIRMED. Report the remembered fact, the file content, shell output and Skill marker. Execute those dependent steps in order.`,
    signal,
  );
  for (const value of [marker, "NEW", "SHELL_CONFIRMED", "SKILL_CONFIRMED"])
    expect(answer).toContain(value);
  expect(await readFile(path, "utf8")).toBe("NEW");
  expect(await exchanges("skill")).toContainEqual({
    arguments: { skill_name: "acceptance" },
    content: "Include SKILL_CONFIRMED in your final reply.",
  });
  expect(await exchanges("write")).toContainEqual({
    arguments: { path, content: "OLD" },
    content: `Successfully wrote to: ${path}`,
  });
  expect(await exchanges("edit")).toContainEqual({
    arguments: { path, old_text: "OLD", new_text: "NEW" },
    content: `Successfully edited ${path}`,
  });
  expect(await exchanges("read")).toContainEqual({ arguments: { path }, content: "NEW" });
  expect(await exchanges("bash")).toContainEqual({
    arguments: { command: "printf SHELL_CONFIRMED" },
    content: "SHELL_CONFIRMED",
  });
  const order = (await recorded()).flatMap((message) =>
    (message.tool_calls ?? []).map((call) => call.function.name),
  );
  expect(order.indexOf("write")).toBeLessThan(order.indexOf("edit"));
  expect(order.indexOf("edit")).toBeLessThan(order.indexOf("read"));
  expect((await recorded()).some((message) => (message.reasoning_content?.length ?? 0) > 0)).toBe(
    true,
  );
  console.log(
    "PASS: multi-turn fact recall; five tools; paired results; saved original reasoning.",
  );
});

it("searches the explicitly configured real provider through the Agent", async () => {
  if (!agent.config.web_search)
    throw new Error(
      "Live search incomplete: configure web_search.provider and api_key in the source Workspace.",
    );
  const provider = agent.config.web_search.provider;
  console.log(`Live search provider: ${provider}; other adapters are not covered by this run.`);
  const answer = await agent.chat(
    'Use web_search with query "RFC 9110 HTTP semantics rfc-editor", numResults 2. Report one returned source URL. Do not fetch content in this step.',
    signal,
  );
  const calls = await exchanges("web_search");
  expect(calls.length).toBeGreaterThan(0);
  const items = calls.flatMap((call) => JSON.parse(call.content).queries);
  expect(items.length).toBeGreaterThan(0);
  for (const item of items) {
    expect(item.provider).toBe(provider);
    expect(item.error).toBeNull();
    expect(item.results.length).toBeGreaterThan(0);
    expect(item.results.length).toBeLessThanOrEqual(2);
    expect(item.results.some((source: { url: string }) => answer.includes(source.url))).toBe(true);
  }
  const source = items
    .flatMap((item) => item.results)
    .find((result: { url: string }) => new URL(result.url).hostname === "httpwg.org");
  expect(source).toBeDefined();
  const sourceUrl = source.url;
  console.log(`Live source fetching: ${sourceUrl}`);
  expect(
    (
      await agent.chat(
        `Fetch ${sourceUrl} using fetch_content with limit 800. Describe the fetched text briefly.`,
        signal,
      )
    ).trim().length,
  ).toBeGreaterThan(0);
  const fetched = (await exchanges("fetch_content")).flatMap(
    (call) => JSON.parse(call.content).urls,
  );
  const page = fetched.find((item: { url: string }) => item.url === sourceUrl);
  expect(page).toBeDefined();
  expect(page.error).toBeNull();
  expect(page.content.trim().length).toBeGreaterThan(0);
  console.log(
    `PASS: ${provider} search → fetched source → model continuation; saved tool exchanges.`,
  );
});

it("fetches real HTTP text and continues its bounded content through the Agent", async () => {
  const url = "https://www.rfc-editor.org/rfc/rfc9110.txt";
  const answer = await agent.chat(
    `Use fetch_content for ${url} with limit 400 and offset 0. Report the document subject and nextOffset.`,
    signal,
  );
  expect(answer).toMatch(/HTTP/i);
  const first = (await exchanges("fetch_content"))[0];
  expect(first).toBeDefined();
  const page = JSON.parse(first.content).urls[0];
  expect(page.error).toBeNull();
  expect(page.url).toBe(url);
  expect(page.finalUrl).toMatch(/^https:\/\//);
  expect(page.content).toMatch(/Request for Comments: 9110/);
  expect(Array.from(page.content).length).toBe(400);
  expect(page.nextOffset).toBe(400);
  expect(page.totalChars).toBeGreaterThan(800);
  const continuation = await agent.chat(
    "Use fetch_content on the same URL with limit 400 and offset equal to the previous nextOffset. Report nextOffset and a short phrase from the new chunk.",
    signal,
  );
  expect(continuation.trim().length).toBeGreaterThan(0);
  const next = (await exchanges("fetch_content")).find((call) => call.arguments.offset === 400);
  expect(next).toBeDefined();
  const chunk = JSON.parse(next?.content ?? "{}").urls[0];
  expect(chunk.error).toBeNull();
  expect(chunk.nextOffset).toBe(800);
  expect(chunk.totalChars).toBe(page.totalChars);
  expect(chunk.content).not.toBe(page.content);
  expect(Array.from(chunk.content).length).toBe(400);
  expect(page.content + chunk.content).toMatch(/HTTP Semantics/);
  console.log(
    "PASS: real HTTP readable text; two 400-character chunks; continuation; paired history.",
  );
});

it("compacts with a real summary, preserves original history and continues", async () => {
  const marker = `COMPACTION_${randomUUID()}`;
  const background =
    "Background archive entry: routine work completed with no outstanding tasks.\n".repeat(600);
  for (let turn = 0; turn < 3; turn++) {
    const fact =
      turn === 0 ? `The critical fact is ${marker}. Preserve it for later recall.\n` : "";
    expect(
      await agent.chat(`${fact}${background}\nArchive batch ${turn}. Reply ACK only.`, signal),
    ).toContain("ACK");
  }
  const log = join(root, ".history/sessions", `${agent.sessionId}.jsonl`);
  const index = join(root, ".history/index.jsonl");
  const before = await readFile(log, "utf8");
  const beforeIndex = await readFile(index, "utf8");
  const contextBefore = await agent.runCommand("/context");
  const result = await agent.runCommand("/compact", signal);
  expect(result).toMatch(/^Compacted \d+ older messages;/);
  expect(await agent.runCommand("/context")).not.toBe(contextBefore);
  expect(await readFile(log, "utf8")).toBe(before);
  expect(await readFile(index, "utf8")).toBe(beforeIndex);
  expect(
    await agent.chat("Report only the critical fact from the first archive batch.", signal),
  ).toContain(marker);
  expect((await readFile(log, "utf8")).startsWith(before)).toBe(true);
  const messages = await recorded();
  expect(messages.filter((message) => message.role === "user")).toHaveLength(4);
  console.log(
    `PASS: ${result} Original log/index unchanged; critical fact recalled after summary.`,
  );
});
