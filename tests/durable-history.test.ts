import type { Bot, ChatView, HistoryPage, HistoryRead } from "@mybots/contracts";
import { expect, test } from "vitest";
import { apiFixture } from "./durable-api-fixture.ts";

async function send(
  fixture: Awaited<ReturnType<typeof apiFixture>>,
  bot: Bot,
  text: string,
): Promise<ChatView> {
  await fixture.request(`bots/${bot.id}/send`, { text, requestId: crypto.randomUUID() });
  let view: ChatView | undefined;
  await expect
    .poll(async () => {
      view = await fixture.request(`bots/${bot.id}/chat`);
      return view?.busy;
    })
    .toBe(false);
  if (!view) throw new Error("Chat unavailable");
  return view;
}

test("owner searches a selected Thread with bounded pages and reads complete originals", async () => {
  const fixture = await apiFixture();
  try {
    const bot: Bot = await fixture.request("bots", {
      name: "Writer",
      instructions: "",
      model: "deepseek/deepseek-flash",
    });
    const other: Bot = await fixture.request("bots", {
      name: "Reader",
      instructions: "",
      model: "deepseek/deepseek-flash",
    });
    const original = `ARCHIVE_NEEDLE ${"original detail ".repeat(1800)}END_OF_ORIGINAL`;
    const first = await send(fixture, bot, original);
    const originalId = Number(first.messages[0]?.id);
    const foreign = await send(fixture, other, "ARCHIVE_NEEDLE PRIVATE_OTHER_BOT");
    const foreignId = Number(foreign.messages[0]?.id);
    for (let index = 0; index < 22; index++)
      await send(fixture, bot, `ARCHIVE_NEEDLE note ${index}`);
    const path = `bots/${bot.id}/history?query=archive_needle`;
    const page = await fixture.request(path);
    expect(page.items).toHaveLength(20);
    expect(page.before).toBeGreaterThan(originalId);
    expect(JSON.stringify(page)).not.toContain("PRIVATE_OTHER_BOT");
    const next = await fixture.request(`${path}&before=${page.before}`);
    expect(next.items).toHaveLength(3);
    expect(next.items.at(-1).id).toBe(originalId);
    expect(next.before).toBeUndefined();
    expect(page.items.every((item: { preview: string }) => item.preview.length <= 240)).toBe(true);
    let reconstructed = "";
    let offset = 0;
    do {
      const part = await fixture.request(`bots/${bot.id}/history/${originalId}?offset=${offset}`);
      expect(part.text.length).toBeLessThanOrEqual(8000);
      reconstructed += part.text;
      offset = part.nextOffset;
    } while (offset !== undefined);
    expect(reconstructed).toBe(original);
    await fixture.reopen();
    expect((await fixture.request(`${path}&before=${page.before}`)).items).toEqual(next.items);
    for (const suffix of [
      `/${foreignId}`,
      "/0",
      `/${originalId}?offset=-1`,
      `/${originalId}?offset=0.5`,
      "?before=0",
      "?before=NaN",
      `?query=${"x".repeat(201)}`,
    ]) {
      const response = await fetch(new URL(`api/bots/${bot.id}/history${suffix}`, fixture.url), {
        headers: { Authorization: `Bearer ${fixture.credential}` },
      });
      expect(response.status).toBe(400);
    }
  } finally {
    await fixture.close();
  }
}, 30000);

