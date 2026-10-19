interface Outcome {
  kind: string;
  reply: string;
}
interface Run {
  id: string;
  state: string;
  outcome: Outcome | null;
  inputs: { id: string; text: string; recordedAt: string | null; outcome: Outcome | null }[];
  attempts: {
    id: string;
    configurationVersion: number;
    startedAt: string;
    endedAt: string | null;
  }[];
}
interface Task {
  id: string;
  origin: string;
  runs: Run[];
}
interface Detail {
  thread: { id: string; botId: string };
  tasks: Task[];
  messages: { id: string; runId: string; role: string; content: string }[];
}
interface Pending {
  botId: string;
  requestId: string;
  operation: "message" | "new-task" | "task";
  text: string;
  taskId?: string;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function outcome(value: unknown): boolean {
  return (
    value === null ||
    (record(value) && typeof value.kind === "string" && typeof value.reply === "string")
  );
}
function isDetail(value: unknown): value is Detail {
  return (
    record(value) &&
    record(value.thread) &&
    typeof value.thread.id === "string" &&
    Array.isArray(value.messages) &&
    value.messages.every(
      (message: unknown) =>
        record(message) &&
        [message.id, message.runId, message.role, message.content].every(
          (item) => typeof item === "string",
        ),
    ) &&
    Array.isArray(value.tasks) &&
    value.tasks.every(
      (task: unknown) =>
        record(task) &&
        typeof task.id === "string" &&
        typeof task.origin === "string" &&
        Array.isArray(task.runs) &&
        task.runs.every(
          (run: unknown) =>
            record(run) &&
            typeof run.id === "string" &&
            typeof run.state === "string" &&
            outcome(run.outcome) &&
            Array.isArray(run.inputs) &&
            run.inputs.every(
              (input: unknown) =>
                record(input) &&
                typeof input.id === "string" &&
                typeof input.text === "string" &&
                outcome(input.outcome),
            ) &&
            Array.isArray(run.attempts) &&
            run.attempts.every(
              (attempt: unknown) =>
                record(attempt) &&
                typeof attempt.id === "string" &&
                typeof attempt.configurationVersion === "number" &&
                typeof attempt.startedAt === "string" &&
                (attempt.endedAt === null || typeof attempt.endedAt === "string"),
            ),
        ),
    )
  );
}
function isPending(value: unknown): value is Pending {
  return (
    record(value) &&
    [value.botId, value.requestId, value.text].every((item) => typeof item === "string") &&
    ["message", "new-task", "task"].includes(value.operation as string) &&
    (value.operation !== "task" || typeof value.taskId === "string")
  );
}
function element<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
function paragraph(text: string): HTMLParagraphElement {
  const node = document.createElement("p");
  node.textContent = text;
  return node;
}
const panel = element("chat");
const selected = element("selected-chat");
const messages = element("thread-messages");
const works = element("chat-works");
const notice = element("chat-message");
const form = element<HTMLFormElement>("message-form");
const text = element<HTMLTextAreaElement>("message-text");
const target = element<HTMLSelectElement>("input-target");
const retry = element<HTMLButtonElement>("retry-chat");
const pendingKey = "mybots.pending-thread-input";
let botId: string | undefined;
let version = 0;
let sending = false;
let pending: Pending | undefined;
try {
  const saved: unknown = JSON.parse(localStorage.getItem(pendingKey) ?? "null");
  if (isPending(saved)) pending = saved;
} catch {
  /* Unreadable browser state has no request to recover. */
}
function controls(): void {
  for (const node of form.querySelectorAll<
    HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement
  >("input, textarea, select, button"))
    node.disabled = sending || !!pending;
  retry.hidden = !pending;
  retry.disabled = sending;
}
export async function showChat(selectedBotId: string | undefined): Promise<void> {
  if (botId !== selectedBotId) {
    botId = selectedBotId;
    text.value = "";
    target.replaceChildren();
    works.replaceChildren();
    messages.replaceChildren();
    selected.textContent = "";
  }
  panel.hidden = !botId;
  if (!botId) return;
  const current = ++version;
  controls();
  if (pending && !sending)
    notice.textContent = `Response unconfirmed for Bot ${pending.botId}. Retry the saved input to recover its Task/Run association.`;
  try {
    const response = await fetch(`/api/bots/${encodeURIComponent(botId)}/thread`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error();
    const detail: unknown = await response.json();
    if (!isDetail(detail)) throw new Error();
    if (current !== version) return;
    selected.textContent = `Thread ID: ${detail.thread.id}`;
    const priorTarget = target.value;
    target.replaceChildren(
      Object.assign(document.createElement("option"), {
        value: "",
        textContent: "Thread — continue chat",
      }),
    );
    for (const task of detail.tasks)
      if (task.runs.some((run) => ["queued", "active"].includes(run.state)))
        target.append(
          Object.assign(document.createElement("option"), {
            value: task.id,
            textContent: `Task ${task.id}`,
          }),
        );
    if ([...target.options].some((option) => option.value === priorTarget))
      target.value = priorTarget;
    messages.replaceChildren(
      ...detail.messages.map((message) => {
        const node = paragraph(`${message.role === "user" ? "You" : "Bot"}: ${message.content}`);
        const task = detail.tasks.find((task) => task.runs.some((run) => run.id === message.runId));
        const link = document.createElement("a");
        link.href = `#task-${task?.id}`;
        link.textContent = "View Task";
        node.append(document.createTextNode(" "), link);
        return node;
      }),
    );
    works.replaceChildren(
      ...detail.tasks.map((task) => {
        const article = document.createElement("article");
        article.id = `task-${task.id}`;
        article.dataset.taskId = task.id;
        article.append(paragraph(`Task ID: ${task.id} · Origin: ${task.origin}`));
        for (const run of task.runs) {
          article.append(
            paragraph(`Run ID: ${run.id}`),
            paragraph(`Execution: ${run.state}`),
            paragraph(`Outcome: ${run.outcome?.kind ?? "unresolved"}`),
          );
          if (run.outcome) article.append(paragraph(`Final: ${run.outcome.reply}`));
          if (run.state === "uncertain")
            article.append(
              paragraph(
                "Final evidence is missing. This Run needs owner inspection; new independent work can proceed after execution stops.",
              ),
            );
          const details = document.createElement("details");
          details.append(
            Object.assign(document.createElement("summary"), {
              textContent: "Inputs and Attempts",
            }),
          );
          for (const attempt of run.attempts)
            details.append(
              paragraph(
                `Attempt: ${attempt.id} · Configuration ${attempt.configurationVersion} · ${attempt.endedAt ? "stopped" : "executing"}`,
              ),
            );
          for (const input of run.inputs) {
            const node = paragraph(`You: ${input.text}`);
            node.className = "chat-input";
            details.append(node);
            details.append(
              paragraph(
                input.recordedAt ? "Recorded in Run ledger." : "Awaiting durable Run recording.",
              ),
            );
            if (input.outcome) details.append(paragraph(`Reply: ${input.outcome.reply}`));
          }
          article.append(details);
        }
        return article;
      }),
    );
  } catch {
    if (current === version)
      notice.textContent =
        "Thread state unavailable. Displayed results may be stale. Refresh to retry.";
  }
}
async function submit(newTask = false): Promise<void> {
  if (sending || !botId) return;
  sending = true;
  try {
    if (!pending) {
      const draft: Pending = {
        botId,
        requestId: crypto.randomUUID(),
        text: text.value,
        operation: newTask ? "new-task" : target.value ? "task" : "message",
        ...(target.value && !newTask ? { taskId: target.value } : {}),
      };
      localStorage.setItem(pendingKey, JSON.stringify(draft));
      pending = draft;
    }
    controls();
    const admitted = pending;
    const prefix = `/api/bots/${encodeURIComponent(admitted.botId)}`;
    const path =
      admitted.operation === "task"
        ? `${prefix}/tasks/${encodeURIComponent(admitted.taskId as string)}/inputs`
        : `${prefix}/thread/${admitted.operation === "new-task" ? "tasks" : "messages"}`;
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: admitted.requestId, text: admitted.text }),
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
          : "Input unavailable. Retry the same request.";
      return;
    }
    if (
      !record(result) ||
      result.requestId !== admitted.requestId ||
      typeof result.taskId !== "string" ||
      typeof result.runId !== "string" ||
      typeof result.messageId !== "string"
    )
      throw new Error();
    localStorage.removeItem(pendingKey);
    pending = undefined;
    if (admitted.botId === botId) text.value = "";
    notice.textContent = `Admitted to Task ${result.taskId}, Run ${result.runId}. Await its durable outcome.`;
    await showChat(botId);
  } catch {
    notice.textContent = pending
      ? "Thread response unconfirmed. Retry chat request with its saved identity, including after reload."
      : "Could not save the request. Check browser storage and retry.";
  } finally {
    sending = false;
    controls();
  }
}
form.addEventListener("submit", (event) => {
  event.preventDefault();
  void submit((event.submitter as HTMLElement | null)?.id === "new-task");
});
retry.addEventListener("click", () => void submit());
