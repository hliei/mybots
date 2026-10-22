import { type BotSummary, setNavigationAvailable, showBotNavigation } from "./bot-navigation.ts";
import { setHostAvailable, showChat } from "./chat.ts";
import { showMemory } from "./memory.ts";
import { closeCreation, resolveBotTrigger, setShellBot } from "./shell.ts";
import { type SkillSelection, selectedSkills, showSkills } from "./skills.ts";

interface Snapshot {
  bots: { id: string; name: string }[];
  sessions: {
    id: string;
    botId: string;
    destinationId: string;
    status: string;
    containerStatus: string;
    inputs: { pending: number; processing: number; acknowledged: number; failed: number };
  }[];
}

type BotAvailability = "active" | "disabled" | "deleted";

const logicalDeletionRetention =
  "Logical deletion keeps this Bot's configuration, history, results, workspace, memory, and materials, including copies held by other Bots. It does not restore the Bot or permanently purge retained data.";

interface Bot {
  id: string;
  name: string;
  availability: BotAvailability;
  workspace: string;
  instructions: string;
  model: { provider: string; id: string };
  tools: string[];
  savedVersion: number;
  effectiveVersion: number;
  skills: SkillSelection[];
  effective: {
    skills: SkillSelection[];
    instructions: string;
    model: { provider: string; id: string };
    tools: string[];
  };
}
interface BotOptions {
  models: { provider: string; id: string }[];
  tools: string[];
}
interface Creation {
  requestId: string;
  name: string;
  instructions: string;
  model: { provider: string; id: string };
  tools: string[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSnapshot(value: unknown): value is Snapshot {
  if (!record(value) || !Array.isArray(value.bots) || !Array.isArray(value.sessions)) return false;
  return (
    value.bots.every(
      (bot: unknown) => record(bot) && typeof bot.id === "string" && typeof bot.name === "string",
    ) &&
    value.sessions.every((session: unknown) => {
      if (!record(session) || !record(session.inputs)) return false;
      return (
        [
          session.id,
          session.botId,
          session.destinationId,
          session.status,
          session.containerStatus,
        ].every((field) => typeof field === "string") &&
        [
          session.inputs.pending,
          session.inputs.processing,
          session.inputs.acknowledged,
          session.inputs.failed,
        ].every((count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0)
      );
    })
  );
}

function isModel(value: unknown): value is Bot["model"] {
  return record(value) && typeof value.provider === "string" && typeof value.id === "string";
}
function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function isBot(value: unknown): value is Bot {
  return (
    record(value) &&
    [value.id, value.name, value.workspace, value.instructions].every(
      (field) => typeof field === "string",
    ) &&
    (value.availability === "active" ||
      value.availability === "disabled" ||
      value.availability === "deleted") &&
    isModel(value.model) &&
    isStrings(value.tools) &&
    typeof value.savedVersion === "number" &&
    typeof value.effectiveVersion === "number" &&
    record(value.effective) &&
    typeof value.effective.instructions === "string" &&
    isModel(value.effective.model) &&
    isStrings(value.effective.tools)
  );
}
function isSummary(value: unknown): value is BotSummary {
  return (
    record(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    ["active", "disabled", "deleted"].includes(value.availability as string) &&
    typeof value.activityAt === "string" &&
    typeof value.working === "boolean" &&
    typeof value.attention === "boolean" &&
    (value.latestMessage === null ||
      (record(value.latestMessage) &&
        [
          value.latestMessage.id,
          value.latestMessage.role,
          value.latestMessage.excerpt,
          value.latestMessage.createdAt,
        ].every((field) => typeof field === "string")))
  );
}
function isOptions(value: unknown): value is BotOptions {
  return (
    record(value) &&
    Array.isArray(value.models) &&
    value.models.every(isModel) &&
    isStrings(value.tools)
  );
}
function isCreation(value: unknown): value is Creation {
  return (
    record(value) &&
    [value.requestId, value.name, value.instructions].every((field) => typeof field === "string") &&
    isModel(value.model) &&
    isStrings(value.tools)
  );
}

const pairing = document.querySelector<HTMLElement>("#pairing") as HTMLElement;
const status = document.querySelector<HTMLElement>("#status") as HTMLElement;
const connection = document.querySelector<HTMLElement>("#connection") as HTMLElement;
const credential = document.querySelector<HTMLInputElement>("#credential") as HTMLInputElement;
const pairButton = document.querySelector<HTMLButtonElement>(
  "#pair-form button",
) as HTMLButtonElement;
const refresh = document.querySelector<HTMLButtonElement>("#refresh") as HTMLButtonElement;

const selected = document.querySelector<HTMLElement>("#selected-bot") as HTMLElement;
const createForm = document.querySelector<HTMLFormElement>("#create-form") as HTMLFormElement;
const createFields = document.querySelector<HTMLFieldSetElement>(
  "#create-fields",
) as HTMLFieldSetElement;
const botName = document.querySelector<HTMLInputElement>("#bot-name") as HTMLInputElement;
const instructions = document.querySelector<HTMLTextAreaElement>(
  "#instructions",
) as HTMLTextAreaElement;
const model = document.querySelector<HTMLSelectElement>("#model") as HTMLSelectElement;
const tools = document.querySelector<HTMLFieldSetElement>("#tools") as HTMLFieldSetElement;
const createButton = document.querySelector<HTMLButtonElement>(
  "#create-button",
) as HTMLButtonElement;
const createMessage = document.querySelector<HTMLElement>("#create-message") as HTMLElement;
const settingsSection = document.querySelector<HTMLElement>("#settings") as HTMLElement;
const settingsVersions = document.querySelector<HTMLElement>("#settings-versions") as HTMLElement;
const settingsForm = document.querySelector<HTMLFormElement>("#settings-form") as HTMLFormElement;
const settingsFields = document.querySelector<HTMLFieldSetElement>(
  "#settings-fields",
) as HTMLFieldSetElement;
const savedRole = document.querySelector<HTMLTextAreaElement>("#saved-role") as HTMLTextAreaElement;
const savedModel = document.querySelector<HTMLSelectElement>("#saved-model") as HTMLSelectElement;
const savedTools = document.querySelector<HTMLFieldSetElement>(
  "#saved-tools",
) as HTMLFieldSetElement;
const saveSettings = document.querySelector<HTMLButtonElement>(
  "#save-settings",
) as HTMLButtonElement;
const settingsMessage = document.querySelector<HTMLElement>("#settings-message") as HTMLElement;
const pendingKey = "mybots.pending-bot";
const pendingLifecycleKey = "mybots.pending-lifecycle";
const pendingSettingsKey = "mybots.pending-settings";
let selectedId =
  new URLSearchParams(location.search).get("bot") ?? localStorage.getItem("mybots.selected-bot");
let pending: Creation | undefined;
try {
  const stored: unknown = JSON.parse(localStorage.getItem(pendingKey) ?? "null");
  if (isCreation(stored)) pending = stored;
} catch {
  /* An unreadable draft has no valid request to retry. */
}
let currentOptions = "";
let settingsIdentity = "";
interface SettingsDraft extends Creation {
  botId: string;
  skills?: SkillSelection[];
}
let pendingSettings: SettingsDraft | undefined;
let settingsSending = false;
let settingsBotId: string | undefined;

function showSettingsRecovery(): void {
  const recovery = document.getElementById("settings-recovery") as HTMLElement;
  recovery.hidden = !pendingSettings;
  if (pendingSettings) {
    const name =
      summaries.find((bot) => bot.id === pendingSettings?.botId)?.name ?? pendingSettings.botId;
    (document.getElementById("settings-recovery-message") as HTMLElement).textContent =
      `Configuration response unconfirmed for ${name} (${pendingSettings.botId}). Recover the saved request before saving another Bot's configuration.`;
  }
  (document.getElementById("recover-settings") as HTMLButtonElement).disabled = settingsSending;
}
document.getElementById("recover-settings")?.addEventListener("click", () => {
  if (!pendingSettings || settingsSending) return;
  selectBot(pendingSettings.botId);
  settingsIdentity = "";
  void load();
});
interface LifecycleDraft {
  botId: string;
  requestId: string;
  operation: "disable" | "enable" | "delete";
}
let pendingLifecycle: LifecycleDraft | undefined;
try {
  const stored: unknown = JSON.parse(localStorage.getItem(pendingLifecycleKey) ?? "null");
  if (
    record(stored) &&
    typeof stored.botId === "string" &&
    typeof stored.requestId === "string" &&
    (stored.operation === "disable" ||
      stored.operation === "enable" ||
      stored.operation === "delete")
  )
    pendingLifecycle = stored as unknown as LifecycleDraft;
} catch {
  /* An unreadable lifecycle draft has no valid request to retry. */
}
try {
  const stored: unknown = JSON.parse(localStorage.getItem(pendingSettingsKey) ?? "null");
  if (isCreation(stored) && record(stored) && typeof stored.botId === "string")
    pendingSettings = stored as unknown as SettingsDraft;
} catch {
  /* An unreadable settings draft has no valid request to retry. */
}

function selectBot(id: string): void {
  selectedId = id;
  localStorage.setItem("mybots.selected-bot", id);
}

function renderOptions(options: BotOptions): void {
  const signature = JSON.stringify(options);
  if (signature === currentOptions) return;
  currentOptions = signature;
  const previousModel = model.value;
  const previousSaved = savedModel.value;
  const optionsFor = (select: HTMLSelectElement, previous: string) => {
    select.replaceChildren(
      ...options.models.map((choice) => {
        const option = document.createElement("option");
        option.value = `${choice.provider}/${choice.id}`;
        option.textContent = option.value;
        return option;
      }),
    );
    if (options.models.some((choice) => `${choice.provider}/${choice.id}` === previous))
      select.value = previous;
  };
  optionsFor(model, previousModel);
  optionsFor(savedModel, previousSaved);
  tools.replaceChildren(Object.assign(document.createElement("legend"), { textContent: "Tools" }));
  savedTools.replaceChildren(
    Object.assign(document.createElement("legend"), { textContent: "Saved tools" }),
  );
  for (const tool of options.tools) {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = tool;
    label.append(checkbox, document.createTextNode(tool));
    tools.append(label);
    const savedLabel = document.createElement("label");
    const savedCheckbox = document.createElement("input");
    savedCheckbox.type = "checkbox";
    savedCheckbox.value = tool;
    savedCheckbox.setAttribute("aria-label", `Saved tool ${tool}`);
    savedLabel.append(savedCheckbox, document.createTextNode(`Saved tool ${tool}`));
    savedTools.append(savedLabel);
  }
  if (pending) {
    botName.value = pending.name;
    instructions.value = pending.instructions;
    model.value = `${pending.model.provider}/${pending.model.id}`;
    for (const checkbox of tools.querySelectorAll("input"))
      checkbox.checked = pending.tools.includes(checkbox.value);
    createFields.disabled = true;
    createButton.textContent = "Retry creation";
    createMessage.textContent =
      "A creation response is unconfirmed. Retry the saved request to recover its Bot.";
  }
}

function render(snapshot: Snapshot, managed: Bot[]): void {
  showBotNavigation(
    summaries,
    selectedId,
    (id) => {
      selectBot(id);
      render(snapshot, managed);
    },
    requestAvailability,
  );
  const active = managed.find((bot) => bot.id === selectedId);
  setShellBot(active);
  showSettingsRecovery();
  selected.hidden = !active;
  selected.replaceChildren();
  const execution = document.getElementById("host-execution") as HTMLElement;
  execution.replaceChildren();
  if (active) {
    for (const session of snapshot.sessions.filter((item) => item.botId === active.id)) {
      const line = document.createElement("p");
      line.textContent = `Run ${session.id} · Destination: ${session.destinationId} · Run: ${session.status} · Container: ${session.containerStatus}. Inputs: ${session.inputs.pending} pending, ${session.inputs.processing} processing, ${session.inputs.acknowledged} acknowledged, ${session.inputs.failed} failed.`;
      execution.append(line);
    }
    const heading = document.createElement("h2");
    heading.textContent = active.name;
    selected.append(heading);
    const lines = [
      `Bot ID: ${active.id}`,
      `Workspace: ${active.workspace}`,
      `Saved role: ${active.instructions}`,
      `Saved model: ${active.model.provider}/${active.model.id}`,
      `Saved tools: ${active.tools.join(", ") || "None"}`,
      `Saved Skills: ${active.skills.map((skill) => `${skill.id}@${skill.revision}`).join(", ") || "None"}`,
    ];
    if (active.savedVersion !== active.effectiveVersion)
      lines.push(
        `Effective role: ${active.effective.instructions}`,
        `Effective model: ${active.effective.model.provider}/${active.effective.model.id}`,
        `Effective tools: ${active.effective.tools.join(", ") || "None"}`,
        `Effective Skills: ${active.effective.skills.map((skill) => `${skill.id}@${skill.revision}`).join(", ") || "None"}`,
      );
    for (const text of [
      ...lines,
      `Saved configuration: ${active.savedVersion}`,
      `Effective configuration: ${active.effectiveVersion}`,
    ]) {
      const paragraph = document.createElement("p");
      paragraph.textContent = text;
      selected.append(paragraph);
    }
    const lifecycle = document.createElement("p");
    lifecycle.id = "bot-lifecycle";
    lifecycle.textContent =
      active.availability === "deleted"
        ? logicalDeletionRetention
        : active.availability === "disabled"
          ? "This Bot is disabled. New chat, tasks, retries, Routines, and delegations are not admitted. Enabling does not revive cancelled work."
          : "Disabling blocks new chat, tasks, retries, Routines, and delegations and cancels unfinished owned work.";
    selected.append(lifecycle);
    const actions = document.createElement("p");
    const operation = (name: "disable" | "enable" | "delete", label: string): HTMLButtonElement => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent =
        pendingLifecycle?.botId === active.id && pendingLifecycle.operation === name
          ? `Retry ${label}`
          : label;
      button.addEventListener("click", () => requestAvailability(active.id, name));
      return button;
    };
    if (active.availability === "active") actions.append(operation("disable", "Disable Bot"));
    if (active.availability === "disabled") {
      actions.append(operation("enable", "Enable Bot"));
      actions.append(operation("disable", "Retry cancellation"));
    }
    if (active.availability !== "deleted") {
      actions.append(operation("delete", "Logically delete Bot"));
      const disclosure = document.createElement("p");
      disclosure.textContent = logicalDeletionRetention;
      selected.append(actions, disclosure);
    }
    void showSkills(
      active.id,
      pendingSettings?.botId === active.id
        ? (pendingSettings.skills ?? active.skills)
        : active.skills,
    );
    void showMemory(active.id, active.availability !== "deleted");
    settingsSection.hidden = false;
    settingsVersions.textContent =
      active.savedVersion === active.effectiveVersion
        ? `Saved and effective configuration ${active.savedVersion}.`
        : `Saved configuration ${active.savedVersion}. Effective configuration ${active.effectiveVersion}. The current Attempt finishes under the effective role, model, and tools.`;
    const skillNames = (skills: Bot["skills"]) =>
      skills.map((skill) => `${skill.id}@${skill.revision}`).join(", ") || "None";
    (document.getElementById("skill-activation") as HTMLElement).textContent =
      `Saved Skills: ${skillNames(active.skills)}. Effective Skills: ${skillNames(active.effective.skills)}.`;
    const effective = document.getElementById("settings-effective") as HTMLElement;
    effective.hidden = active.savedVersion === active.effectiveVersion;
    effective.replaceChildren();
    if (!effective.hidden) {
      for (const text of [
        `Effective role: ${active.effective.instructions}`,
        `Effective model: ${active.effective.model.provider}/${active.effective.model.id}`,
        `Effective tools: ${active.effective.tools.join(", ") || "None"}`,
        `Effective Skills: ${skillNames(active.effective.skills)}`,
      ])
        effective.append(Object.assign(document.createElement("p"), { textContent: text }));
    }
    const identity = `${active.id}:${active.savedVersion}`;
    const editing = settingsFields.disabled || settingsFields.matches(":focus-within");
    if (
      settingsBotId !== active.id ||
      (!editing && (identity !== settingsIdentity || pendingSettings?.botId === active.id))
    ) {
      if (settingsBotId !== active.id)
        settingsMessage.textContent =
          pendingSettings?.botId === active.id
            ? "Configuration response unconfirmed. Retry the saved request to confirm its outcome."
            : "";
      settingsBotId = active.id;
      settingsIdentity = identity;
      savedRole.value =
        pendingSettings?.botId === active.id ? pendingSettings.instructions : active.instructions;
      savedModel.value = `${(pendingSettings?.botId === active.id ? pendingSettings.model : active.model).provider}/${(pendingSettings?.botId === active.id ? pendingSettings.model : active.model).id}`;
      const selectedTools =
        pendingSettings?.botId === active.id ? pendingSettings.tools : active.tools;
      for (const checkbox of savedTools.querySelectorAll("input"))
        checkbox.checked = selectedTools.includes(checkbox.value);
    }
    if (pendingSettings?.botId === active.id) {
      settingsFields.disabled = true;
      saveSettings.textContent = "Retry configuration";
      saveSettings.disabled = settingsSending;
    } else if (active.availability !== "deleted") {
      settingsFields.disabled = false;
      saveSettings.disabled = settingsSending || !!pendingSettings;
      saveSettings.textContent = "Save configuration";
    }
    if (active.availability === "deleted") {
      settingsFields.disabled = true;
      saveSettings.disabled = true;
      settingsMessage.textContent =
        "Deleted Bot configuration stays inspectable. Active edits are not available.";
    }
  } else {
    settingsSection.hidden = true;
    void showSkills(undefined);
    void showMemory(undefined);
  }
  void showChat(active?.id, active?.availability);
}

const deletion = document.getElementById("delete-surface") as HTMLDialogElement;
let deletionBot: string | undefined;
let deletionReturn: HTMLElement | undefined;
function requestAvailability(botId: string, operation: LifecycleDraft["operation"]): void {
  if (lifecycleSending) return;
  if (
    pendingLifecycle &&
    (pendingLifecycle.botId !== botId || pendingLifecycle.operation !== operation)
  ) {
    showLifecycleRecovery();
    return;
  }
  if (
    operation !== "delete" ||
    (pendingLifecycle?.botId === botId && pendingLifecycle.operation === "delete")
  ) {
    void changeAvailability(botId, operation);
    return;
  }
  deletionBot = botId;
  (document.getElementById("delete-bot") as HTMLElement).textContent =
    summaries.find((bot) => bot.id === botId)?.name ?? botId;
  deletionReturn = document.activeElement as HTMLElement;
  deletion.showModal();
  document.getElementById("cancel-delete")?.focus();
}
document.getElementById("cancel-delete")?.addEventListener("click", () => deletion.close());
document.getElementById("confirm-delete")?.addEventListener("click", () => {
  const id = deletionBot;
  deletion.close();
  if (id) void changeAvailability(id, "delete");
});
deletion.addEventListener("close", () => {
  deletionBot = undefined;
  resolveBotTrigger(deletionReturn, "bot-identity").focus();
});

let lifecycleSending = false;
const lifecycleMessage = document.getElementById("lifecycle-message") as HTMLElement;
const retryLifecycle = document.getElementById("retry-lifecycle") as HTMLButtonElement;
function showLifecycleRecovery(): void {
  lifecycleMessage.textContent = pendingLifecycle
    ? `Lifecycle response unconfirmed for Bot ${pendingLifecycle.botId} (${pendingLifecycle.operation}). Retry the saved request to confirm its outcome.`
    : "";
  retryLifecycle.hidden = !pendingLifecycle;
  retryLifecycle.disabled = lifecycleSending;
}
retryLifecycle.addEventListener("click", () => {
  if (pendingLifecycle) void changeAvailability(pendingLifecycle.botId, pendingLifecycle.operation);
});
showLifecycleRecovery();

async function changeAvailability(
  botId: string,
  operation: LifecycleDraft["operation"],
): Promise<void> {
  if (lifecycleSending) return;
  lifecycleSending = true;
  retryLifecycle.disabled = true;
  try {
    if (
      !pendingLifecycle ||
      pendingLifecycle.botId !== botId ||
      pendingLifecycle.operation !== operation
    ) {
      const draft = { botId, requestId: crypto.randomUUID(), operation };
      localStorage.setItem(pendingLifecycleKey, JSON.stringify(draft));
      pendingLifecycle = draft;
    }
    const response = await fetch(`/api/bots/${encodeURIComponent(botId)}/${operation}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: pendingLifecycle.requestId }),
    });
    if (response.ok || (response.status >= 400 && response.status < 500)) {
      localStorage.removeItem(pendingLifecycleKey);
      pendingLifecycle = undefined;
      if (!response.ok) {
        const result: unknown = await response.json();
        lifecycleMessage.textContent =
          record(result) && typeof result.error === "string"
            ? result.error
            : "Lifecycle request rejected.";
      } else lifecycleMessage.textContent = "";
    }
  } catch {
    /* Keep the saved requestId so a later click retries the same lifecycle operation. */
  }
  lifecycleSending = false;
  if (pendingLifecycle) showLifecycleRecovery();
  else retryLifecycle.hidden = true;
  await load();
}

let summaries: BotSummary[] = [];
let loading = false;
async function load(): Promise<void> {
  if (loading) return;
  loading = true;
  refresh.disabled = true;
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (response.status === 401) {
      setHostAvailable(false);
      setNavigationAvailable(false);
      setShellBot(undefined);
      pairing.hidden = false;
      status.hidden = true;
      connection.textContent = "Pair this browser to inspect your local Host.";
      return;
    }
    if (!response.ok) throw new Error();
    const snapshot: unknown = await response.json();
    if (!isSnapshot(snapshot)) {
      connection.textContent =
        "Host returned invalid status. Displayed status may be stale. Refresh to retry.";
      return;
    }
    const [botResponse, optionResponse, summaryResponse] = await Promise.all([
      fetch("/api/bots"),
      fetch("/api/bot-options"),
      fetch("/api/bot-summaries"),
    ]);
    if (!botResponse.ok || !optionResponse.ok || !summaryResponse.ok) throw new Error();
    const managed: unknown = await botResponse.json();
    const options: unknown = await optionResponse.json();
    if (
      !record(managed) ||
      !Array.isArray(managed.bots) ||
      !managed.bots.every(isBot) ||
      !isOptions(options)
    )
      throw new Error();
    const summary: unknown = await summaryResponse.json();
    if (!record(summary) || !Array.isArray(summary.bots) || !summary.bots.every(isSummary))
      throw new Error();
    summaries = summary.bots;
    setHostAvailable(true);
    setNavigationAvailable(true);
    (document.getElementById("open-create") as HTMLButtonElement).disabled = false;
    renderOptions(options);
    render(snapshot, managed.bots);
    pairing.hidden = true;
    status.hidden = false;
    connection.textContent = "Connected to your local Host";
    (document.querySelector<HTMLElement>("#updated") as HTMLElement).textContent =
      `Last checked ${new Date().toLocaleTimeString()}`;
  } catch {
    setHostAvailable(false);
    setNavigationAvailable(false);
    connection.textContent =
      "Host unavailable. Displayed status may be stale. Keep the Host running; this page will reconnect automatically.";
  } finally {
    loading = false;
    refresh.disabled = false;
  }
}

(document.querySelector<HTMLFormElement>("#pair-form") as HTMLFormElement).addEventListener(
  "submit",
  async (event) => {
    event.preventDefault();
    pairButton.disabled = true;
    try {
      const response = await fetch("/api/pair", {
        method: "POST",
        headers: { Authorization: `Bearer ${credential.value.trim()}` },
      });
      if (!response.ok) {
        connection.textContent =
          response.status === 401
            ? "Connection credential rejected. Copy it from this Host’s data/client-credential file."
            : "Connection rejected. Open the local URL printed by the Host.";
        return;
      }
      credential.value = "";
      await load();
    } catch {
      connection.textContent = "Cannot reach the Host. Keep it running and try pairing again.";
    } finally {
      pairButton.disabled = false;
    }
  },
);
createForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  createButton.disabled = true;
  try {
    if (!pending) {
      const [provider, ...id] = model.value.split("/");
      const draft: Creation = {
        requestId: crypto.randomUUID(),
        name: botName.value,
        instructions: instructions.value,
        model: { provider: provider as string, id: id.join("/") },
        tools: [...tools.querySelectorAll<HTMLInputElement>("input:checked")].map(
          (input) => input.value,
        ),
      };
      // Persist before sending so a lost response or reload retries the same admission.
      localStorage.setItem(pendingKey, JSON.stringify(draft));
      pending = draft;
    }
    createFields.disabled = true;
    createButton.textContent = "Retry creation";
    const response = await fetch("/api/bots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pending),
    });
    const result: unknown = await response.json();
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500) {
        localStorage.removeItem(pendingKey);
        pending = undefined;
        createFields.disabled = false;
        createButton.textContent = "Create Bot";
      }
      createMessage.textContent =
        record(result) && typeof result.error === "string"
          ? result.error
          : "Creation failed. Retry the same request.";
      return;
    }
    if (!record(result) || !isBot(result.bot)) throw new Error();
    selectBot(result.bot.id);
    localStorage.removeItem(pendingKey);
    pending = undefined;
    createFields.disabled = false;
    createButton.textContent = "Create Bot";
    createForm.reset();
    createMessage.textContent = `Created ${result.bot.name}.`;
    closeCreation();
    await load();
  } catch {
    createMessage.textContent = pending
      ? "Creation response unconfirmed. Retry creation to recover the same Bot, including after reload."
      : "Could not save the creation request in this browser. Check local storage and retry.";
  } finally {
    createButton.disabled = false;
  }
});
settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedId || settingsSending || (pendingSettings && pendingSettings.botId !== selectedId))
    return;
  settingsSending = true;
  saveSettings.disabled = true;
  try {
    if (!pendingSettings || pendingSettings.botId !== selectedId) {
      const [provider, ...id] = savedModel.value.split("/");
      pendingSettings = {
        botId: selectedId,
        requestId: crypto.randomUUID(),
        name: "settings",
        skills: selectedSkills(),
        instructions: savedRole.value,
        model: { provider: provider as string, id: id.join("/") },
        tools: [...savedTools.querySelectorAll<HTMLInputElement>("input:checked")].map(
          (input) => input.value,
        ),
      };
      localStorage.setItem(pendingSettingsKey, JSON.stringify(pendingSettings));
    }
    settingsFields.disabled = true;
    showSettingsRecovery();
    saveSettings.textContent = "Retry configuration";
    const response = await fetch(
      `/api/bots/${encodeURIComponent(pendingSettings.botId)}/settings`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: pendingSettings.requestId,
          instructions: pendingSettings.instructions,
          model: pendingSettings.model,
          tools: pendingSettings.tools,
          ...(pendingSettings.skills ? { skills: pendingSettings.skills } : {}),
        }),
      },
    );
    const result: unknown = await response.json();
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500) {
        localStorage.removeItem(pendingSettingsKey);
        pendingSettings = undefined;
        settingsFields.disabled = false;
        saveSettings.textContent = "Save configuration";
      }
      settingsMessage.textContent =
        record(result) && typeof result.error === "string"
          ? result.error
          : "Configuration save failed. Retry the same request.";
      return;
    }
    if (!record(result) || !isBot(result.bot)) throw new Error();
    localStorage.removeItem(pendingSettingsKey);
    pendingSettings = undefined;
    settingsFields.disabled = false;
    saveSettings.textContent = "Save configuration";
    settingsIdentity = "";
    settingsMessage.textContent = `Saved configuration ${result.bot.savedVersion}. Effective configuration ${result.bot.effectiveVersion}.`;
    await load();
  } catch {
    settingsMessage.textContent = pendingSettings
      ? "Configuration response unconfirmed. Retry configuration to keep the same request, including after reload."
      : "Could not save the configuration request in this browser. Check local storage and retry.";
  } finally {
    settingsSending = false;
    saveSettings.disabled = !!pendingSettings && pendingSettings.botId !== selectedId;
    showSettingsRecovery();
  }
});
refresh.addEventListener("click", () => void load());
window.addEventListener("online", () => void load());
window.setInterval(() => {
  if (!document.hidden) void load();
}, 3000);
void load();
