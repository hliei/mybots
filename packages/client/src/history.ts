import { copyButton, markdown } from "./markdown.ts";
import {
  type Position,
  restoreReadingPosition,
  saveReadingPosition,
  selectReadingBot,
  setReadingPosition,
} from "./reading-position.ts";
import { openDetail } from "./shell.ts";

interface Original {
  seq: number;
  id: string;
  runId: string;
  role: string;
  createdAt: string;
  text: string;
  textOffset: number;
  nextTextOffset: number | null;
  truncated: boolean;
}
interface Page {
  messages: Original[];
  runs: { id: string; taskId: string; state: string }[];
  nextBeforeSeq: number | null;
  olderMessageId: string | null;
  newerMessageId: string | null;
  coverage: { status: string };
}
interface Evidence {
  records: {
    id: string;
    kind: string;
    text: string;
    createdAt: string;
    incarnation?: number;
    nextTextOffset: number | null;
    toolName?: string;
  }[];
  nextAfter: string | null;
  snapshot: Preview | null;
}
const node = (id: string) => document.getElementById(id) as HTMLElement;
function paragraph(text: string) {
  const p = document.createElement("p");
  p.textContent = text;
  return p;
}
function button(label: string, action: () => void) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.addEventListener("click", action);
  return b;
}
let botId: string | undefined;
let boundary = 0;
let boundaryChanged = false;
const chosen = new Set<string>();
export function setBackgroundBoundary(value: number): void {
  if (boundary === value) return;
  boundary = value;
  boundaryChanged = true;
  chosen.clear();
  updateBackgroundSelection();
}
export function selectedBackgroundIds(): string[] {
  return [...chosen];
}
export function clearBackgroundSelection(): void {
  if (!chosen.size) return;
  chosen.clear();
  updateBackgroundSelection();
  boundaryChanged = true;
}
function updateBackgroundSelection(): void {
  const summary = node("background-selection");
  summary.hidden = chosen.size === 0;
  node("background-selection-count").textContent =
    `${chosen.size} of 7 earlier originals selected for New task background. Existing Runs keep their background.`;
  for (const box of document.querySelectorAll<HTMLInputElement>("input[data-background-id]")) {
    box.checked = chosen.has(box.dataset.backgroundId as string);
    box.disabled = chosen.size >= 7 && !box.checked;
  }
}
let params: Record<string, string> = {};
let continuedOriginal: Original | undefined;
let searchRevision = 0;
let readingReturn:
  | {
      params: Record<string, string>;
      loaded: Map<string, Original>;
      position: Position;
      continuedOriginal: Original | undefined;
    }
  | undefined;
