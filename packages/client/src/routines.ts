function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function isCreation(value: unknown): value is Creation {
  return (
    record(value) &&
    ["botId", "requestId", "text"].every((key) => typeof value[key] === "string") &&
    (typeof value.cron === "string" ||
      (typeof value.runAt === "string" && typeof value.timezone === "string"))
  );
}
function isRoutine(value: unknown): value is Routine {
  return (
    record(value) &&
    ["id", "text", "runAt", "timezone"].every((key) => typeof value[key] === "string") &&
    (value.nextOccurrence === null || typeof value.nextOccurrence === "string") &&
    (value.taskId === null || typeof value.taskId === "string") &&
    (value.cron === null || typeof value.cron === "string") &&
    Array.isArray(value.occurrences) &&
    value.occurrences.every(
      (o) => record(o) && typeof o.taskId === "string" && typeof o.dueAt === "string",
    ) &&
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
  cron: string | null;
  occurrences: { taskId: string; dueAt: string }[];
  source: { kind: string; taskId?: string; runId?: string };
}
interface Creation {
  botId: string;
  requestId: string;
  text: string;
  runAt?: string;
  timezone?: string;
  cron?: string;
}
const form = document.getElementById("routine-form") as HTMLFormElement;
const instructions = document.getElementById("routine-text") as HTMLTextAreaElement;
const instant = document.getElementById("routine-instant") as HTMLInputElement;
const timezone = document.getElementById("routine-timezone") as HTMLInputElement;
const notice = document.getElementById("routine-notice") as HTMLElement;
const list = document.getElementById("routine-list") as HTMLElement;
const retry = document.getElementById("routine-retry") as HTMLButtonElement;
const schedule = document.getElementById("routine-schedule") as HTMLSelectElement;
const cron = document.getElementById("routine-cron") as HTMLInputElement;
const create = document.getElementById("routine-create") as HTMLButtonElement;
const botTimezoneForm = document.getElementById("bot-timezone-form") as HTMLFormElement;
const botTimezone = document.getElementById("bot-timezone") as HTMLInputElement;
const timezoneNotice = document.getElementById("bot-timezone-notice") as HTMLElement;
const timezoneRetry = document.getElementById("bot-timezone-retry") as HTMLButtonElement;
const timezoneSave = botTimezoneForm.querySelector("button") as HTMLButtonElement;
const timezoneKey = "mybots.pending-timezone";
let pendingTimezone: { botId: string; requestId: string; timezone: string } | undefined;
let savingTimezone = false;
try {
  const saved: unknown = JSON.parse(localStorage.getItem(timezoneKey) ?? "null");
  if (
    record(saved) &&
    typeof saved.botId === "string" &&
    typeof saved.requestId === "string" &&
    typeof saved.timezone === "string"
  )
    pendingTimezone = { botId: saved.botId, requestId: saved.requestId, timezone: saved.timezone };
} catch {
  /* Ignore unreadable browser state. */
}
function timezoneControls() {
  timezoneSave.disabled = botTimezone.disabled = savingTimezone || !!pendingTimezone;
  timezoneRetry.hidden = !pendingTimezone;
  timezoneRetry.disabled = savingTimezone;
  if (pendingTimezone)
    timezoneNotice.textContent = `Timezone unconfirmed for Bot ${pendingTimezone.botId}: ${pendingTimezone.timezone}. Retry the saved request.`;
}
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
    HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement | HTMLSelectElement
  >("input, textarea, button, select"))
    node.disabled = sending || !!pending;
  const once = schedule.value === "once";
  (document.getElementById("routine-once-fields") as HTMLElement).hidden = !once;
  (document.getElementById("routine-cron-fields") as HTMLElement).hidden = once;
  instant.disabled = timezone.disabled = !once || sending || !!pending;
  cron.disabled = once || sending || !!pending;
  cron.required = !once;
  cron.readOnly = schedule.value !== "custom";
  create.textContent = once ? "Create one-shot Routine" : "Create cron Routine";
  retry.hidden = !pending;
  retry.disabled = sending;
}
export async function showRoutines(selectedBot: string, onChange: () => void): Promise<boolean> {
  const changed = botId !== selectedBot;
  botId = selectedBot;
  refresh = onChange;
  controls();
  timezoneControls();
  if (changed) {
    list.replaceChildren();
    instructions.value = "";
    instant.value = new Date(Date.now() + 3600000).toISOString();
    schedule.value = "once";
    controls();
  }
  if (pending)
    notice.textContent = `Creation unconfirmed for Bot ${pending.botId}. Retry the saved request.`;
  const response = await fetch(`/api/bots/${encodeURIComponent(selectedBot)}/routines`, {
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Routines unavailable.");
  const data: unknown = await response.json();
  if (
    !record(data) ||
    typeof data.timezone !== "string" ||
    !Array.isArray(data.routines) ||
    !data.routines.every(isRoutine)
  )
    throw new Error("Invalid Routine response.");
  if (botId !== selectedBot) return false;
  if (!botTimezoneForm.matches(":focus-within")) botTimezone.value = data.timezone;
  if (changed) timezone.value = data.timezone;
  list.replaceChildren(
    ...data.routines.map((routine) => {
      const article = document.createElement("article");
      article.dataset.routineId = routine.id;
      const line = (text: string) =>
        Object.assign(document.createElement("p"), { textContent: text });
      article.append(
        line(`Routine ID: ${routine.id}`),
        line(routine.text),
        line(
          `${routine.cron ? `Cron: ${routine.cron}` : `Resolved instant: ${routine.runAt}`} · Timezone: ${routine.timezone}`,
        ),
        line(
          `Next occurrence: ${routine.nextOccurrence ?? (routine.cron ? "held until current occurrence ends" : "none — one-shot admitted")}`,
        ),
      );
      if (routine.source.kind === "run") {
        const source = document.createElement("a");
        source.href = `#task-${routine.source.taskId}`;
        source.textContent = `Created from Task ${routine.source.taskId}, Run ${routine.source.runId}`;
        article.append(source);
      } else article.append(line("Created by owner"));
      for (const occurrence of routine.occurrences) {
        const link = document.createElement("a");
        link.href = `#task-${occurrence.taskId}`;
        link.textContent = `Inspect occurrence Task ${occurrence.taskId} · Due: ${occurrence.dueAt}`;
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
        ...(schedule.value === "once"
          ? { runAt: instant.value, timezone: timezone.value }
          : { cron: cron.value }),
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

schedule.addEventListener("change", () => {
  const presets: Record<string, string> = {
    hourly: "0 * * * *",
    daily: "0 9 * * *",
    weekdays: "0 9 * * 1-5",
  };
  cron.value = presets[schedule.value] ?? cron.value;
  controls();
});
async function saveTimezone() {
  if (!botId || savingTimezone) return;
  savingTimezone = true;
  try {
    if (!pendingTimezone) {
      pendingTimezone = { botId, requestId: crypto.randomUUID(), timezone: botTimezone.value };
      localStorage.setItem(timezoneKey, JSON.stringify(pendingTimezone));
    }
    const input = pendingTimezone;
    timezoneControls();
    const response = await fetch(`/api/bots/${encodeURIComponent(input.botId)}/timezone`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: input.requestId, timezone: input.timezone }),
    });
    const result: unknown = await response.json();
    if (!response.ok) {
      if (response.status < 500) {
        localStorage.removeItem(timezoneKey);
        pendingTimezone = undefined;
      }
      timezoneNotice.textContent =
        record(result) && typeof result.error === "string"
          ? result.error
          : "Timezone unconfirmed. Retry the saved request.";
      return;
    }
    if (
      !record(result) ||
      result.requestId !== input.requestId ||
      typeof result.timezone !== "string"
    )
      throw new Error();
    localStorage.removeItem(timezoneKey);
    pendingTimezone = undefined;
    timezoneNotice.textContent = `Bot ${input.botId} timezone: ${result.timezone}. Future cron scheduling updated.`;
    refresh();
  } catch {
    timezoneNotice.textContent =
      "Timezone unconfirmed. Retry the saved request, including after reload.";
  } finally {
    savingTimezone = false;
    timezoneControls();
  }
}
botTimezoneForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!pendingTimezone) void saveTimezone();
});
timezoneRetry.addEventListener("click", () => void saveTimezone());
