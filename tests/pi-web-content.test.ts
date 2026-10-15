import { expect, test } from "vitest";
import { createWebTools } from "../container/agent-runner/src/tools/web.ts";
import { pageFixture } from "./page-fixture.ts";

// Pi supplies the extension context during SDK execution; these tools do not use it.
const noContext = undefined as never;

test("Pi content tools preserve ordered partial failures and Unicode continuation", async () => {
  const pages = await pageFixture();
  pages.pages.set("/plain", { headers: { "Content-Type": "text/plain" }, body: "A😀BC文D" });
  pages.pages.set("/image", { headers: { "Content-Type": "image/png" }, body: "unsupported" });
  const [tool] = createWebTools({ fetch: true });
  try {
    const result = await tool.execute(
      "batch",
      {
        urls: [`${pages.endpoint}/plain`, `${pages.endpoint}/image`, `${pages.endpoint}/missing`],
        offset: 1,
        limit: 2,
      },
      undefined,
      undefined,
      noContext,
    );
    const text = result.content[0];
    if (text.type !== "text") throw new Error("Expected text tool content");
    expect(JSON.parse(text.text).urls).toEqual([
      {
        url: `${pages.endpoint}/plain`,
        finalUrl: `${pages.endpoint}/plain`,
        title: "",
        content: "😀B",
        error: null,
        totalChars: 6,
        nextOffset: 3,
      },
      {
        url: `${pages.endpoint}/image`,
        finalUrl: `${pages.endpoint}/image`,
        title: "",
        content: "",
        error: "Unsupported content type: image/png.",
        totalChars: 0,
        nextOffset: null,
      },
      {
        url: `${pages.endpoint}/missing`,
        finalUrl: `${pages.endpoint}/missing`,
        title: "",
        content: "",
        error: "Content request failed (HTTP 404).",
        totalChars: 0,
        nextOffset: null,
      },
    ]);
    const continuation = await tool.execute(
      "next",
      { url: `${pages.endpoint}/plain`, offset: 3, limit: 20 },
      undefined,
      undefined,
      noContext,
    );
    const next = continuation.content[0];
    if (next.type !== "text") throw new Error("Expected text tool content");
    expect(JSON.parse(next.text).urls[0]).toMatchObject({
      content: "C文D",
      totalChars: 6,
      nextOffset: null,
    });
  } finally {
    await pages.close();
  }
});

test("Pi HTML extraction removes hidden content and resolves relative links", async () => {
  const pages = await pageFixture();
  pages.pages.set("/article", {
    body: `<!doctype html><html><head><title>Field notes</title><base href="${pages.endpoint}/docs/"></head><body><article><h1>Orchard notes</h1><p>Amber orchard records are available in <a href="guide">the guide</a>.</p><p hidden>HIDDEN TEXT</p><p style="display:none">INVISIBLE TEXT</p><script>SECRET SCRIPT</script></article></body></html>`,
  });
  const [tool] = createWebTools({ fetch: true });
  try {
    const result = await tool.execute(
      "html",
      { url: `${pages.endpoint}/article` },
      undefined,
      undefined,
      noContext,
    );
    const text = result.content[0];
    if (text.type !== "text") throw new Error("Expected text tool content");
    const page = JSON.parse(text.text).urls[0];
    expect(page).toMatchObject({ title: "Field notes", error: null, nextOffset: null });
    expect(page.content).toContain("Orchard notes");
    expect(page.content).toContain(`[the guide](${pages.endpoint}/docs/guide)`);
    expect(page.content).not.toMatch(/HIDDEN TEXT|INVISIBLE TEXT|SECRET SCRIPT/);
  } finally {
    await pages.close();
  }
});