let generation = 0;
let revision = 0;
let runRevision = 0;
let socket: WebSocket | undefined;
let reconnect: number | undefined;
interface Preview {
  id: string;
  text: string;
  tool: string | null;
  textOffset: number;
  incarnation: number;
  inputId?: string;
  preview?: boolean;
}
const live = new Map<string, Preview>();
let active = new Set<string>();
let chatRuns = new Set<string>();
let loaded = new Map<string, Original>();
const pages = new Map<string, { params: Record<string, string>; loaded: Map<string, Original> }>();
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nullableNumber(value: unknown) {
  return value === null || typeof value === "number";
}
function nullableString(value: unknown) {
  return value === null || typeof value === "string";
}
function isPage(value: unknown): value is Page {
  return (
    record(value) &&
    Array.isArray(value.messages) &&
    value.messages.every(
      (item: unknown) =>
        record(item) &&
        [item.id, item.runId, item.role, item.createdAt, item.text].every(
          (field) => typeof field === "string",
        ) &&
        typeof item.seq === "number" &&
        typeof item.textOffset === "number" &&
        nullableNumber(item.nextTextOffset) &&
        typeof item.truncated === "boolean",
    ) &&
    Array.isArray(value.runs) &&
    value.runs.every(
      (item: unknown) =>
        record(item) &&
        [item.id, item.taskId, item.state].every((field) => typeof field === "string"),
    ) &&
    record(value.coverage) &&
    typeof value.coverage.status === "string" &&
    nullableNumber(value.nextBeforeSeq) &&
    nullableString(value.olderMessageId) &&
    nullableString(value.newerMessageId)
  );
}
function isPreview(value: unknown): value is Preview {
  return (
    record(value) &&
    typeof value.id === "string" &&
    typeof value.text === "string" &&
    nullableString(value.tool) &&
    Number.isSafeInteger(value.textOffset) &&
    Number(value.textOffset) >= 0 &&
    Number.isSafeInteger(value.incarnation) &&
    Number(value.incarnation) >= 0 &&
    (value.inputId === undefined || typeof value.inputId === "string") &&
    (value.preview === undefined || typeof value.preview === "boolean")
  );
}
function isEvidence(value: unknown): value is Evidence {
  return (
    record(value) &&
    Array.isArray(value.records) &&
    value.records.every(
      (item: unknown) =>
        record(item) &&
        [item.id, item.kind, item.text, item.createdAt].every(
          (field) => typeof field === "string",
        ) &&
        (item.incarnation === undefined || typeof item.incarnation === "number") &&
        nullableNumber(item.nextTextOffset) &&
        (item.toolName === undefined || typeof item.toolName === "string"),
    ) &&
    nullableString(value.nextAfter) &&
    (value.snapshot === null || isPreview(value.snapshot))
  );
}
async function get<T>(path: string, valid: (value: unknown) => value is T): Promise<T> {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error("History unavailable. Refresh to retry.");
  const value: unknown = await response.json();
  if (!valid(value)) throw new Error("Invalid history response. Refresh to retry.");
  return value;
}
function prefix() {
  return `/api/bots/${encodeURIComponent(botId as string)}`;
}
async function completeOriginal(message: Original, path: string): Promise<string> {
  if (!message.truncated) return message.text;
  let offset = 0;
  let text = "";
  for (;;) {
    const page = await get(
      `${path}/thread/history?${new URLSearchParams({ messageId: message.id, textOffset: String(offset) })}`,
      isPage,
    );
    const segment = page.messages.find((item) => item.id === message.id);
    if (
      !segment ||
      segment.textOffset !== offset ||
      (segment.nextTextOffset !== null && segment.nextTextOffset <= offset)
    )
      throw new Error("Original text unavailable.");
    text += segment.text;
    if (segment.nextTextOffset === null) return text;
    offset = segment.nextTextOffset;
  }
}