test("Agent retrieves compacted originals after worker reopen within its own Thread", async () => {
  const original = `ARCHIVED_SOURCE ${"archived details ".repeat(1800)}ARCHIVED_END`;
  let seed = true;
  let retrieve = false;
  let round = 0;
  let foreignId = 0;
  let originalId = 0;
  let recovered = "";
  const fixture = await apiFixture(
    (request) => {
      if (JSON.stringify(request.messages[0]).includes("summarization"))
        return { text: "Native summary of prior work." };
      if (!retrieve) return { text: seed ? original : "Recent reply" };
      if (round++ === 0) return { tool: "history_read", arguments: { entryId: foreignId } };
      if (round === 2) return { tool: "history_search", arguments: { query: "ARCHIVED_SOURCE" } };
      const content = String(
        request.messages.findLast((message) => message.role === "tool")?.content ?? "",
      );
      const result = content.startsWith("{") ? JSON.parse(content) : {};
      if (round === 3) {
        const page = result as HistoryPage;
        return {
          tool: "history_read",
          arguments: {
            entryId:
              page.items?.find((item) => item.preview.startsWith("ARCHIVED_SOURCE "))?.id ?? 0,
          },
        };
      }
      const part = result as HistoryRead;
      recovered += part.text ?? "";
      if (part.nextOffset !== undefined)
        return {
          tool: "history_read",
          arguments: { entryId: originalId, offset: part.nextOffset },
        };
      return {
        text: recovered.endsWith("ARCHIVED_END")
          ? "Finished using the original evidence"
          : "Evidence missing",
      };
    },
    { contextWindow: 5000 },
  );
  try {
    const bot: Bot = await fixture.request("bots", {
      name: "Archivist",
      instructions: "Keep the current role",
      model: "deepseek/deepseek-flash",
    });
    originalId = Number((await send(fixture, bot, "Save the source")).messages.at(-1)?.id);
    seed = false;
    const other: Bot = await fixture.request("bots", {
      name: "Other",
      instructions: "",
      model: "deepseek/deepseek-flash",
    });
    foreignId = Number((await send(fixture, other, "PRIVATE_OTHER_THREAD")).messages[0]?.id);
    for (let index = 0; index < 5; index++) await send(fixture, bot, `recent-${index}`);
    expect(
      fixture.service.requests.some((request) =>
        JSON.stringify(request.messages[0]).includes("summarization"),
      ),
    ).toBe(true);
    expect((await fixture.request(`bots/${bot.id}/history/${originalId}`)).text).toContain(
      "ARCHIVED_SOURCE",
    );
    await fixture.reopen();
    expect((await fixture.request(`bots/${bot.id}/history/${originalId}`)).text).toContain(
      "ARCHIVED_SOURCE",
    );
    retrieve = true;
    const start = fixture.service.requests.length;
    const view = await send(fixture, bot, "Retrieve the earlier source and finish");
    expect(view.messages.at(-1)?.text).toBe("Finished using the original evidence");
    expect(recovered).toBe(original);
    const call = view.messages.find((message) => message.tools.includes("history_read"));
    expect((await fixture.request(`bots/${bot.id}/history/${call?.id}`)).text).toContain(
      `"entryId":${foreignId}`,
    );
    const generations = fixture.service.requests
      .slice(start)
      .filter((request) => !JSON.stringify(request.messages[0]).includes("summarization"));
    expect(JSON.stringify(generations[0])).not.toContain("ARCHIVED_SOURCE");
    expect(JSON.stringify(generations[0])).not.toContain("recent-0");
    expect(JSON.stringify(generations[0])).toContain("recent-4");
    expect(JSON.stringify(generations)).not.toContain("PRIVATE_OTHER_THREAD");
    expect(JSON.stringify(generations)).toContain("Historical evidence");
    expect(view.messages.filter((message) => message.role === "tool")[0]?.text).toContain(
      "Original unavailable",
    );
    for (const request of generations) {
      expect(
        request.messages
          .filter((message) => message.role === "tool")
          .map((message) => message.tool_call_id),
      ).toEqual(
        request.messages.flatMap((message) => message.tool_calls?.map((call) => call.id) ?? []),
      );
    }
  } finally {
    await fixture.close();
  }
}, 30000);

test("search continues past an empty scan page to originals outside the chat window", async () => {
  const fixture = await apiFixture();
  try {
    const bot: Bot = await fixture.request("bots", {
      name: "Long Thread",
      instructions: "",
      model: "deepseek/deepseek-flash",
    });
    const first = await send(fixture, bot, "DISTANT_ORIGINAL");
    for (let index = 0; index < 70; index++) await send(fixture, bot, `filler-${index}`);
    const view: ChatView = await fixture.request(`bots/${bot.id}/chat`);
    expect(view.messages.some((message) => message.text === "DISTANT_ORIGINAL")).toBe(false);
    const page: HistoryPage = await fixture.request(
      `bots/${bot.id}/history?query=DISTANT_ORIGINAL`,
    );
    expect(page.items).toEqual([]);
    expect(page.before).toBeGreaterThan(0);
    const next: HistoryPage = await fixture.request(
      `bots/${bot.id}/history?query=DISTANT_ORIGINAL&before=${page.before}`,
    );
    expect(next.items).toEqual([
      { id: Number(first.messages[0]?.id), role: "user", preview: "DISTANT_ORIGINAL" },
    ]);
    expect(next.before).toBeUndefined();
  } finally {
    await fixture.close();
  }
}, 30000);
