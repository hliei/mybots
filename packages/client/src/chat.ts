import { showAttachments } from "./attachments.ts";
import { showCollaboration } from "./collaboration.ts";
import {
  clearBackgroundSelection,
  selectedBackgroundIds,
  setBackgroundBoundary,
  showHistory,
  showRunHistory,
} from "./history.ts";
import { showRoutines } from "./routines.ts";
import { openDetail } from "./shell.ts";

interface Outcome {
  kind: string;
  reply: string;
  truncated?: boolean;
}
interface Publication {
  id: string;
  attemptId: string;
  text: string;
  truncated: boolean;
  createdAt: string;
}
interface SelectedResult extends Publication {
  botId: string;
  taskId: string;
  runId: string;
  delegationId: string | null;
  originatingRunId: string | null;
  artifacts: { id: string; name: string; bytes: number }[];
}
interface Question {
  id: string;
  text: string;
  state: "pending" | "answered" | "expired" | "cancelled";
  answer: string | null;
  deadline: string | null;
}
interface Notice {
  id: string;
  kind: "question" | "approval" | "outcome" | "uncertain";
  questionId: string | null;
  requestId: string | null;
  routineId: string | null;
  priorRunId: string | null;
  sourceChain: {
    botId: string;
    taskId: string;
    runId: string;
    delegationId: string;
    locator: string;
  }[];
  botId: string;
  taskId: string;
  runId: string;
  summary: string;
  locator: string;
  eligibility: "eligible" | "suppressed";
  state: "pending" | "delivered" | "failed" | "suppressed";
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  acceptedAt: string | null;
}
interface TelegramTopic {
  chatId: string;
  topicId: string | null;
  state: "mapped" | "repairable";
  failure: string | null;
}
interface DelegationFile {
  kind: "attachment" | "artifact";
  id: string;
  filename: string;
  bytes: number;
}
interface Approval {
  id: string;
  operation: "delegate";
  targetBotId: string;
  text: string;
  deadline: string | null;
  state: string;
  decision: "approve" | "deny" | null;
}
interface Delegation {
  id: string;
  sourceBotId: string;
  targetBotId: string;
  parentTaskId: string;
  parentRunId: string;
  originatingRunId: string;
  childTaskId: string | null;
  childRunId: string | null;
  revokedAt: string | null;
  approval: Approval | null;
  text: string;
  state: string;
  result: string | null;
  files: DelegationFile[];
}
interface Run {
  id: string;
  state: string;
  budget: { limitMs: number; activeMs: number; exhaustedAt: string | null };
  held?: boolean;
  stopError?: string | null;
  admissionClass: "interactive" | "background" | null;
  queuePosition: number | null;
  waitReason: string | null;
  backgroundBoundary: number;
  references: { id: string; role: string; text: string }[];
  outcome: Outcome | null;
  questions: Question[];
  delegations: Delegation[];
  progress: Publication[];
  selectedResults: SelectedResult[];
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
  admission: { activeLimit: number; activeCount: number };
  collaboration: { targetBotId: string; name: string; mode: "deny" | "ask-each-time" | "allow" }[];
  notices: Notice[];
  telegramTopic: TelegramTopic | null;
  thread: { id: string; botId: string; backgroundBoundary: number };
  tasks: Task[];
  messages: { id: string; runId: string; role: string; content: string }[];
}
interface Pending {
  botId: string;
  requestId: string;
  operation:
    | "message"
    | "new-task"
    | "task"
    | "stop"
    | "retry"
    | "close"
    | "reset"
    | "answer"
    | "decision"
    | "resend"
    | "repair";
  text: string;
  questionId?: string;
  noticeId?: string;
  approval?: Approval;
  files?: DelegationFile[];
  decision?: "approve" | "deny";
  taskId?: string;
  runId?: string;
  selectedMessageIds?: string[];
  draftRevision?: string;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validNotice(value: unknown): value is Notice {
  return (
    record(value) &&
    [value.id, value.botId, value.taskId, value.runId, value.summary, value.locator].every(
      (item) => typeof item === "string",
    ) &&
    ["question", "approval", "outcome", "uncertain"].includes(value.kind as string) &&
    [value.questionId, value.requestId, value.routineId, value.priorRunId].every(
      (item) => item === null || typeof item === "string",
    ) &&
    Array.isArray(value.sourceChain) &&
    value.sourceChain.every(
      (source) =>
        record(source) &&
        [source.botId, source.taskId, source.runId, source.delegationId, source.locator].every(
          (item) => typeof item === "string",
        ),
    ) &&
    (value.eligibility === "eligible" || value.eligibility === "suppressed") &&
    ["pending", "delivered", "failed", "suppressed"].includes(value.state as string) &&
    typeof value.attempts === "number" &&
    (value.nextAttemptAt === null || typeof value.nextAttemptAt === "string") &&
    (value.lastError === null || typeof value.lastError === "string") &&
    (value.acceptedAt === null || typeof value.acceptedAt === "string")
  );
}
function validTopic(value: unknown): value is TelegramTopic {
  return (
    record(value) &&
    typeof value.chatId === "string" &&
    (value.topicId === null || typeof value.topicId === "string") &&
    (value.state === "mapped" || value.state === "repairable") &&
    (value.failure === null || typeof value.failure === "string")
  );
}
function validDelegationFile(value: unknown): value is DelegationFile {
  return (
    record(value) &&
    (value.kind === "attachment" || value.kind === "artifact") &&
    typeof value.id === "string" &&
    typeof value.filename === "string" &&
    typeof value.bytes === "number"
  );
}
function validApproval(value: unknown): value is Approval {
  return (
    record(value) &&
    typeof value.id === "string" &&
    value.operation === "delegate" &&
    typeof value.targetBotId === "string" &&
    typeof value.text === "string" &&
    (value.deadline === null || typeof value.deadline === "string") &&
    typeof value.state === "string" &&
    (value.decision === null || value.decision === "approve" || value.decision === "deny")
  );
}
function publication(value: unknown): value is Publication {
  return (
    record(value) &&
    [value.id, value.attemptId, value.text, value.createdAt].every(
      (item) => typeof item === "string",
    ) &&
    typeof value.truncated === "boolean"
  );
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
    record(value.admission) &&
    typeof value.admission.activeLimit === "number" &&
    typeof value.admission.activeCount === "number" &&
    record(value.thread) &&
    Array.isArray(value.collaboration) &&
    value.collaboration.every(
      (peer: unknown) =>
        record(peer) &&
        typeof peer.targetBotId === "string" &&
        typeof peer.name === "string" &&
        (peer.mode === "deny" || peer.mode === "allow" || peer.mode === "ask-each-time"),
    ) &&
    typeof value.thread.id === "string" &&
    typeof value.thread.backgroundBoundary === "number" &&
    Array.isArray(value.notices) &&
    value.notices.every(validNotice) &&
    (value.telegramTopic === null || validTopic(value.telegramTopic)) &&
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
            record(run.budget) &&
            typeof run.budget.limitMs === "number" &&
            typeof run.budget.activeMs === "number" &&
            (run.budget.exhaustedAt === null || typeof run.budget.exhaustedAt === "string") &&
            (run.admissionClass === null ||
              run.admissionClass === "interactive" ||
              run.admissionClass === "background") &&
            (run.queuePosition === null || typeof run.queuePosition === "number") &&
            (run.waitReason === null || typeof run.waitReason === "string") &&
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
            Array.isArray(run.questions) &&
            run.questions.every(
              (q: unknown) =>
                record(q) &&
                typeof q.id === "string" &&
                typeof q.text === "string" &&
                ["pending", "answered", "expired", "cancelled"].includes(q.state as string) &&
                (q.answer === null || typeof q.answer === "string") &&
                (q.deadline === null || typeof q.deadline === "string"),
            ) &&
            Array.isArray(run.delegations) &&
            run.delegations.every(
              (row: unknown) =>
                record(row) &&
                [
                  row.id,
                  row.sourceBotId,
                  row.targetBotId,
                  row.parentTaskId,
                  row.parentRunId,
                  row.originatingRunId,
                  row.text,
                  row.state,
                ].every((item) => typeof item === "string") &&
                (row.childTaskId === null || typeof row.childTaskId === "string") &&
                (row.childRunId === null || typeof row.childRunId === "string") &&
                (row.revokedAt === null || typeof row.revokedAt === "string") &&
                (row.approval === null || validApproval(row.approval)) &&
                (row.result === null || typeof row.result === "string") &&
                Array.isArray(row.files) &&
                row.files.every(validDelegationFile),
            ) &&
            Array.isArray(run.progress) &&
            run.progress.every(publication) &&
            Array.isArray(run.selectedResults) &&
            run.selectedResults.every(
              (result: unknown) =>
                publication(result) &&
                record(result) &&
                [result.botId, result.taskId, result.runId].every((id) => typeof id === "string") &&
                (result.delegationId === null || typeof result.delegationId === "string") &&
                (result.originatingRunId === null || typeof result.originatingRunId === "string") &&
                Array.isArray(result.artifacts) &&
                result.artifacts.every(
                  (file: unknown) =>
                    record(file) &&
                    typeof file.id === "string" &&
                    typeof file.name === "string" &&
                    typeof file.bytes === "number",
                ),
            ) &&
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
    [
      "message",
      "new-task",
      "task",
      "stop",
      "retry",
      "close",
      "reset",
      "answer",
      "decision",
      "resend",
      "repair",
    ].includes(value.operation as string) &&
    (value.runId === undefined || typeof value.runId === "string") &&
    (value.draftRevision === undefined || typeof value.draftRevision === "string") &&
    (value.operation !== "resend" || typeof value.noticeId === "string") &&
    (value.selectedMessageIds === undefined ||
      (Array.isArray(value.selectedMessageIds) &&
        value.selectedMessageIds.every((id: unknown) => typeof id === "string"))) &&
    (value.operation !== "answer" ||
      (typeof value.questionId === "string" && typeof value.runId === "string")) &&
    (value.operation !== "decision" ||
      (typeof value.runId === "string" &&
        validApproval(value.approval) &&
        (value.decision === "approve" || value.decision === "deny"))) &&
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
interface Draft {
  text: string;
  revision: string;
  target: string;
  runId?: string;
}
const drafts = new Map<string, Draft>();
const draftKey = (id: string) => `mybots.composer-draft.${id}`;
function readDraft(id: string): Draft {
  const current = drafts.get(id);
  if (current) return current;
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(draftKey(id)) ?? "null");
    if (record(saved) && typeof saved.text === "string" && typeof saved.revision === "string") {
      const draft = {
        text: saved.text,
        revision: saved.revision,
        target: typeof saved.target === "string" ? saved.target : "",
        ...(typeof saved.runId === "string" ? { runId: saved.runId } : {}),
      };
      drafts.set(id, draft);
      return draft;
    }
  } catch {
    /* An unreadable draft must not prevent conversation inspection. */
  }
  return { text: "", revision: "", target: "" };
}
function writeDraft(id: string, draft: Draft): void {
  drafts.set(id, draft);
  try {
    localStorage.setItem(draftKey(id), JSON.stringify(draft));
  } catch {
    notice.textContent = "Could not save this draft in browser storage. Keep this page open.";
  }
}
function saveDraft(): void {
  if (!botId) return;
  writeDraft(botId, {
    text: text.value,
    revision: crypto.randomUUID(),
    target: target.value,
    runId: target.selectedOptions[0]?.dataset.runId,
  });
}
function growDraft(): void {
  text.style.height = "auto";
  text.style.height = `${Math.min(180, text.scrollHeight)}px`;
}
let composerWidth = 0;
new ResizeObserver(([entry]) => {
  if (entry && entry.contentRect.width !== composerWidth) {
    composerWidth = entry.contentRect.width;
    growDraft();
  }
}).observe(form);
text.addEventListener("input", () => {
  saveDraft();
  growDraft();
  controls();
});
const targetLabel = element("composer-target-label");
const menu = element("composer-menu");
const actions = element<HTMLButtonElement>("message-actions");
function closeComposerMenu(): void {
  menu.hidden = true;
  actions.setAttribute("aria-expanded", "false");
}
function resetTargets(): void {
  target.replaceChildren(
    Object.assign(document.createElement("option"), {
      value: "",
      textContent: "Thread — continue chat",
    }),
    Object.assign(document.createElement("option"), {
      value: "new-task",
      textContent: "New independent task",
    }),
  );
}
function showTarget(): void {
  element("composer-target").hidden = !target.value;
  const option = target.selectedOptions[0];
  targetLabel.textContent =
    target.value === "new-task"
      ? "New independent task"
      : target.value
        ? `Add to ${option?.textContent ?? target.value}`
        : "";
  controls();
}
target.addEventListener("change", () => {
  saveDraft();
  showTarget();
});
actions.addEventListener("click", () => {
  menu.hidden = !menu.hidden;
  actions.setAttribute("aria-expanded", String(!menu.hidden));
  if (!menu.hidden) element("new-task").focus();
});
element("new-task").addEventListener("click", () => {
  target.value = "new-task";
  saveDraft();
  showTarget();
  closeComposerMenu();
  text.focus();
});
element("return-thread").addEventListener("click", () => {
  target.value = "";
  saveDraft();
  showTarget();
  text.focus();
});
document.addEventListener("click", (event) => {
  if (event.target instanceof Node && !event.target.parentElement?.closest(".composer-actions"))
    closeComposerMenu();
});
form.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !menu.hidden) {
    closeComposerMenu();
    actions.focus();
    event.stopPropagation();
  }
});
let composing = false;
text.addEventListener("compositionstart", () => {
  composing = true;
});
text.addEventListener("compositionend", () => {
  composing = false;
});
text.addEventListener("keydown", (event) => {
  if (
    event.key !== "Enter" ||
    event.shiftKey ||
    event.isComposing ||
    composing ||
    event.keyCode === 229
  )
    return;
  event.preventDefault();
  form.requestSubmit();
});
let botId: string | undefined;
let availability: "active" | "disabled" | "deleted" = "active";
let version = 0;
let refreshTimer = 0;
let locatedQuestion = false;
let sending = false;
let hostAvailable = false;
export function setHostAvailable(value: boolean): void {
  hostAvailable = value;
  controls();
}
let pending: Pending | undefined;
const answerDrafts = new Map<string, string>();
try {
  const saved: unknown = JSON.parse(localStorage.getItem(pendingKey) ?? "null");
  if (isPending(saved)) pending = saved;
} catch {
  /* Unreadable browser state has no request to recover. */
}
function controls(): void {
  const admitting = !!botId && availability === "active" && hostAvailable;
  for (const node of form.querySelectorAll<
    HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement
  >("input, textarea, select, button"))
    node.disabled = !admitting || sending || !!pending;
  text.disabled = !botId || availability !== "active";
  for (const button of form.querySelectorAll<HTMLButtonElement>('button[type="submit"]'))
    button.disabled ||=
      !text.value.trim() ||
      !text.validity.valid ||
      target.selectedOptions[0]?.dataset.unavailable === "true";
  resetBackground.disabled = !admitting || sending || !!pending;
  retry.hidden = !pending;
  retry.disabled = sending || !hostAvailable;
}
export async function showChat(
  selectedBotId: string | undefined,
  next?: "active" | "disabled" | "deleted",
): Promise<void> {
  window.clearTimeout(refreshTimer);
  if (!selectedBotId) availability = "active";
  else if (next) availability = next;
  if (botId !== selectedBotId) {
    clearBackgroundSelection();
    botId = selectedBotId;
    text.value = selectedBotId ? readDraft(selectedBotId).text : "";
    growDraft();
    closeComposerMenu();
    const draft = selectedBotId ? readDraft(selectedBotId) : undefined;
    resetTargets();
    if (draft?.target && draft.target !== "new-task") {
      const option = Object.assign(document.createElement("option"), {
        value: draft.target,
        textContent: `Task ${draft.target} · unavailable — checking target`,
      });
      option.dataset.unavailable = "true";
      if (draft.runId) option.dataset.runId = draft.runId;
      target.append(option);
    }
    target.value = draft?.target ?? "";
    showTarget();
    works.replaceChildren();
    messages.replaceChildren(paragraph("Loading conversation…"));
    selected.textContent = "";
  }
  panel.hidden = !botId;
  growDraft();
  if (!botId) {
    showCollaboration(undefined, [], () => undefined);
    await showHistory(undefined, []);
    await showAttachments(undefined, []);
    return;
  }
  const current = ++version;
  controls();
  if (pending && !sending)
    notice.textContent = `Response unconfirmed for Bot ${pending.botId}. Retry the saved input to recover its Task/Run association.`;
  else if (availability !== "active")
    notice.textContent =
      availability === "disabled"
        ? "This Bot is disabled. New chat, tasks, retries, Routines, and delegations are not admitted."
        : "This Bot is deleted. Its identity remains for inspection and does not admit new work.";
  else if (notice.textContent?.startsWith("This Bot is ")) notice.textContent = "";
  try {
    const pendingRoutine = await showRoutines(
      botId,
      () => {
        if (botId) void showChat(botId);
      },
      availability,
    );
    if (current !== version) return;
    const response = await fetch(`/api/bots/${encodeURIComponent(botId)}/thread`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error();
    const detail: unknown = await response.json();
    if (!isDetail(detail)) throw new Error();
    if (current !== version) return;
    showCollaboration(
      botId,
      detail.collaboration,
      () => {
        if (botId) void showChat(botId);
      },
      availability !== "deleted",
    );
    setBackgroundBoundary(detail.thread.backgroundBoundary);
    selected.textContent = `Thread ID: ${detail.thread.id} · Chat background boundary: ${detail.thread.backgroundBoundary}. Host execution: ${detail.admission.activeCount} of ${detail.admission.activeLimit} active.`;
    const priorTarget = target.value;
    const priorRun = target.selectedOptions[0]?.dataset.runId;
    resetTargets();
    for (const task of detail.tasks) {
      const run = task.runs.at(-1);
      if (run && ["queued", "active", "waiting"].includes(run.state)) {
        const option = Object.assign(document.createElement("option"), {
          value: task.id,
          textContent: `Task ${task.id}`,
        });
        option.dataset.runId = run.id;
        target.append(option);
      }
    }
    if (priorTarget && priorTarget !== "new-task") {
      let option = [...target.options].find((option) => option.value === priorTarget);
      if (!option || (priorRun && priorRun !== option.dataset.runId)) {
        option?.remove();
        option = Object.assign(document.createElement("option"), {
          value: priorTarget,
          textContent: `Task ${priorTarget} · unavailable — select a target again`,
        });
        option.dataset.unavailable = "true";
        if (priorRun) option.dataset.runId = priorRun;
        target.append(option);
      }
    }
    target.value = priorTarget;
    showTarget();
    await showHistory(
      botId,
      detail.tasks.flatMap((task) =>
        task.runs.filter((run) => run.state === "active").map((run) => run.id),
      ),
      detail.tasks
        .filter((task) => task.origin === "chat")
        .flatMap((task) => task.runs.map((run) => run.id)),
    );
    if (current !== version) return;
    await showAttachments(
      botId,
      detail.tasks.map((task) => task.id),
    );
    if (current !== version) return;
    if (
      document.activeElement instanceof HTMLTextAreaElement &&
      works.contains(document.activeElement)
    ) {
      refreshTimer = window.setTimeout(() => {
        if (current === version && botId) void showChat(botId);
      }, 200);
      return;
    }
    works.replaceChildren(
      ...(detail.telegramTopic ? [topicPanel(detail.telegramTopic)] : []),
      ...detail.tasks.map((task) => {
        const article = document.createElement("article");
        article.id = `task-${task.id}`;
        article.dataset.taskId = task.id;
        article.append(paragraph(`Task ID: ${task.id} · Origin: ${task.origin}`));
        for (const run of task.runs) {
          article.append(
            paragraph(`Run ID: ${run.id}`),
            paragraph(
              run.state === "queued" && run.admissionClass && run.queuePosition
                ? `Execution: queued · ${run.admissionClass} · position ${run.queuePosition}`
                : `Execution: ${run.state}`,
            ),
            paragraph(
              `Active budget: ${(run.budget.activeMs / 60000).toFixed(1)} / ${run.budget.limitMs / 60000} minutes${run.budget.exhaustedAt ? " · exhausted; completed effects are retained" : ""}`,
            ),
            paragraph(`Captured background boundary: ${run.backgroundBoundary}`),
            paragraph(
              `Run background: ${run.references.length ? run.references.map((reference) => reference.text).join(" · ") : "none"}`,
            ),
            ...run.progress.map((note) =>
              paragraph(
                `Progress · Attempt ${note.attemptId}: ${note.text}${note.truncated ? " [Excerpt]" : ""}`,
              ),
            ),
            ...run.selectedResults.map((result) => {
              const section = document.createElement("section");
              section.append(
                paragraph(
                  `Selected result · Attempt ${result.attemptId}: ${result.text}${result.truncated ? " [Excerpt]" : ""}`,
                ),
                paragraph(
                  `Bot: ${result.botId} · Task: ${result.taskId} · Run: ${result.runId}${result.delegationId ? ` · Delegation: ${result.delegationId}` : ""}${result.originatingRunId ? ` · Originating Run: ${result.originatingRunId}` : ""}`,
                ),
              );
              for (const file of result.artifacts) {
                const download = document.createElement("a");
                download.href = `/api/bots/${encodeURIComponent(result.botId)}/runs/${encodeURIComponent(result.runId)}/artifacts/${encodeURIComponent(file.id)}`;
                download.download = file.name.split("/").at(-1) as string;
                download.textContent = `Download ${file.name} (${file.bytes} bytes)`;
                const row = document.createElement("p");
                row.append(download);
                section.append(row);
              }
              return section;
            }),
            paragraph(`Outcome: ${run.outcome?.kind ?? "unresolved"}`),
          );
          for (const question of run.questions)
            article.append(
              questionCard(
                task.id,
                run,
                question,
                detail.notices.find((notice) => notice.questionId === question.id),
              ),
            );
          for (const notice of detail.notices.filter(
            (notice) => notice.runId === run.id && notice.kind !== "question",
          ))
            article.append(noticeCard(notice));
          for (const delegation of run.delegations) article.append(delegationCard(run, delegation));
          if (run.outcome)
            article.append(
              paragraph(
                `Final: ${run.outcome.reply}${run.outcome.truncated ? " [Excerpt; inspect Run evidence for the original.]" : ""}`,
              ),
            );
          if (run.state === "waiting")
            article.append(
              paragraph(
                "Durable wait released this Bot's execution slot. Resumed work waits for the active Attempt to finish.",
              ),
            );
          const executing = run.attempts.find((attempt) => attempt.endedAt === null);
          if (executing) article.append(paragraph(`Attempt ${executing.id} is executing.`));
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
                run.state === "waiting"
                  ? "Owned child outcome is uncertain. Inspect the child Task to retry or close its Run."
                  : "Outcome uncertainty holds this work and any later Routine occurrence.",
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
          const runnable = ["queued", "active", "stopping", "waiting"].includes(run.state);
          if (runnable) article.append(runButton("Stop run", "stop", task.id, run.id));
          if (run.state === "uncertain" || run.state === "closed") {
            const retryRun = runButton("Retry run", "retry", task.id, run.id);
            retryRun.disabled = availability !== "active";
            article.append(retryRun);
          }
          if (run.state === "uncertain")
            article.append(runButton("Close uncertain run", "close", task.id, run.id));
        }
        return article;
      }),
    );
    if (!locatedQuestion && location.hash) {
      const target = [
        ...works.querySelectorAll<HTMLElement>(
          "[data-question-id], [data-approval-id], [data-task-id]",
        ),
      ].find((section) => location.hash === `#${encodeURIComponent(section.id)}`);
      if (target) {
        openDetail("tasks");
        target.tabIndex = -1;
        target.focus();
        locatedQuestion = true;
      }
    }
    if (
      current === version &&
      (pendingRoutine ||
        detail.notices.some((notice) => notice.state === "pending") ||
        detail.tasks.some((task) =>
          task.runs.some((run) => ["active", "queued", "stopping", "waiting"].includes(run.state)),
        ))
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
function delegationCard(run: Run, delegation: Delegation): HTMLElement {
  const section = document.createElement("section");
  section.dataset.delegationId = delegation.id;
  section.append(
    paragraph(
      `Delegation ${delegation.id}: ${delegation.sourceBotId} → ${delegation.targetBotId} · ${delegation.state}`,
    ),
    paragraph(`Parent Task ${delegation.parentTaskId} · Parent Run ${delegation.parentRunId}`),
    paragraph(`Originating Run ${delegation.originatingRunId}`),
    paragraph(`Selected text: ${delegation.text}`),
  );
  if (delegation.files.length > 0)
    section.append(
      paragraph(
        `Selected files: ${delegation.files
          .map((file) => `${file.kind} ${file.filename} (${file.bytes} bytes)`)
          .join(", ")}`,
      ),
    );
  if (delegation.childTaskId && delegation.childRunId)
    section.append(
      paragraph(`Child Task ${delegation.childTaskId} · Child Run ${delegation.childRunId}`),
    );
  if (delegation.revokedAt)
    section.append(
      paragraph(
        `Collaboration revoked at ${delegation.revokedAt}. Cancellation requires confirmed termination; unresolved outcomes remain uncertain.`,
      ),
    );
  if (delegation.result) section.append(paragraph(`Delegation result: ${delegation.result}`));
  if (delegation.approval) section.append(approvalCard(delegation, delegation.approval, run));
  return section;
}
function approvalCard(source: Delegation, approval: Approval, run: Run): HTMLElement {
  const section = document.createElement("section");
  section.dataset.approvalId = approval.id;
  section.id = `approval-${approval.id}`;
  section.append(
    paragraph(`Action approval ${approval.id} · ${approval.state}`),
    paragraph(`Operation: ${approval.operation} · Target Bot: ${approval.targetBotId}`),
    paragraph(`Inputs: ${approval.text}`),
    paragraph(`Source Task ${source.parentTaskId} · Run ${source.parentRunId}`),
    paragraph(
      approval.deadline
        ? `Deadline: ${approval.deadline}`
        : "Waits for your decision without a deadline.",
    ),
  );
  if (approval.decision) section.append(paragraph(`Owner decision: ${approval.decision}`));
  if (approval.state === "expired")
    section.append(
      paragraph(
        "Approval expired without executing. This Run needs owner attention. Stop it before retrying.",
      ),
    );
  if (approval.state === "stale")
    section.append(
      paragraph(
        "Approval is stale or no longer permitted. A new request and decision are required.",
      ),
    );
  if (
    approval.state === "pending" &&
    source.parentRunId === run.id &&
    ["active", "waiting"].includes(run.state)
  ) {
    for (const decision of ["approve", "deny"] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = decision === "approve" ? "Approve action" : "Deny action";
      button.disabled = sending || !!pending;
      button.addEventListener("click", () => {
        if (!botId || sending || pending) return;
        pending = {
          botId,
          taskId: source.parentTaskId,
          runId: source.parentRunId,
          requestId: crypto.randomUUID(),
          operation: "decision",
          text: approval.text,
          approval,
          files: source.files,
          decision,
        };
        localStorage.setItem(pendingKey, JSON.stringify(pending));
        void submit();
      });
      section.append(button);
    }
  }
  return section;
}

function topicPanel(topic: TelegramTopic): HTMLElement {
  const section = document.createElement("section");
  section.dataset.telegramTopic = topic.state;
  section.append(
    paragraph(
      `Telegram topic: ${topic.state}${topic.topicId ? ` · ${topic.topicId}` : ""}${topic.chatId ? ` · chat ${topic.chatId}` : ""}`,
    ),
  );
  if (topic.failure) section.append(paragraph(topic.failure));
  if (topic.state === "repairable") {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Repair Telegram topic";
    button.disabled = sending || !!pending || availability === "deleted";
    button.addEventListener("click", () => {
      if (!botId || sending || pending) return;
      pending = { botId, requestId: crypto.randomUUID(), operation: "repair", text: "" };
      localStorage.setItem(pendingKey, JSON.stringify(pending));
      void submit();
    });
    section.append(button);
  }
  return section;
}
function noticeCard(notice: Notice): HTMLElement {
  const section = document.createElement("section");
  section.dataset.noticeState = notice.state;
  section.dataset.noticeId = notice.id;
  section.append(paragraph(`Notice: ${notice.kind} · ${notice.summary}`));
  if (notice.routineId) section.append(paragraph(`Routine: ${notice.routineId}`));
  if (notice.priorRunId) section.append(paragraph(`Explicit retry of Run: ${notice.priorRunId}`));
  for (const source of notice.sourceChain) {
    const link = document.createElement("a");
    link.href = source.locator;
    link.textContent = `Source Bot: ${source.botId} · Task: ${source.taskId} · Run: ${source.runId} · Delegation: ${source.delegationId}`;
    const row = document.createElement("p");
    row.append(link);
    section.append(row);
  }
  section.append(
    paragraph(
      `Telegram notice: ${notice.state} · ${notice.attempts} of 3 attempts${notice.nextAttemptAt ? ` · next ${notice.nextAttemptAt}` : ""}`,
    ),
    paragraph(
      `Bot: ${notice.botId} · Task: ${notice.taskId} · Run: ${notice.runId}${notice.requestId ? ` · Request: ${notice.requestId}` : ""}`,
    ),
    paragraph(`Local client: ${notice.locator}`),
  );
  if (notice.lastError) section.append(paragraph(notice.lastError));
  if (notice.acceptedAt)
    section.append(
      paragraph(
        `Accepted by Telegram at ${notice.acceptedAt}. This is not a read receipt and does not promise a single copy.`,
      ),
    );
  if (notice.state === "failed" && notice.eligibility === "eligible") {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Resend Telegram notice";
    button.disabled = sending || !!pending || availability === "deleted";
    button.addEventListener("click", () => {
      if (!botId || sending || pending) return;
      pending = {
        botId,
        requestId: crypto.randomUUID(),
        operation: "resend",
        noticeId: notice.id,
        taskId: notice.taskId,
        runId: notice.runId,
        text: "",
      };
      localStorage.setItem(pendingKey, JSON.stringify(pending));
      void submit();
    });
    section.append(button);
  }
  return section;
}
function questionCard(
  taskId: string,
  run: Run,
  question: Question,
  notice: Notice | undefined,
): HTMLElement {
  const section = document.createElement("section");
  section.dataset.questionId = question.id;
  section.id = `question-${question.id}`;
  section.append(
    paragraph(`Question: ${question.text}`),
    paragraph(`Request: ${question.id} · ${question.state}`),
  );
  if (notice) {
    section.dataset.noticeState = notice.state;
    section.append(noticeCard(notice));
  }
  if (question.deadline) section.append(paragraph(`Deadline: ${question.deadline}`));
  if (question.state === "answered") section.append(paragraph(`Owner answer: ${question.answer}`));
  if (question.state === "expired")
    section.append(
      paragraph("Question expired. This Run needs owner attention. Stop it before retrying."),
    );
  if (question.state === "pending" && ["active", "waiting"].includes(run.state)) {
    const form = document.createElement("form");
    const input = document.createElement("textarea");
    input.setAttribute("aria-label", `Answer to ${question.text}`);
    input.required = true;
    input.maxLength = 32000;
    input.value = answerDrafts.get(question.id) ?? "";
    input.addEventListener("input", () => answerDrafts.set(question.id, input.value));
    const button = document.createElement("button");
    button.type = "submit";
    button.textContent = "Answer question";
    input.disabled = button.disabled = sending || !!pending;
    form.append(input, button);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!botId || sending || pending) return;
      pending = {
        botId,
        requestId: crypto.randomUUID(),
        operation: "answer",
        questionId: question.id,
        taskId,
        runId: run.id,
        text: input.value,
      };
      localStorage.setItem(pendingKey, JSON.stringify(pending));
      void submit();
    });
    section.append(form);
  }
  return section;
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
async function submit(): Promise<void> {
  if (sending || !hostAvailable || (!pending && (!botId || availability !== "active"))) return;
  if (
    !pending &&
    (!text.value.trim() ||
      !form.reportValidity() ||
      target.selectedOptions[0]?.dataset.unavailable === "true")
  )
    return;
  sending = true;
  try {
    if (!pending) {
      if (!botId) return;
      const draft: Pending = {
        botId,
        requestId: crypto.randomUUID(),
        text: text.value,
        draftRevision: readDraft(botId).revision,
        operation: target.value === "new-task" ? "new-task" : target.value ? "task" : "message",
        ...(target.value && target.value !== "new-task"
          ? { taskId: target.value, runId: target.selectedOptions[0]?.dataset.runId }
          : {}),
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
    const noticeOperation = admitted.operation === "resend" || admitted.operation === "repair";
    const path =
      admitted.operation === "resend"
        ? `${prefix}/notices/${encodeURIComponent(admitted.noticeId as string)}/resend`
        : admitted.operation === "repair"
          ? `${prefix}/telegram-topic/repair`
          : admitted.operation === "decision"
            ? `${prefix}/runs/${encodeURIComponent(admitted.runId as string)}/approvals/${encodeURIComponent(admitted.approval?.id as string)}/decision`
            : admitted.operation === "answer"
              ? `${prefix}/runs/${encodeURIComponent(admitted.runId as string)}/questions/${encodeURIComponent(admitted.questionId as string)}/answer`
              : admitted.operation === "reset"
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
        admitted.operation === "decision"
          ? {
              requestId: admitted.requestId,
              decision: admitted.decision,
              operation: admitted.approval?.operation,
              targetBotId: admitted.approval?.targetBotId,
              text: admitted.approval?.text,
              deadline: admitted.approval?.deadline,
              files: (admitted.files ?? []).map((file) => ({
                kind: file.kind,
                id: file.id,
                filename: file.filename,
                bytes: file.bytes,
              })),
            }
          : admitted.operation === "reset" || runOperation || noticeOperation
            ? { requestId: admitted.requestId }
            : {
                requestId: admitted.requestId,
                text: admitted.text,
                ...(admitted.operation === "task" && admitted.runId
                  ? { expectedRunId: admitted.runId }
                  : {}),
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
    if (!record(result) || result.requestId !== admitted.requestId) throw new Error();
    if (
      admitted.operation === "task" &&
      (result.taskId !== admitted.taskId || (admitted.runId && result.runId !== admitted.runId))
    )
      throw new Error();
    if (admitted.operation === "repair") {
      if (result.state !== "mapped" && result.state !== "repairable") throw new Error();
    } else if (admitted.operation === "resend") {
      if (result.id !== admitted.noticeId) throw new Error();
    } else if (
      admitted.operation === "reset"
        ? typeof result.backgroundBoundary !== "number"
        : typeof result.taskId !== "string" ||
          typeof result.runId !== "string" ||
          (!runOperation &&
            admitted.operation !== "answer" &&
            admitted.operation !== "decision" &&
            typeof result.messageId !== "string")
    )
      throw new Error();
    localStorage.removeItem(pendingKey);
    pending = undefined;
    if (admitted.questionId) answerDrafts.delete(admitted.questionId);
    if (admitted.selectedMessageIds?.length) clearBackgroundSelection();
    if (
      !runOperation &&
      admitted.operation !== "reset" &&
      admitted.operation !== "answer" &&
      admitted.operation !== "decision" &&
      admitted.operation !== "resend" &&
      admitted.operation !== "repair"
    ) {
      const draft = readDraft(admitted.botId);
      if (draft.revision === admitted.draftRevision) {
        const nextTarget = draft.target === "new-task" ? "" : draft.target;
        writeDraft(admitted.botId, {
          ...draft,
          text: "",
          target: nextTarget,
          revision: crypto.randomUUID(),
        });
        if (admitted.botId === botId) {
          text.value = "";
          target.value = nextTarget;
          growDraft();
          showTarget();
        }
      }
    }
    notice.textContent =
      admitted.operation === "repair"
        ? result.state === "mapped"
          ? `Telegram topic ${String(result.topicId)} is mapped for this Bot. Work outcome stays unchanged.`
          : `Telegram topic still needs repair. ${typeof result.failure === "string" ? result.failure : ""}`
        : admitted.operation === "resend"
          ? `Notice ${admitted.noticeId} will be sent again. Work outcome stays unchanged.`
          : admitted.operation === "decision"
            ? `Decision recorded for action ${admitted.approval?.id}. The same Run continues from correlated evidence.`
            : admitted.operation === "answer"
              ? `Answer recorded for question ${admitted.questionId}. The same Run continues when capacity is available.`
              : admitted.operation === "reset"
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
  if (!pending) void submit();
});
retry.addEventListener("click", () => void submit());
resetBackground.addEventListener("click", () => {
  if (!botId || !hostAvailable || availability !== "active" || sending || pending) return;
  pending = { botId, requestId: crypto.randomUUID(), operation: "reset", text: "" };
  localStorage.setItem(pendingKey, JSON.stringify(pending));
  void submit();
});
