import type { Bot, HistoryPage, HistoryRead } from "@mybots/contracts";
import { request } from "./api.ts";
import { markdown } from "./markdown.ts";

const node = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function historyBrowser(currentBot: () => Bot | undefined): void {
  const dialog = node<HTMLDialogElement>("history-dialog");
  const fields = node<HTMLFieldSetElement>("history-fields");
  const results = node("history-results");
  const search = node<HTMLInputElement>("history-query");
  let bot: Bot;
  let query = "";
  let cursors: (number | undefined)[] = [undefined];
  let next: number | undefined;
  let reading: HistoryRead | undefined;
  let original = "";
  let revision = 0;

  function run(action: (current: () => boolean) => Promise<void>): void {
    const version = ++revision;
    const current = () => version === revision;
    fields.disabled = true;
    node("history-status").textContent = "Loading…";
    void action(current)
      .catch((error: unknown) => {
        if (current())
          node("history-status").textContent =
            error instanceof Error ? error.message : "Request failed";
      })
      .finally(() => {
        if (current()) fields.disabled = false;
      });
  }
  function showResults(): void {
    node("history-list").hidden = false;
    node("history-reader").hidden = true;
    dialog.scrollTop = 0;
  }
  function read(entryId: number, offset = 0): void {
    run(async (current) => {
      const part = await request<HistoryRead>(`bots/${bot.id}/history/${entryId}?offset=${offset}`);
      if (!current()) return;
      reading = part;
      original = offset === 0 ? part.text : original + part.text;
      node("history-entry-title").textContent = `${part.role} · Original ${part.id}`;
      node("history-original").replaceChildren(markdown(original, async () => original));
      node("history-list").hidden = true;
      node("history-reader").hidden = false;
      if (offset === 0) dialog.scrollTop = 0;
      node("history-more").hidden = part.nextOffset === undefined;
      node("history-status").textContent =
        part.nextOffset === undefined ? "Complete original" : "More original text is available.";
    });
  }
  function load(positions = cursors): void {
    run(async (current) => {
      const params = new URLSearchParams({ query });
      const before = positions.at(-1);
      if (before !== undefined) params.set("before", String(before));
      const page = await request<HistoryPage>(`bots/${bot.id}/history?${params}`);
      if (!current()) return;
      cursors = positions;
      next = page.before;
      results.replaceChildren();
      for (const item of page.items) {
        const article = document.createElement("article");
        article.className = `message ${item.role}`;
        const preview = document.createElement("p");
        preview.textContent = `${item.role} · ${item.preview}`;
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = `Read original ${item.id}`;
        button.addEventListener("click", () => read(item.id));
        article.append(preview, button);
        results.append(article);
      }
      node<HTMLButtonElement>("history-older").disabled = next === undefined;
      node<HTMLButtonElement>("history-newer").disabled = cursors.length === 1;
      node("history-status").textContent = page.items.length
        ? `${page.items.length} originals in this page.`
        : "No matches in this page.";
      showResults();
    });
  }
  node("open-history").addEventListener("click", () => {
    const selected = currentBot();
    if (!selected) return;
    bot = selected;
    query = search.value = "";
    cursors = [undefined];
    reading = undefined;
    original = "";
    results.replaceChildren();
    node("history-original").replaceChildren();
    node("history-title").textContent = `${bot.name} · Thread history`;
    showResults();
    dialog.showModal();
    load();
  });
  node("history-form").addEventListener("submit", (event) => {
    event.preventDefault();
    query = search.value;
    cursors = [undefined];
    load();
  });
  node("history-older").addEventListener("click", () => {
    if (next === undefined) return;
    load([...cursors, next]);
  });
  node("history-newer").addEventListener("click", () => {
    load(cursors.slice(0, -1));
  });
  node("history-more").addEventListener("click", () => {
    if (reading?.nextOffset !== undefined) read(reading.id, reading.nextOffset);
  });
  node("history-back").addEventListener("click", () => {
    showResults();
    node("history-status").textContent = "";
  });
  node("close-history").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    revision++;
  });
}
