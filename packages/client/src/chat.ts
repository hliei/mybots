import {
  clearBackgroundSelection,
  selectedBackgroundIds,
  setBackgroundBoundary,
  showHistory,
  showRunHistory,
} from "./history.ts";

interface Outcome {
  kind: string;
  reply: string;
  truncated?: boolean;
}
interface Run {
  id: string;
  state: string;
  held?: boolean;
  stopError?: string | null;
  backgroundBoundary: number;
  references: { id: string; role: string; text: string }[];
  outcome: Outcome | null;
  lateEvidence?: { text: string }[];
  inputs: {
    id: string;
    text: string;
    truncated?: boolean;
    recordedAt: string | null;
    outcome: Outcome | null;
  }[];
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
  thread: { id: string; botId: string; backgroundBoundary: number };
  tasks: Task[];
  messages: { id: string; runId: string; role: string; content: string }[];
}
interface Pending {
  botId: string;
  requestId: string;
  operation: "message" | "new-task" | "task" | "stop" | "retry" | "close" | "reset";
  text: string;
  taskId?: string;
  runId?: string;
  selectedMessageIds?: string[];
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
    typeof value.thread.backgroundBoundary === "number" &&
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
            typeof run.backgroundBoundary === "number" &&
            Array.isArray(run.references) &&
            run.references.every(
              (reference: unknown) =>
                record(reference) &&
                [reference.id, reference.role, reference.text].every(
                  (item) => typeof item === "string",
                ),
            ) &&
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
    ["message", "new-task", "task", "stop", "retry", "close", "reset"].includes(
      value.operation as string,
    ) &&
    (value.selectedMessageIds === undefined ||
      (Array.isArray(value.selectedMessageIds) &&
        value.selectedMessageIds.every((id: unknown) => typeof id === "string"))) &&
    (value.operation !== "task" || typeof value.taskId === "string") &&
    (!["stop", "retry", "close"].includes(value.operation as string) ||
      typeof value.runId === "string")
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
const resetBackground = element<HTMLButtonElement>("reset-background");
const pendingKey = "mybots.pending-thread-input";
let botId: string | undefined;
let version = 0;
let refreshTimer = 0;
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
  window.clearTimeout(refreshTimer);
  if (botId !== selectedBotId) {
    botId = selectedBotId;
    text.value = "";
    target.replaceChildren();
    works.replaceChildren();
    messages.replaceChildren();
    selected.textContent = "";
  }
  panel.hidden = !botId;
  if (!botId) {
    await showHistory(undefined, []);
    return;
  }
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
    setBackgroundBoundary(detail.thread.backgroundBoundary);
    selected.textContent = `Thread ID: ${detail.thread.id} · Chat background boundary: ${detail.thread.backgroundBoundary}`;
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
    await showHistory(
      botId,
      detail.tasks.flatMap((task) =>
        task.runs.filter((run) => run.state === "active").map((run) => run.id),
      ),
    );
    if (current !== version) return;
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
            paragraph(`Captured background boundary: ${run.backgroundBoundary}`),
            paragraph(
              `Run background: ${run.references.length ? run.references.map((reference) => reference.text).join(" · ") : "none"}`,
            ),
            paragraph(`Outcome: ${run.outcome?.kind ?? "unresolved"}`),
          );
          if (run.outcome)
            article.append(
              paragraph(
                `Final: ${run.outcome.reply}${run.outcome.truncated ? " [Excerpt; inspect Run evidence for the original.]" : ""}`,
              ),
            );
          if (run.state === "stopping")
            article.append(
              paragraph(
                run.stopError ??
                  "Stopping until termination is confirmed. This Bot keeps its execution slot.",
              ),
            );
          if (run.state === "uncertain")
            article.append(
              paragraph(
                "Final evidence is missing. This Run is held until you retry or close it. Unrelated Tasks can proceed.",
              ),
            );
          if (run.held)
            article.append(
              paragraph(
                "Held for a later Routine occurrence, which is not scheduled in this version.",
              ),
            );
          for (const late of run.lateEvidence ?? [])
            article.append(paragraph(`Late result: ${late.text}`));
          const details = document.createElement("details");
          details.append(
            Object.assign(document.createElement("summary"), {
              textContent: "Input and Attempt previews (first five)",
            }),
          );
          for (const attempt of run.attempts)
            details.append(
              paragraph(
                `Attempt: ${attempt.id} · Configuration ${attempt.configurationVersion} · ${attempt.endedAt ? "stopped" : "executing"}`,
              ),
            );
          for (const input of run.inputs) {
            const node = paragraph(
              `You: ${input.text}${input.truncated ? " [Excerpt; inspect Run inputs for the original.]" : ""}`,
            );
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
          const inspect = document.createElement("button");
          inspect.type = "button";
          inspect.textContent = "Inspect Run evidence";
          inspect.addEventListener("click", () => void showRunHistory(run.id));
          article.append(inspect);
          const runnable =
            run.state === "queued" || run.state === "active" || run.state === "stopping";
          if (runnable) article.append(runButton("Stop run", "stop", task.id, run.id));
          if (run.state === "uncertain" || run.state === "closed")
            article.append(runButton("Retry run", "retry", task.id, run.id));
          if (run.state === "uncertain")
            article.append(runButton("Close uncertain run", "close", task.id, run.id));
        }
        return article;
      }),
    );
    if (
      current === version &&
      detail.tasks.some((task) => task.runs.some((run) => run.state === "stopping"))
    )
      refreshTimer = window.setTimeout(() => {
        if (current === version && botId) void showChat(botId);
      }, 200);
  } catch {
    if (current === version)
      notice.textContent =
        "Thread state unavailable. Displayed results may be stale. Refresh to retry.";
  }
}
function runButton(
  label: string,
  operation: "stop" | "retry" | "close",
  taskId: string,
  runId: string,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.disabled = sending || !!pending;
  button.addEventListener("click", () => {
    if (!botId || sending || pending) return;
    pending = { botId, requestId: crypto.randomUUID(), operation, text: "", taskId, runId };
    localStorage.setItem(pendingKey, JSON.stringify(pending));
    void submit();
  });
  return button;
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
        ...(selectedBackgroundIds().length ? { selectedMessageIds: selectedBackgroundIds() } : {}),
      };
      localStorage.setItem(pendingKey, JSON.stringify(draft));
      pending = draft;
    }
    controls();
    const admitted = pending;
    const prefix = `/api/bots/${encodeURIComponent(admitted.botId)}`;
    const runOperation =
      admitted.operation === "stop" ||
      admitted.operation === "retry" ||
      admitted.operation === "close";
    const path =
      admitted.operation === "reset"
        ? `${prefix}/thread/reset`
        : runOperation
          ? `${prefix}/runs/${encodeURIComponent(admitted.runId as string)}/${admitted.operation}`
          : admitted.operation === "task"
            ? `${prefix}/tasks/${encodeURIComponent(admitted.taskId as string)}/inputs`
            : `${prefix}/thread/${admitted.operation === "new-task" ? "tasks" : "messages"}`;
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        admitted.operation === "reset" || runOperation
          ? { requestId: admitted.requestId }
          : {
              requestId: admitted.requestId,
              text: admitted.text,
              ...(admitted.selectedMessageIds
                ? { selectedMessageIds: admitted.selectedMessageIds }
                : {}),
            },
      ),
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
      (admitted.operation === "reset"
        ? typeof result.backgroundBoundary !== "number"
        : typeof result.taskId !== "string" ||
          typeof result.runId !== "string" ||
          (!runOperation && typeof result.messageId !== "string"))
    )
      throw new Error();
    localStorage.removeItem(pendingKey);
    pending = undefined;
    if (admitted.selectedMessageIds?.length) clearBackgroundSelection();
    if (admitted.botId === botId && !runOperation && admitted.operation !== "reset")
      text.value = "";
    notice.textContent =
      admitted.operation === "reset"
        ? `Chat background boundary is ${result.backgroundBoundary}. Existing Runs keep their captured background.`
        : runOperation
          ? `Recorded ${admitted.operation} for Run ${result.runId}. Refresh after the Run state changes.`
          : `Admitted to Task ${result.taskId}, Run ${result.runId}. Await its durable outcome.`;
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
resetBackground.addEventListener("click", () => {
  if (!botId || sending || pending) return;
  pending = { botId, requestId: crypto.randomUUID(), operation: "reset", text: "" };
  localStorage.setItem(pendingKey, JSON.stringify(pending));
  void submit();
});
