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
    typeof value.paused === "boolean" &&
    (value.deletedAt === null || typeof value.deletedAt === "string") &&
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
  paused: boolean;
  deletedAt: string | null;
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
const commandRetry = document.getElementById("routine-command-retry") as HTMLButtonElement;
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
const commandKey = "mybots.pending-routine-command";
interface Command {
  botId: string;
  routineId: string;
  requestId: string;
  action: "update" | "pause" | "resume" | "run" | "delete";
  text?: string;
  cron?: string;
  runAt?: string;
  timezone?: string;
}
let command: Command | undefined;
let commanding = false;
try {
  const saved: unknown = JSON.parse(localStorage.getItem(commandKey) ?? "null");
  if (
    record(saved) &&
    typeof saved.botId === "string" &&
    typeof saved.routineId === "string" &&
    typeof saved.requestId === "string" &&
    (saved.action === "update" ||
      saved.action === "pause" ||
      saved.action === "resume" ||
      saved.action === "run" ||
      saved.action === "delete") &&
    ["text", "cron", "runAt", "timezone"].every(
      (key) => !(key in saved) || typeof saved[key] === "string",
    )
  )
    command = {
      botId: saved.botId,
      routineId: saved.routineId,
      requestId: saved.requestId,
      action: saved.action,
      ...(typeof saved.text === "string" ? { text: saved.text } : {}),
      ...(typeof saved.cron === "string" ? { cron: saved.cron } : {}),
      ...(typeof saved.runAt === "string" ? { runAt: saved.runAt } : {}),
      ...(typeof saved.timezone === "string" ? { timezone: saved.timezone } : {}),
    };
} catch {
  /* Ignore unreadable browser state. */
}
let botId: string | undefined;
let availability: "active" | "disabled" | "deleted" = "active";
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
  const admitting = availability === "active";
  for (const node of form.querySelectorAll<
    HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement | HTMLSelectElement
  >("input, textarea, button, select"))
    node.disabled = !admitting || sending || !!pending || !!command || commanding;
  const once = schedule.value === "once";
  (document.getElementById("routine-once-fields") as HTMLElement).hidden = !once;
  (document.getElementById("routine-cron-fields") as HTMLElement).hidden = once;
  instant.disabled = timezone.disabled =
    !admitting || !once || sending || !!pending || !!command || commanding;
  cron.disabled = !admitting || once || sending || !!pending || !!command || commanding;
  cron.required = !once;
  cron.readOnly = schedule.value !== "custom";
  create.textContent = once ? "Create one-shot Routine" : "Create cron Routine";
  retry.hidden = !pending;
  retry.disabled = sending;
  commandRetry.hidden = !command;
  commandRetry.disabled = commanding;
  for (const control of list.querySelectorAll<
    HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement
  >("button, input, textarea")) {
    const action = control.dataset.action;
    control.disabled =
      sending ||
      !!pending ||
      commanding ||
      !!command ||
      availability === "deleted" ||
      (availability !== "active" && (action === "run" || action === "resume"));
  }
}
export async function showRoutines(
  selectedBot: string,
  onChange: () => void,
  next: "active" | "disabled" | "deleted" = "active",
): Promise<boolean> {
  availability = next;
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
  else if (command)
    notice.textContent = `Routine command unconfirmed for ${command.routineId}. Retry the saved request.`;
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
  if (changed && document.activeElement !== timezone) timezone.value = data.timezone;
  const articles = data.routines.map((routine) => {
    const article =
      [...list.querySelectorAll<HTMLElement>("article")].find(
        (item) => item.dataset.routineId === routine.id,
      ) ?? document.createElement("article");
    article.dataset.routineId = routine.id;
    article.className = "settings-card routine-card";
    let summary = article.querySelector<HTMLElement>(".routine-summary");
    if (!summary) {
      summary = document.createElement("div");
      summary.className = "routine-summary";
      article.append(summary);
    }
    const line = (text: string) =>
      Object.assign(document.createElement("p"), { textContent: text });
    summary.replaceChildren(
      line(`Routine ID: ${routine.id}`),
      line(routine.text),
      line(
        `${routine.cron ? `Cron: ${routine.cron}` : `Resolved instant: ${routine.runAt}`} · Timezone: ${routine.timezone}`,
      ),
      line(
        `Next occurrence: ${routine.nextOccurrence ?? (routine.cron ? "held until current occurrence ends" : "none — one-shot admitted")}`,
      ),
      line(
        routine.deletedAt
          ? `Deleted at ${routine.deletedAt}. Definition and results are retained.`
          : routine.paused
            ? "Paused. Automatic starts are blocked."
            : "Automatic starts are on.",
      ),
    );
    const definition = JSON.stringify([
      routine.text,
      routine.cron,
      routine.runAt,
      routine.timezone,
    ]);
    let fields = article.querySelector<HTMLFieldSetElement>("fieldset");
    if (routine.deletedAt) fields?.remove();
    else if (
      !fields ||
      (fields.dataset.definition !== definition && !fields.matches(":focus-within"))
    ) {
      fields?.remove();
      fields = document.createElement("fieldset");
      fields.dataset.definition = definition;
      const legend = document.createElement("legend");
      legend.textContent = "Edit definition for later occurrences";
      fields.append(legend);
      const editor = document.createElement("textarea");
      editor.value = routine.text;
      editor.maxLength = 32000;
      editor.rows = 2;
      editor.setAttribute("aria-label", `Edit instructions for ${routine.id}`);
      const schedule = document.createElement("input");
      schedule.value = routine.cron ?? routine.runAt;
      schedule.dataset.kind = routine.cron ? "cron" : "once";
      schedule.setAttribute(
        "aria-label",
        routine.cron ? `Edit cron for ${routine.id}` : `Edit instant for ${routine.id}`,
      );
      const zone = document.createElement("input");
      zone.value = routine.timezone;
      zone.hidden = !!routine.cron;
      zone.setAttribute("aria-label", `Edit timezone for ${routine.id}`);
      const save = document.createElement("button");
      save.type = "button";
      save.dataset.action = "update";
      save.textContent = "Save Routine edit";
      const pause = document.createElement("button");
      pause.type = "button";
      pause.dataset.action = routine.paused ? "resume" : "pause";
      pause.textContent = routine.paused ? "Resume routine" : "Pause routine";
      const run = document.createElement("button");
      run.type = "button";
      run.dataset.action = "run";
      run.textContent = "Run now";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.dataset.action = "delete";
      remove.textContent = "Delete routine";
      for (const [labelText, control] of [
        ["Instructions", editor],
        [routine.cron ? "Cron expression" : "Run at (ISO instant with offset)", schedule],
        ...(!routine.cron ? [["Schedule timezone", zone] as const] : []),
      ] as const) {
        const label = document.createElement("label");
        label.textContent = labelText;
        label.append(control);
        fields.append(label);
      }
      if (routine.cron) fields.append(zone);
      const actions = document.createElement("div");
      actions.className = "routine-actions";
      actions.append(save, pause, run, remove);
      fields.append(actions);
      article.append(fields);
    }
    const pause = fields?.querySelector<HTMLButtonElement>(
      '[data-action="pause"], [data-action="resume"]',
    );
    if (pause) {
      pause.dataset.action = routine.paused ? "resume" : "pause";
      pause.textContent = routine.paused ? "Resume routine" : "Pause routine";
    }
    let links = article.querySelector<HTMLElement>(".routine-occurrences");
    if (!links) {
      links = document.createElement("div");
      links.className = "routine-occurrences";
      article.append(links);
    }
    const linkSignature = JSON.stringify([routine.source, routine.occurrences]);
    if (links.dataset.signature !== linkSignature) {
      links.dataset.signature = linkSignature;
      links.replaceChildren();
      if (routine.source.kind === "run") {
        const source = document.createElement("a");
        source.href = `#task-${routine.source.taskId}`;
        source.textContent = `Created from Task ${routine.source.taskId}, Run ${routine.source.runId}`;
        links.append(source);
      } else links.append(line("Created by owner"));
      for (const occurrence of routine.occurrences) {
        const link = document.createElement("a");
        link.href = `#task-${occurrence.taskId}`;
        link.textContent = `Inspect occurrence Task ${occurrence.taskId} · Due: ${occurrence.dueAt}`;
        links.append(link);
      }
    }
    return article;
  });
  for (const child of [...list.children])
    if (!articles.includes(child as HTMLElement)) child.remove();
  for (const [index, article] of articles.entries())
    if (list.children[index] !== article) list.insertBefore(article, list.children[index] ?? null);
  controls();
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
commandRetry.addEventListener("click", () => void sendCommand());
list.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest("button");
  const article = button?.closest("article");
  const routineId = article?.dataset.routineId;
  const action = button?.dataset.action;
  if (!botId || !button || !article || !routineId || !action || commanding || command || pending)
    return;
  const text = article.querySelector("textarea")?.value ?? "";
  const schedule = article.querySelector("input");
  const timezone = article.querySelectorAll("input")[1]?.value ?? "";
  command = {
    botId,
    routineId,
    requestId: crypto.randomUUID(),
    action: action as Command["action"],
    ...(action === "update"
      ? schedule?.dataset.kind === "cron"
        ? { text, cron: schedule.value }
        : { text, runAt: schedule?.value, timezone }
      : {}),
  };
  localStorage.setItem(commandKey, JSON.stringify(command));
  void sendCommand();
});
async function sendCommand() {
  if (!command || commanding) return;
  commanding = true;
  const current = command;
  controls();
  try {
    const target =
      current.action === "update"
        ? `/api/bots/${encodeURIComponent(current.botId)}/routines/${encodeURIComponent(current.routineId)}`
        : `/api/bots/${encodeURIComponent(current.botId)}/routines/${encodeURIComponent(current.routineId)}/${current.action}`;
    const body: Record<string, string> = { requestId: current.requestId };
    if (current.action === "update") {
      body.text = current.text ?? "";
      if (current.cron) body.cron = current.cron;
      else {
        body.runAt = current.runAt ?? "";
        body.timezone = current.timezone ?? "";
      }
    }
    const response = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result: unknown = await response.json();
    if (!response.ok) {
      if (response.status < 500) {
        command = undefined;
        localStorage.removeItem(commandKey);
      }
      notice.textContent =
        record(result) && typeof result.error === "string"
          ? result.error
          : "Routine command unconfirmed. Retry the saved request.";
      return;
    }
    if (!isRoutine(result) || result.id !== current.routineId) throw new Error();
    command = undefined;
    localStorage.removeItem(commandKey);
    notice.textContent =
      current.action === "delete"
        ? `Deleted Routine ${current.routineId}. Definition and results are retained.`
        : current.action === "pause"
          ? `Paused Routine ${current.routineId}. Current work can finish.`
          : current.action === "resume"
            ? `Resumed Routine ${current.routineId}.`
            : current.action === "run"
              ? `Ran Routine ${current.routineId} once. Recurrence is unchanged.`
              : `Saved Routine ${current.routineId} for later occurrences.`;
    refresh();
  } catch {
    notice.textContent =
      "Routine command unconfirmed. Retry the saved request, including after reload.";
  } finally {
    commanding = false;
    controls();
  }
}

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
