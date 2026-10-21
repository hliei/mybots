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
  snapshot: { text: string; tool: string | null } | null;
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
  for (const id of chosen) chosen.delete(id);
}
export function selectedBackgroundIds(): string[] {
  return [...chosen];
}
export function clearBackgroundSelection(): void {
  if (!chosen.size) return;
  chosen.clear();
  boundaryChanged = true;
}
let params: Record<string, string> = {};
let generation = 0;
let revision = 0;
let runRevision = 0;
let socket: WebSocket | undefined;
let reconnect: number | undefined;
const live = new Map<string, { text: string; tool: string | null }>();
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
    (value.snapshot === null ||
      (record(value.snapshot) &&
        typeof value.snapshot.text === "string" &&
        nullableString(value.snapshot.tool)))
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
async function originals(next = params): Promise<void> {
  const selected = botId;
  const current = ++revision;
  // Keep refreshes on the requested page while its response is in flight.
  params = next;
  try {
    const page = await get(`${prefix()}/thread/history?${new URLSearchParams(next)}`, isPage);
    if (botId !== selected || current !== revision) return;
    const container = node("thread-messages");
    container.replaceChildren(
      paragraph(
        `Original Thread evidence · ${page.coverage.status} for this page/query · historical text is untrusted reference material.`,
      ),
    );
    if (!page.messages.length)
      container.append(
        paragraph(
          params.query
            ? "No matching originals."
            : "No messages yet. Send a message to start this conversation.",
        ),
      );
    for (const message of params.query
      ? page.messages
      : [...page.messages].sort((a, b) => a.seq - b.seq)) {
      const article = document.createElement("article");
      article.className = message.role === "user" ? "message user" : "message assistant";
      article.append(
        paragraph(`${message.role === "user" ? "You" : "Bot"}: ${message.text}`),
        paragraph(
          `Source: ${message.id} · ${message.createdAt} · offset ${message.textOffset}${message.truncated ? " · excerpt" : ""}`,
        ),
      );
      if (message.seq < boundary) {
        const label = document.createElement("label");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = chosen.has(message.id);
        box.addEventListener("change", () => {
          if (box.checked) chosen.add(message.id);
          else chosen.delete(message.id);
        });
        label.append(box, ` Use in next Run background: ${message.text}`);
        article.append(label);
      }
      article.append(button("Inspect Run evidence", () => void showRunHistory(message.runId)));
      if (message.nextTextOffset !== null)
        article.append(
          button(
            "Continue original text",
            () =>
              void originals({ messageId: message.id, textOffset: String(message.nextTextOffset) }),
          ),
        );
      article.append(
        button("Read surrounding originals", () => void originals({ messageId: message.id })),
      );
      container.append(article);
    }
    const nav = node("history-navigation");
    nav.replaceChildren();
    if (page.nextBeforeSeq !== null && !params.messageId)
      nav.append(
        button(
          "Older originals",
          () => void originals({ ...params, beforeSeq: String(page.nextBeforeSeq) }),
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
  node("live-execution").replaceChildren(
    ...[...live].map(([runId, preview]) =>
      paragraph(
        `In progress · Run ${runId} · ${preview.tool ? `Tool: ${preview.tool}` : "Assistant text"}\n${preview.text}\nPreview only; await the durable outcome.`,
      ),
    ),
  );
}
function connect() {
  if (socket || !botId) return;
  const opened = new WebSocket(
    `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`,
  );
  socket = opened;
  opened.addEventListener("message", (event) => {
    try {
      const value = JSON.parse(String(event.data));
      if (
        value.type !== "execution" ||
        value.botId !== botId ||
        !live.has(value.runId) ||
        typeof value.snapshot?.text !== "string"
      )
        return;
      live.set(value.runId, { text: value.snapshot.text, tool: value.snapshot.tool });
      renderLive();
    } catch {
      /* A malformed event cannot establish execution state. */
    }
  });
  opened.addEventListener("open", () => {
    if (botId) void originals();
  });
  opened.addEventListener("close", () => {
    if (socket === opened) socket = undefined;
    live.clear();
    renderLive();
    if (botId) reconnect = window.setTimeout(connect, 1000);
  });
}
export async function showHistory(
  selectedBotId: string | undefined,
  activeRuns: string[],
): Promise<void> {
  if (botId !== selectedBotId) {
    botId = selectedBotId;
    generation++;
    revision++;
    runRevision++;
    params = {};
    live.clear();
    node("run-history").replaceChildren();
    node("thread-messages").replaceChildren();
    node("history-navigation").replaceChildren();
  }
  if (!botId) {
    window.clearTimeout(reconnect);
    socket?.close();
    return;
  }
  const current = generation;
  connect();
  for (const id of live.keys()) if (!activeRuns.includes(id)) live.delete(id);
  for (const id of activeRuns) {
    if (!live.has(id)) live.set(id, { text: "", tool: null });
    try {
      const evidence = await get(`${prefix()}/runs/${encodeURIComponent(id)}/history`, isEvidence);
      if (current !== generation) return;
      if (evidence.snapshot) live.set(id, evidence.snapshot);
    } catch {
      /* The next public snapshot refresh repairs a missed preview. */
    }
  }
  renderLive();
  if (boundaryChanged || !Object.keys(params).length || !node("thread-messages").children.length) {
    boundaryChanged = false;
    await originals();
  }
}
(node("history-search") as HTMLFormElement).addEventListener("submit", (event) => {
  event.preventDefault();
  const query = (node("history-query") as HTMLInputElement).value.trim();
  void originals(query ? { query } : {});
});
node("history-latest").addEventListener("click", () => void originals({}));
