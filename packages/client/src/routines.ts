function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function isCreation(value: unknown): value is Creation {
  return (
    record(value) &&
    ["botId", "requestId", "text", "runAt", "timezone"].every(
      (key) => typeof value[key] === "string",
    )
  );
}
function isRoutine(value: unknown): value is Routine {
  return (
    record(value) &&
    ["id", "text", "runAt", "timezone"].every((key) => typeof value[key] === "string") &&
    (value.nextOccurrence === null || typeof value.nextOccurrence === "string") &&
    (value.taskId === null || typeof value.taskId === "string") &&
    record(value.source) &&
    (value.source.kind === "owner" ||
      (value.source.kind === "run" &&
        typeof value.source.taskId === "string" &&
        typeof value.source.runId === "string"))
  );
}
interface Routine {
  id: string;
  text: string;
  runAt: string;
  timezone: string;
  nextOccurrence: string | null;
  taskId: string | null;
  source: { kind: string; taskId?: string; runId?: string };
}
interface Creation {
  botId: string;
  requestId: string;
  text: string;
  runAt: string;
  timezone: string;
}
const form = document.getElementById("routine-form") as HTMLFormElement;
const instructions = document.getElementById("routine-text") as HTMLTextAreaElement;
const instant = document.getElementById("routine-instant") as HTMLInputElement;
const timezone = document.getElementById("routine-timezone") as HTMLInputElement;
const notice = document.getElementById("routine-notice") as HTMLElement;
const list = document.getElementById("routine-list") as HTMLElement;
const retry = document.getElementById("routine-retry") as HTMLButtonElement;
const pendingKey = "mybots.pending-routine";
let botId: string | undefined;
let pending: Creation | undefined;
let sending = false;
let refresh: () => void = () => {};
try {
  const saved: unknown = JSON.parse(localStorage.getItem(pendingKey) ?? "null");
  if (isCreation(saved)) pending = saved;
} catch {
  /* Ignore unreadable browser state. */
}
function controls() {
  for (const node of form.querySelectorAll<
    HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement
  >("input, textarea, button"))
    node.disabled = sending || !!pending;
  retry.hidden = !pending;
  retry.disabled = sending;
}
export async function showRoutines(selectedBot: string, onChange: () => void): Promise<boolean> {
  const changed = botId !== selectedBot;
  botId = selectedBot;
  refresh = onChange;
  controls();
  if (changed) {
    list.replaceChildren();
    instructions.value = "";
    instant.value = new Date(Date.now() + 3600000).toISOString();
    timezone.value = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
  }
  if (pending)
    notice.textContent = `Creation unconfirmed for Bot ${pending.botId}. Retry the saved request.`;
  const response = await fetch(`/api/bots/${encodeURIComponent(selectedBot)}/routines`, {
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Routines unavailable.");
  const data: unknown = await response.json();
  if (!record(data) || !Array.isArray(data.routines) || !data.routines.every(isRoutine))
    throw new Error("Invalid Routine response.");
  if (botId !== selectedBot) return false;
  list.replaceChildren(
    ...data.routines.map((routine) => {
      const article = document.createElement("article");
      article.dataset.routineId = routine.id;
      const line = (text: string) =>
        Object.assign(document.createElement("p"), { textContent: text });
      article.append(
        line(`Routine ID: ${routine.id}`),
        line(routine.text),
        line(`Resolved instant: ${routine.runAt} · Timezone: ${routine.timezone}`),
        line(`Next occurrence: ${routine.nextOccurrence ?? "none — one-shot admitted"}`),
      );
      if (routine.source.kind === "run") {
        const source = document.createElement("a");
        source.href = `#task-${routine.source.taskId}`;
        source.textContent = `Created from Task ${routine.source.taskId}, Run ${routine.source.runId}`;
        article.append(source);
      } else article.append(line("Created by owner"));
      if (routine.taskId) {
        const link = document.createElement("a");
        link.href = `#task-${routine.taskId}`;
        link.textContent = `Inspect occurrence Task ${routine.taskId}`;
        article.append(link);
      }
      return article;
    }),
  );
  return data.routines.some((routine) => routine.nextOccurrence !== null);
}
async function submit() {
  if (!botId || sending) return;
  sending = true;
  try {
    if (!pending) {
      pending = {
        botId,
        requestId: crypto.randomUUID(),
        text: instructions.value,
        runAt: instant.value,
        timezone: timezone.value,
      };
      localStorage.setItem(pendingKey, JSON.stringify(pending));
    }
    controls();
    const admitted = pending;
    const { botId: target, ...input } = admitted;
    const response = await fetch(`/api/bots/${encodeURIComponent(target)}/routines`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const result: unknown = await response.json();
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500) {
        pending = undefined;
        localStorage.removeItem(pendingKey);
      }
      notice.textContent =
        record(result) && typeof result.error === "string"
          ? result.error
          : "Routine unavailable. Retry the saved request.";
      return;
    }
    if (!record(result) || result.requestId !== admitted.requestId || !isRoutine(result))
      throw new Error();
    pending = undefined;
    localStorage.removeItem(pendingKey);
    instructions.value = "";
    notice.textContent = `Created Routine ${result.id}. Resolved instant: ${result.runAt} · Timezone: ${result.timezone} · Next occurrence: ${result.nextOccurrence ?? "admitted"}.`;
    refresh();
  } catch {
    notice.textContent = "Creation unconfirmed. Retry the saved request, including after reload.";
  } finally {
    sending = false;
    controls();
  }
}
form.addEventListener("submit", (event) => {
  event.preventDefault();
  void submit();
});
retry.addEventListener("click", () => void submit());
