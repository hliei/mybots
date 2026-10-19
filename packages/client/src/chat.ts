interface ChatSession {
  id: string;
  botId: string;
  name: string;
  purpose: string;
}
interface Outcome {
  kind: string;
  reply: string;
}
interface Work {
  id: string;
  state: string;
  outcome: Outcome | null;
  messages: { id: string; text: string; outcome: Outcome | null }[];
}
interface Pending {
  botId: string;
  operation: "create" | "name" | "message";
  sessionId: string;
  requestId: string;
  content: string;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isSession(value: unknown): value is ChatSession {
  return (
    record(value) &&
    [value.id, value.botId, value.name, value.purpose].every((item) => typeof item === "string")
  );
}
function isOutcome(value: unknown): value is Outcome | null {
  return (
    value === null ||
    (record(value) && typeof value.kind === "string" && typeof value.reply === "string")
  );
}
function isWork(value: unknown): value is Work {
  return (
    record(value) &&
    typeof value.id === "string" &&
    typeof value.state === "string" &&
    isOutcome(value.outcome) &&
    Array.isArray(value.messages) &&
    value.messages.every(
      (message: unknown) =>
        record(message) &&
        typeof message.id === "string" &&
        typeof message.text === "string" &&
        isOutcome(message.outcome),
    )
  );
}
function isPending(value: unknown): value is Pending {
  return (
    record(value) &&
    [value.botId, value.sessionId, value.requestId, value.content].every(
      (item) => typeof item === "string",
    ) &&
    ["create", "name", "message"].includes(value.operation as string)
  );
}
function element<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
const panel = element("chat");
const sessions = element("chat-sessions");
const selected = element("selected-chat");
const works = element("chat-works");
const notice = element("chat-message");
const createForm = element<HTMLFormElement>("session-form");
const nameForm = element<HTMLFormElement>("session-name-form");
const messageForm = element<HTMLFormElement>("message-form");
const name = element<HTMLInputElement>("session-name");
const rename = element<HTMLInputElement>("rename-session");
const text = element<HTMLTextAreaElement>("message-text");
const retry = element<HTMLButtonElement>("retry-chat");
const pendingKey = "mybots.pending-chat";
let pending: Pending | undefined;
try {
  const stored: unknown = JSON.parse(localStorage.getItem(pendingKey) ?? "null");
  if (isPending(stored)) pending = stored;
} catch {
  /* An unreadable draft has no valid request to retry. */
}
let botId: string | undefined;
let sessionId: string | undefined;
let version = 0;
let sending = false;
let uncertain = false;

function rememberSession(id: string): void {
  sessionId = id;
  localStorage.setItem(`mybots.selected-session.${botId}`, id);
}
function controls(): void {
  for (const input of panel.querySelectorAll<
    HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement
  >("form input, form textarea, form button"))
    input.disabled = sending || !!pending;
  for (const input of messageForm.querySelectorAll<
    HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement
  >("textarea, button"))
    input.disabled ||= uncertain;
  retry.hidden = !pending;
  retry.disabled = sending;
}
function paragraph(text: string): HTMLParagraphElement {
  const node = document.createElement("p");
  node.textContent = text;
  return node;
}

export async function showChat(selectedBotId: string | undefined): Promise<void> {
  if (selectedBotId !== botId) {
    botId = selectedBotId;
    sessionId = botId
      ? (localStorage.getItem(`mybots.selected-session.${botId}`) ?? undefined)
      : undefined;
    selected.textContent = "";
    works.replaceChildren();
    sessions.replaceChildren();
    rename.value = "";
    text.value = "";
    uncertain = false;
  }
  panel.hidden = !botId;
  if (!botId) return;
  const current = ++version;
  const currentBot = botId;
  controls();
  if (pending && !sending)
    notice.textContent = `Chat response unconfirmed for Bot ${pending.botId}. Retry the saved ${pending.operation} request to recover its admission.`;
  try {
    const response = await fetch(`/api/sessions?botId=${encodeURIComponent(currentBot)}`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error();
    const result: unknown = await response.json();
    if (!record(result) || !Array.isArray(result.sessions) || !result.sessions.every(isSession))
      throw new Error();
    if (current !== version) return;
    const items = result.sessions;
    sessions.replaceChildren(
      ...items.map((session) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = `Select session ${session.name}`;
        button.setAttribute("aria-pressed", String(session.id === sessionId));
        button.addEventListener("click", () => {
          rememberSession(session.id);
          rename.value = "";
          text.value = "";
          selected.textContent = "Loading session…";
          works.replaceChildren();
          messageForm.hidden = true;
          nameForm.hidden = true;
          void showChat(botId);
        });
        return button;
      }),
    );
    const active = items.find((session) => session.id === sessionId);
    selected.hidden = !active;
    nameForm.hidden = !active;
    messageForm.hidden = !active;
    if (!active) {
      selected.textContent = items.length
        ? "Select a chat session."
        : "Create a chat session to begin.";
      selected.hidden = false;
      works.replaceChildren();
      return;
    }
    selected.textContent = `${active.name} · Session ID: ${active.id}`;
    rename.placeholder = active.name;
    const detailResponse = await fetch(`/api/sessions/${encodeURIComponent(active.id)}`, {
      cache: "no-store",
    });
    if (!detailResponse.ok) throw new Error();
    const detail: unknown = await detailResponse.json();
    if (!record(detail) || !Array.isArray(detail.works) || !detail.works.every(isWork))
      throw new Error();
    if (current !== version) return;
    uncertain = detail.works.some((work) => work.state === "uncertain");
    works.replaceChildren(
      ...detail.works.map((work) => {
        const article = document.createElement("article");
        article.append(
          paragraph(`Work ID: ${work.id}`),
          paragraph(`Execution: ${work.state}`),
          paragraph(`Outcome: ${work.outcome?.kind ?? "unresolved"}`),
        );
        if (work.state === "uncertain")
          article.append(
            paragraph(
              "Final evidence is missing after execution was interrupted. This work needs owner resolution before ordinary input can continue. Use another session for unrelated work.",
            ),
          );
        for (const message of work.messages) {
          const input = paragraph(`You: ${message.text}`);
          input.className = "chat-input";
          article.append(input);
          if (message.outcome)
            article.append(
              paragraph(
                `${message.outcome.kind === "failed" ? "Failure" : "Reply"}: ${message.outcome.reply}`,
              ),
            );
          else article.append(paragraph("Awaiting final evidence."));
        }
        return article;
      }),
    );
    controls();
  } catch {
    if (current === version)
      notice.textContent =
        "Chat state unavailable. Displayed results may be stale. Refresh to retry.";
  }
}

async function submit(operation?: Pending["operation"], content = ""): Promise<void> {
  if (sending || !botId) return;
  sending = true;
  try {
    if (!pending) {
      if (!operation) return;
      const draft: Pending = {
        botId,
        sessionId: sessionId ?? "",
        operation,
        requestId: crypto.randomUUID(),
        content,
      };
      localStorage.setItem(pendingKey, JSON.stringify(draft));
      pending = draft;
    }
    controls();
    const admitted = pending;
    const path =
      admitted.operation === "create"
        ? "/api/sessions"
        : `/api/sessions/${encodeURIComponent(admitted.sessionId)}/${admitted.operation === "name" ? "name" : "messages"}`;
    const body =
      admitted.operation === "create"
        ? { requestId: admitted.requestId, botId: admitted.botId, name: admitted.content }
        : admitted.operation === "name"
          ? { requestId: admitted.requestId, name: admitted.content }
          : { requestId: admitted.requestId, text: admitted.content };
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result: unknown = await response.json();
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500) {
        localStorage.removeItem(pendingKey);
        pending = undefined;
      }
      notice.textContent =
        record(result) && typeof result.error === "string"
          ? result.error
          : "Chat operation unavailable. Retry the same request.";
      return;
    }
    if (
      !record(result) ||
      result.requestId !== admitted.requestId ||
      (admitted.operation === "message"
        ? typeof result.workId !== "string" || typeof result.messageId !== "string"
        : !isSession(result.session))
    )
      throw new Error();
    localStorage.removeItem(pendingKey);
    pending = undefined;
    if (admitted.botId === botId) {
      if (admitted.operation === "create" && isSession(result.session)) {
        rememberSession(result.session.id);
        createForm.reset();
      } else if (admitted.operation === "name") nameForm.reset();
      else if (admitted.sessionId === sessionId) messageForm.reset();
    }
    notice.textContent =
      admitted.operation === "message"
        ? `Admitted to work ${result.workId}. Await its durable outcome.`
        : "Session saved.";
    await showChat(botId);
  } catch {
    notice.textContent = pending
      ? "Chat response unconfirmed. Retry chat request with its saved identity, including after reload."
      : "Could not save the request in this browser. Check local storage and retry.";
  } finally {
    sending = false;
    controls();
  }
}
createForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void submit("create", name.value);
});
nameForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void submit("name", rename.value);
});
messageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void submit("message", text.value);
});
retry.addEventListener("click", () => void submit());
