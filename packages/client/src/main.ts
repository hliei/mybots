import { showChat } from "./chat.ts";

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

interface Bot {
  id: string;
  name: string;
  workspace: string;
  instructions: string;
  model: { provider: string; id: string };
  tools: string[];
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
    isModel(value.model) &&
    isStrings(value.tools)
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
const bots = document.querySelector<HTMLElement>("#bots") as HTMLElement;
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
const pendingKey = "mybots.pending-bot";
let selectedId = localStorage.getItem("mybots.selected-bot");
let pending: Creation | undefined;
try {
  const stored: unknown = JSON.parse(localStorage.getItem(pendingKey) ?? "null");
  if (isCreation(stored)) pending = stored;
} catch {
  /* An unreadable draft has no valid request to retry. */
}
let currentOptions = "";

function selectBot(id: string): void {
  selectedId = id;
  localStorage.setItem("mybots.selected-bot", id);
}

function renderOptions(options: BotOptions): void {
  const signature = JSON.stringify(options);
  if (signature === currentOptions) return;
  currentOptions = signature;
  const previousModel = model.value;
  model.replaceChildren(
    ...options.models.map((choice) => {
      const option = document.createElement("option");
      option.value = `${choice.provider}/${choice.id}`;
      option.textContent = option.value;
      return option;
    }),
  );
  if (options.models.some((choice) => `${choice.provider}/${choice.id}` === previousModel))
    model.value = previousModel;
  tools.replaceChildren(Object.assign(document.createElement("legend"), { textContent: "Tools" }));
  for (const tool of options.tools) {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = tool;
    label.append(checkbox, document.createTextNode(tool));
    tools.append(label);
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
  bots.replaceChildren();
  for (const bot of snapshot.bots) {
    const article = document.createElement("article");
    const heading = document.createElement("h3");
    heading.textContent = bot.name;
    const identity = document.createElement("p");
    identity.textContent = `Bot ID: ${bot.id}`;
    article.append(heading, identity);
    const sessions = snapshot.sessions.filter((session) => session.botId === bot.id);
    if (sessions.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = "No sessions yet.";
      article.append(empty);
    } else {
      const list = document.createElement("ul");
      for (const session of sessions) {
        const item = document.createElement("li");
        const id = document.createElement("code");
        id.className = "session-id";
        id.textContent = session.id;
        const progress = document.createElement("span");
        progress.textContent = `Destination: ${session.destinationId} · Session: ${session.status} · Container: ${session.containerStatus}. Inputs: ${session.inputs.pending} pending, ${session.inputs.processing} processing, ${session.inputs.acknowledged} acknowledged, ${session.inputs.failed} failed.`;
        item.append(id, progress);
        list.append(item);
      }
      article.append(list);
    }
    const choose = document.createElement("button");
    choose.type = "button";
    choose.textContent = `Select ${bot.name}`;
    choose.setAttribute("aria-pressed", String(selectedId === bot.id));
    choose.addEventListener("click", () => {
      selectBot(bot.id);
      render(snapshot, managed);
    });
    article.append(choose);
    bots.append(article);
  }
  const active = managed.find((bot) => bot.id === selectedId);
  selected.hidden = !active;
  selected.replaceChildren();
  if (active) {
    const heading = document.createElement("h2");
    heading.textContent = active.name;
    selected.append(heading);
    for (const text of [
      `Bot ID: ${active.id}`,
      `Workspace: ${active.workspace}`,
      `Role: ${active.instructions}`,
      `Model: ${active.model.provider}/${active.model.id}`,
      `Tools: ${active.tools.join(", ") || "None"}`,
    ]) {
      const paragraph = document.createElement("p");
      paragraph.textContent = text;
      selected.append(paragraph);
    }
  }
  void showChat(active?.id);
  if (snapshot.bots.length === 0) bots.textContent = "No Bots configured.";
}

let loading = false;
async function load(): Promise<void> {
  if (loading) return;
  loading = true;
  refresh.disabled = true;
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (response.status === 401) {
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
    const [botResponse, optionResponse] = await Promise.all([
      fetch("/api/bots"),
      fetch("/api/bot-options"),
    ]);
    if (!botResponse.ok || !optionResponse.ok) throw new Error();
    const managed: unknown = await botResponse.json();
    const options: unknown = await optionResponse.json();
    if (
      !record(managed) ||
      !Array.isArray(managed.bots) ||
      !managed.bots.every(isBot) ||
      !isOptions(options)
    )
      throw new Error();
    renderOptions(options);
    render(snapshot, managed.bots);
    pairing.hidden = true;
    status.hidden = false;
    connection.textContent = "Connected to your local Host";
    (document.querySelector<HTMLElement>("#updated") as HTMLElement).textContent =
      `Last checked ${new Date().toLocaleTimeString()}`;
  } catch {
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
    await load();
  } catch {
    createMessage.textContent = pending
      ? "Creation response unconfirmed. Retry creation to recover the same Bot, including after reload."
      : "Could not save the creation request in this browser. Check local storage and retry.";
  } finally {
    createButton.disabled = false;
  }
});
refresh.addEventListener("click", () => void load());
window.addEventListener("online", () => void load());
window.setInterval(() => {
  if (!document.hidden) void load();
}, 3000);
void load();