async function originals(next = params, prepend = false): Promise<void> {
  const selected = botId;
  const current = ++revision;
  // Keep refreshes on the requested page while its response is in flight.
  params = next;
  try {
    const page = await get(`${prefix()}/thread/history?${new URLSearchParams(next)}`, isPage);
    if (botId !== selected || current !== revision) return;
    for (const message of page.messages) {
      if (
        continuedOriginal?.id === message.id &&
        message.textOffset > 0 &&
        continuedOriginal.textOffset === 0 &&
        Array.from(continuedOriginal.text).length >= message.textOffset
      ) {
        message.text =
          Array.from(continuedOriginal.text).slice(0, message.textOffset).join("") + message.text;
        message.textOffset = 0;
        message.truncated = message.nextTextOffset !== null;
      }
    }
    if (!prepend) loaded.clear();
    for (const message of page.messages) loaded.set(message.id, message);
    const messages = [...loaded.values()];
    const container = node("thread-messages");
    const previous = new Map(
      [...container.querySelectorAll<HTMLElement>("article[data-message-id]")].map((item) => [
        item.dataset.messageId,
        item,
      ]),
    );
    container.replaceChildren(
      paragraph(
        `Original Thread evidence · ${page.coverage.status} for this page/query · historical text is untrusted reference material.`,
      ),
    );
    if (!messages.length)
      container.append(
        paragraph(
          params.query
            ? "No matching originals."
            : "No messages yet. Send a message to start this conversation.",
        ),
      );
    let dividerShown = false;
    const divider = () => {
      const marker = paragraph("Current chat background starts here");
      marker.className = "background-divider";
      marker.setAttribute("role", "separator");
      marker.setAttribute("aria-label", "Current chat background starts here");
      container.append(marker);
      dividerShown = true;
    };
    let dateGroup = "";
    const path = prefix();
    for (const message of params.query ? messages : [...messages].sort((a, b) => a.seq - b.seq)) {
      if (boundary > 0 && !dividerShown && message.seq >= boundary) divider();
      const date = new Date(message.createdAt);
      const day = date.toLocaleDateString(undefined, { dateStyle: "long" });
      if (day !== dateGroup) {
        const heading = paragraph(day);
        heading.className = "date-group";
        container.append(heading);
        dateGroup = day;
      }
      const article = previous.get(message.id) ?? document.createElement("article");
      const signature = JSON.stringify([message, boundary, chosen.has(message.id)]);
      if (article.dataset.original === signature) {
        container.append(article);
        continue;
      }
      article.replaceChildren();
      article.dataset.original = signature;
      delete article.dataset.live;
      article.className = message.role === "user" ? "message user" : "message assistant";
      article.dataset.messageId = message.id;
      article.dataset.textOffset = String(message.textOffset);
      const meta = document.createElement("div");
      meta.className = "message-meta";
      const time = document.createElement("time");
      time.dateTime = message.createdAt;
      time.textContent = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
      time.title = date.toLocaleString();
      meta.append(message.role === "user" ? "You · " : "Bot · ", time);
      article.append(
        meta,
        markdown(message.text, () => completeOriginal(message, path)),
      );
      const evidence = document.createElement("details");
      evidence.className = "message-evidence";
      const summary = document.createElement("summary");
      summary.textContent = "Message evidence";
      evidence.append(
        summary,
        paragraph(
          `Source: ${message.id} · ${message.createdAt} · offset ${message.textOffset}${message.truncated ? " · excerpt" : ""}`,
        ),
      );
      if (message.seq < boundary) {
        const label = document.createElement("label");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = chosen.has(message.id);
        box.dataset.backgroundId = message.id;
        box.title = "Use as background for new work only (up to seven originals)";
        box.addEventListener("change", () => {
          if (box.checked && chosen.size < 7) chosen.add(message.id);
          else chosen.delete(message.id);
          updateBackgroundSelection();
          document.dispatchEvent(new CustomEvent("background-selection", { detail: chosen.size }));
        });
        label.append(box, ` Use in next Run background: ${message.text}`);
        article.append(label);
      }
      article.append(copyButton("Copy message", () => completeOriginal(message, path)));
      evidence.append(button("Inspect Run evidence", () => void showRunHistory(message.runId)));
      if (message.nextTextOffset !== null)
        article.append(
          button("Continue original text", () => {
            continuedOriginal = message;
            void originals({ messageId: message.id, textOffset: String(message.nextTextOffset) });
          }),
        );
      evidence.append(
        button("Read surrounding originals", () => void originals({ messageId: message.id })),
      );
      article.append(evidence);
      container.append(article);
    }
    if (boundary > 0 && !dividerShown && !params.beforeSeq && !params.messageId && !params.query)
      divider();
    const nav = node("history-navigation");
    nav.replaceChildren();
    if (page.nextBeforeSeq !== null && !params.messageId)
      nav.append(
        button(
          "Older originals",
          () => void originals({ ...params, beforeSeq: String(page.nextBeforeSeq) }, true),
        ),
      );
    if (params.messageId) {
      if (page.olderMessageId)
        nav.append(
          button(
            "Read older neighbors",
            () => void originals({ messageId: page.olderMessageId as string, direction: "older" }),
          ),
        );
      if (page.newerMessageId)
        nav.append(
          button(
            "Read newer neighbors",
            () => void originals({ messageId: page.newerMessageId as string, direction: "newer" }),
          ),
        );
    }
    for (const article of previous.values()) {
      if (article.dataset.live && !loaded.has(article.dataset.messageId ?? ""))
        container.append(article);
    }
    updateBackgroundSelection();
    renderLive();
    restoreReadingPosition();
  } catch (error) {
    if (selected === botId && current === revision)
      node("history-navigation").textContent = (error as Error).message;
  }
}
export async function showRunHistory(
  runId: string,
  params: Record<string, string> = {},
): Promise<void> {
  openDetail("tasks");
  const selected = botId;
  const current = ++runRevision;
  try {
    const page = await get<Evidence>(
      `${prefix()}/runs/${encodeURIComponent(runId)}/history?${new URLSearchParams(params)}`,
      isEvidence,
    );
    if (selected !== botId || current !== runRevision) return;
    const container = node("run-history");
    container.replaceChildren(
      button("Run inputs", () => void showRunHistory(runId, { kind: "inputs" })),
      button("Run Attempts", () => void showRunHistory(runId, { kind: "attempts" })),
      button("Model and tool originals", () => void showRunHistory(runId)),
      paragraph(
        `Recorded Run evidence: ${runId}. Originals retained independently of SDK compaction.`,
      ),
    );
    if (!page.records.length)
      container.append(paragraph("No recorded model/tool evidence on this page."));
    for (const record of page.records) {
      container.append(
        paragraph(
          `${record.kind}${record.toolName ? ` · ${record.toolName}` : ""} · ${record.id} · executor generation ${record.incarnation ?? "not started"} · ${record.createdAt}`,
        ),
        paragraph(record.text),
      );
      if (record.nextTextOffset !== null)
        container.append(
          button(
            "Continue record text",
            () =>
              void showRunHistory(runId, {
                ...params,
                recordId: record.id,
                textOffset: String(record.nextTextOffset),
              }),
          ),
        );
    }
    if (page.nextAfter)
      container.append(
        button(
          "More Run evidence",
          () => void showRunHistory(runId, { ...params, after: page.nextAfter as string }),
        ),
      );
  } catch (error) {
    if (selected === botId && current === runRevision)
      node("run-history").textContent = (error as Error).message;
  }
}
function renderLive() {
  const previews: HTMLElement[] = [];
  const container = node("thread-messages");
  const visible = new Set<string>();
  for (const [runId, preview] of live) {
    if (loaded.has(preview.id)) continue;
    if (!active.has(runId)) continue;
    if (!chatRuns.has(runId) || preview.preview || preview.tool) {
      previews.push(
        paragraph(
          `In progress · ${chatRuns.has(runId) ? "Tool preview" : "Background work"} · Run ${runId}${preview.tool ? ` · Tool: ${preview.tool}` : ""}\n${preview.text}\nPreview only; await the durable outcome.`,
        ),
      );
      continue;
    }
    if (Object.keys(params).length) continue;
    visible.add(preview.id);
    let article = [...container.querySelectorAll<HTMLElement>("article")].find(
      (item) => item.dataset.messageId === preview.id,
    );
    if (!article) {
      article = document.createElement("article");
      article.className = "message assistant live-message";
      article.dataset.messageId = preview.id;
      article.dataset.live = "true";
      container.append(article);
    }
    article.dataset.runId = runId;
    article.dataset.inputId = preview.inputId ?? "";
    article.dataset.incarnation = String(preview.incarnation);
    const signature = JSON.stringify(preview);
    if (article.dataset.preview !== signature) {
      article.dataset.preview = signature;
      const meta = paragraph(
        `In progress · Run ${runId} · Preview only; await the durable outcome.${preview.textOffset ? " · Earlier live text unavailable" : ""}`,
      );
      meta.className = "message-meta";
      const text = paragraph(preview.text || "Thinking…");
      text.className = "message-content";
      article.replaceChildren(meta, text);
    }
  }
  for (const article of container.querySelectorAll<HTMLElement>("[data-live]")) {
    if (!visible.has(article.dataset.messageId ?? "")) article.remove();
  }
  node("live-execution").replaceChildren(...previews);
  restoreReadingPosition();
}
function connect() {
  if (socket || !botId) return;
  const opened = new WebSocket(
    `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`,
  );
  socket = opened;
  opened.addEventListener("message", (event) => {
    try {
      const value: unknown = JSON.parse(String(event.data));
      if (
        !record(value) ||
        value.type !== "execution" ||
        value.botId !== botId ||
        typeof value.runId !== "string" ||
        !live.has(value.runId) ||
        !isPreview(value.snapshot)
      )
        return;
      live.set(value.runId, value.snapshot);
      renderLive();
    } catch {
      /* A malformed event cannot establish execution state. */
    }
  });
  opened.addEventListener("open", () => {
    if (botId) void originals(params, true);
  });
  opened.addEventListener("close", () => {
    if (socket === opened) socket = undefined;
    live.clear();
    renderLive();
    if (botId) reconnect = window.setTimeout(connect, 1000);
  });
}
export function selectHistoryBot(selectedBotId: string | undefined): void {
  if (botId !== selectedBotId) {
    if (readingReturn) {
      params = readingReturn.params;
      loaded = readingReturn.loaded;
      setReadingPosition(readingReturn.position);
    }
    if (botId) pages.set(botId, { params, loaded });
    botId = selectedBotId;
    selectReadingBot(botId);
    generation++;
    revision++;
    runRevision++;
    params = (botId && pages.get(botId)?.params) || {};
    loaded = (botId && pages.get(botId)?.loaded) || new Map();
    continuedOriginal = undefined;
    readingReturn = undefined;
    searchRevision++;
    node("search-results").replaceChildren();
    node("search-navigation").replaceChildren();
    (node("history-query") as HTMLInputElement).value = "";
    node("history-return").hidden = true;
    live.clear();
    node("run-history").replaceChildren();
    node("thread-messages").replaceChildren();
    node("history-navigation").replaceChildren();
  }
}
export async function showHistory(
  selectedBotId: string | undefined,
  activeRuns: string[],
  conversationRuns: string[] = activeRuns,
): Promise<void> {
  selectHistoryBot(selectedBotId);
  if (!botId) {
    window.clearTimeout(reconnect);
    socket?.close();
    return;
  }
  const current = generation;
  connect();
  active = new Set(activeRuns);
  chatRuns = new Set(conversationRuns);
  for (const id of live.keys()) if (!active.has(id)) live.delete(id);
  for (const id of activeRuns) {
    try {
      const evidence = await get(`${prefix()}/runs/${encodeURIComponent(id)}/history`, isEvidence);
      if (current !== generation) return;
      if (evidence.snapshot) live.set(id, evidence.snapshot);
    } catch {
      /* The next public snapshot refresh repairs a missed preview. */
    }
  }
  if (boundaryChanged || !Object.keys(params).length || !node("thread-messages").children.length) {
    boundaryChanged = false;
    await originals(params, loaded.size > 0);
  } else renderLive();
}
async function locateOriginal(message: Original): Promise<void> {
  const position = saveReadingPosition();
  if (!readingReturn && position)
    readingReturn = { params, loaded: new Map(loaded), position, continuedOriginal };
  node("history-return").hidden = !readingReturn;
  setReadingPosition({ follow: false, top: 0, anchor: message.id, offset: 20 });
  await originals({ messageId: message.id });
}
function returnToReading(): void {
  const saved = readingReturn;
  if (!saved) return;
  readingReturn = undefined;
  node("history-return").hidden = true;
  params = saved.params;
  loaded = saved.loaded;
  continuedOriginal = saved.continuedOriginal;
  setReadingPosition(saved.position);
  void originals(params, true);
}
async function searchOriginals(query: string, beforeSeq?: number): Promise<void> {
  const selected = botId;
  if (!selected) return;
  const current = ++searchRevision;
  const next = { query, ...(beforeSeq === undefined ? {} : { beforeSeq: String(beforeSeq) }) };
  try {
    const page = await get(`${prefix()}/thread/history?${new URLSearchParams(next)}`, isPage);
    if (selected !== botId || current !== searchRevision) return;
    const results = node("search-results");
    results.replaceChildren(
      paragraph(page.messages.length ? "Matching originals" : "No matching originals."),
    );
    for (const message of page.messages) {
      const result = document.createElement("article");
      result.append(
        paragraph(
          `${message.role === "user" ? "You" : "Bot"} · ${new Date(message.createdAt).toLocaleString()}`,
        ),
        paragraph(message.text),
        ...(message.truncated
          ? [paragraph("Excerpt · read the original for the remaining text.")]
          : []),
        button("Read surrounding originals", () => void locateOriginal(message)),
      );
      results.append(result);
    }
    const navigation = node("search-navigation");
    navigation.replaceChildren();
    if (page.nextBeforeSeq !== null)
      navigation.append(
        button(
          "More search results",
          () => void searchOriginals(query, page.nextBeforeSeq as number),
        ),
      );
  } catch (error) {
    if (selected === botId && current === searchRevision)
      node("search-results").textContent = (error as Error).message;
  }
}
(node("history-search") as HTMLFormElement).addEventListener("submit", (event) => {
  event.preventDefault();
  const query = (node("history-query") as HTMLInputElement).value.trim();
  if (query) void searchOriginals(query);
  else {
    searchRevision++;
    node("search-results").replaceChildren(
      paragraph("Enter words to search this Bot’s conversation."),
    );
    node("search-navigation").replaceChildren();
  }
});
node("history-return").addEventListener("click", returnToReading);
document.addEventListener("detail-mode", (event) => {
  if ((event as CustomEvent).detail !== "search") returnToReading();
});
function latestOriginals(): void {
  readingReturn = undefined;
  // Concurrent status refreshes must not merge the previous reading page back in.
  loaded = new Map();
  node("history-return").hidden = true;
  void originals({});
}
node("history-latest").addEventListener("click", latestOriginals);
document.addEventListener("history-latest", latestOriginals);

node("clear-background-selection").addEventListener("click", () => {
  clearBackgroundSelection();
  document.dispatchEvent(new CustomEvent("background-selection", { detail: 0 }));
});
