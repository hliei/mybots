import type {
  Bot,
  ChatMessage,
  ChatView,
  ModelChoice,
  ProviderStatus,
  WorkerStatus,
} from "@mybots/contracts";
import { request } from "./api.ts";
import { historyBrowser } from "./history.ts";
import { markdown } from "./markdown.ts";
import { restoreReadingPosition, selectReadingBot } from "./reading-position.ts";
import { resourceEditors } from "./resources.ts";

const node = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let bots: Bot[] = [];
let models: ModelChoice[] = [];
let selected: Bot | undefined;
let editing = false;
let events: EventSource | undefined;
let workerEvents: EventSource | undefined;
let workerStatus: WorkerStatus = { state: "ready" };
const workerAvailable = () => workerStatus.state === "ready" || workerStatus.state === "recovered";
function renderWorkerStatus(): void {
  node("connection").textContent =
    workerStatus.state === "recovering"
      ? `Worker recovering… attempt ${workerStatus.attempt}/3`
      : workerStatus.state === "failed"
        ? workerStatus.error
        : workerStatus.state === "recovered"
          ? "Worker recovered"
          : "Connected";
  node<HTMLButtonElement>("send").disabled =
    !workerAvailable() ||
    !models.some((model) => model.id === selected?.model && model.available !== false);
  if (!workerAvailable()) node<HTMLButtonElement>("stop").disabled = true;
}
let pending: { botId: string; text: string; requestId: string } | undefined;
const dialog = node<HTMLDialogElement>("bot-dialog");
const message = node<HTMLTextAreaElement>("message-text");

function report(error: unknown): void {
  node(node("pairing").hidden ? "chat-message" : "pairing-message").textContent =
    error instanceof Error ? error.message : "Request failed";
}

function renderMessages(view: ChatView): void {
  const container = node("thread-messages");
  const items: ChatMessage[] = [...view.messages];
  if (view.partial)
    items.push({
      id: "partial",
      role: "assistant",
      text: view.partial,
      tools: [],
      status: "In progress",
    });
  const keep = new Set(items.map((item) => item.id));
  for (const child of [...container.children])
    if (!keep.has((child as HTMLElement).dataset.messageId ?? "")) child.remove();
  for (const item of items) {
    let article = [...container.children].find(
      (child) => (child as HTMLElement).dataset.messageId === item.id,
    ) as HTMLElement | undefined;
    if (!article) {
      article = document.createElement("article");
      article.dataset.messageId = item.id;
      container.append(article);
    }
    article.className = `message ${item.role}`;
    const signature = JSON.stringify(item);
    if (article.dataset.content === signature) continue;
    article.dataset.content = signature;
    article.replaceChildren();
    const meta = document.createElement("div");
    meta.className = "message-meta";
    meta.textContent =
      item.role === "user"
        ? "You"
        : item.role === "tool"
          ? "Tool result"
          : (selected?.name ?? "Bot");
    if (item.status && !["stop", "toolUse"].includes(item.status))
      meta.textContent += ` · ${item.status}`;
    article.append(
      meta,
      markdown(item.text, async () => item.text),
    );
    if (item.tools.length) {
      const tools = document.createElement("p");
      tools.textContent = `Tools: ${item.tools.join(", ")}`;
      article.append(tools);
    }
  }
  node("live-execution").textContent = view.activity.join(" · ") || (view.busy ? "Working…" : "");
  node<HTMLButtonElement>("stop").disabled =
    !view.busy && !view.inputs.some((input) => input.status === "queued");
  const unprocessed = node("unprocessed");
  unprocessed.replaceChildren();
  for (const input of view.inputs) {
    const row = document.createElement("article");
    row.className = "message user";
    const content = document.createElement("p");
    content.textContent = input.text;
    const status = document.createElement("p");
    status.textContent =
      input.status === "queued"
        ? "Queued for steering"
        : `Unprocessed · ${input.reason ?? "withdrawn"}${input.detail ? ` · ${input.detail}` : ""}`;
    row.append(content, status);
    if (input.status === "unanswered") {
      const resend = document.createElement("button");
      resend.textContent = "Resend";
      resend.addEventListener("click", () => {
        message.value = input.text;
        message.focus();
      });
      row.append(resend);
    }
    unprocessed.append(row);
  }
  restoreReadingPosition();
}
function choose(bot: Bot): void {
  selected = bot;
  localStorage.setItem("durable-bot", bot.id);
  events?.close();
  node("thread-messages").replaceChildren();
  node("unprocessed").replaceChildren();
  node("live-execution").textContent = "";
  selectReadingBot(bot.id);
  node("bot-identity-name").textContent = bot.name;
  (node("bot-identity").querySelector(".avatar") as HTMLElement).textContent = (
    Array.from(bot.name)[0] ?? "?"
  ).toUpperCase();
  message.disabled = false;
  message.placeholder = `Message ${bot.name}…`;
  const available = models.some((model) => model.id === bot.model && model.available !== false);
  node<HTMLButtonElement>("send").disabled = !available;
  node("chat-message").textContent =
    !workerAvailable() || available
      ? ""
      : "Save the provider key in Provider settings, or choose an available model in Bot settings.";
  node<HTMLButtonElement>("edit-bot").disabled = false;
  node<HTMLButtonElement>("open-history").disabled = false;
  for (const row of node("bot-list").children)
    row.classList.toggle("selected", (row as HTMLElement).dataset.botId === bot.id);
  events = new EventSource(`/api/bots/${bot.id}/events`);
  events.onmessage = (event) => {
    const view = JSON.parse(event.data) as ChatView;
    if (view.botId === selected?.id) renderMessages(view);
    renderWorkerStatus();
  };
  events.onerror = () => {
    if (workerAvailable()) node("connection").textContent = "Reconnecting…";
  };
}
async function refresh(preferred?: string): Promise<void> {
  const data = await request<{ bots: Bot[]; models: ModelChoice[]; worker: WorkerStatus }>("bots");
  workerStatus = data.worker;
  bots = data.bots;
  models = data.models;
  node("pairing").hidden = true;
  node("workspace").hidden = false;
  renderWorkerStatus();
  if (!workerEvents) {
    workerEvents = new EventSource("/api/worker/events");
    workerEvents.addEventListener("worker", (event) => {
      workerStatus = JSON.parse((event as MessageEvent).data) as WorkerStatus;
      renderWorkerStatus();
      if (workerAvailable() && !models.length) void refresh(selected?.id).catch(report);
    });
    workerEvents.onerror = () => {
      node("connection").textContent = "Reconnecting…";
    };
  }
  node("bot-list").replaceChildren();
  for (const bot of bots) {
    const row = document.createElement("div");
    row.className = "bot-row";
    row.dataset.botId = bot.id;
    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.textContent = (Array.from(bot.name)[0] ?? "?").toUpperCase();
    const name = document.createElement("h3");
    name.textContent = bot.name;
    const detail = document.createElement("p");
    detail.textContent =
      models.find((model) => model.id === bot.model)?.name ??
      (workerAvailable() ? "Model unavailable" : "Worker unavailable");
    const button = document.createElement("button");
    button.className = "choose-bot";
    button.type = "button";
    button.setAttribute("aria-label", `Select ${bot.name}`);
    button.addEventListener("click", () => choose(bot));
    row.append(avatar, name, detail, button);
    node("bot-list").append(row);
  }
  const bot =
    bots.find(
      (bot) => bot.id === (preferred ?? selected?.id ?? localStorage.getItem("durable-bot")),
    ) ?? bots[0];
  if (bot) choose(bot);
}
function openBot(edit: boolean): void {
  const bot = edit ? selected : undefined;
  if (edit && !bot) return;
  editing = edit;
  node("bot-dialog-title").textContent = edit ? "Bot settings" : "Create Bot";
  node<HTMLInputElement>("bot-name").value = bot?.name ?? "";
  node<HTMLTextAreaElement>("bot-instructions").value = bot?.instructions ?? "";
  const model = node<HTMLSelectElement>("bot-model");
  model.replaceChildren();
  for (const choice of models) {
    const option = document.createElement("option");
    option.value = choice.id;
    option.textContent = `${choice.name}${choice.available === false ? " · key required" : ""}`;
    model.append(option);
  }
  if (bot && !models.some((choice) => choice.id === bot.model)) {
    const option = document.createElement("option");
    option.value = bot.model;
    option.textContent = `${bot.model} · unavailable saved model`;
    model.append(option);
  }
  if (bot) model.value = bot.model;
  node("bot-error").textContent = models.length
    ? ""
    : "Save a provider key in Provider settings first.";
  dialog.showModal();
  node("bot-name").focus();
}
node("open-create").addEventListener("click", () => openBot(false));
node("edit-bot").addEventListener("click", () => openBot(true));
node("close-bot").addEventListener("click", () => dialog.close());
node("bot-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const configuration = {
    name: node<HTMLInputElement>("bot-name").value,
    instructions: node<HTMLTextAreaElement>("bot-instructions").value,
    model: node<HTMLSelectElement>("bot-model").value,
  };
  void request<Bot>(
    editing ? `bots/${selected?.id}` : "bots",
    configuration,
    editing ? "PATCH" : "POST",
  )
    .then(async (bot) => {
      dialog.close();
      await refresh(bot.id);
    })
    .catch((error) => {
      node("bot-error").textContent = error.message;
    });
});
node("pair-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void fetch("/api/pair", {
    method: "POST",
    headers: { Authorization: `Bearer ${node<HTMLInputElement>("credential").value}` },
  })
    .then(async (response) => {
      if (!response.ok) throw new Error("Connection credential rejected.");
      node<HTMLInputElement>("credential").value = "";
      await refresh();
    })
    .catch(report);
});
node("message-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (
    !selected ||
    !workerAvailable() ||
    !message.value.trim() ||
    !models.some((model) => model.id === selected?.model && model.available !== false)
  )
    return;
  const text = message.value;
  if (!pending || pending.botId !== selected.id || pending.text !== text)
    pending = { botId: selected.id, text, requestId: crypto.randomUUID() };
  const sending = pending;
  node<HTMLButtonElement>("send").disabled = true;
  void request(`bots/${sending.botId}/send`, sending)
    .then(() => {
      if (selected?.id === sending.botId && message.value === sending.text) message.value = "";
      if (pending === sending) pending = undefined;
      node("chat-message").textContent = "";
    })
    .catch(report)
    .finally(() => {
      node<HTMLButtonElement>("send").disabled =
        !workerAvailable() ||
        !models.some((model) => model.id === selected?.model && model.available !== false);
    });
});
message.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    node<HTMLFormElement>("message-form").requestSubmit();
  }
});
node("stop").addEventListener("click", () => {
  if (selected) void request(`bots/${selected.id}/stop`, {}).catch(report);
});
resourceEditors(() => selected);
historyBrowser(() => selected);
void refresh().catch(() => {
  node("pairing").hidden = false;
  node("workspace").hidden = true;
});

const providersDialog = node<HTMLDialogElement>("providers-dialog");
function showProviders(providers: ProviderStatus[]): void {
  for (const provider of providers) {
    node(`${provider.id}-status`).textContent = provider.configured
      ? "Saved locally. Access is checked when you send a message."
      : "Not configured";
    node<HTMLButtonElement>(`${provider.id}-remove`).disabled = !provider.configured;
  }
}
node("open-providers").addEventListener("click", () => {
  void request<ProviderStatus[]>("providers")
    .then((providers) => {
      showProviders(providers);
      providersDialog.showModal();
    })
    .catch(report);
});
node("close-providers").addEventListener("click", () => providersDialog.close());
providersDialog.addEventListener("close", () => {
  for (const id of ["deepseek", "opencode-go"]) node<HTMLInputElement>(`${id}-key`).value = "";
});
for (const id of ["deepseek", "opencode-go"]) {
  const save = async (remove: boolean) => {
    const field = node<HTMLInputElement>(`${id}-key`);
    const key = field.value;
    field.value = "";
    node<HTMLButtonElement>(`${id}-save`).disabled = true;
    node<HTMLButtonElement>(`${id}-remove`).disabled = true;
    try {
      showProviders(
        await request<ProviderStatus[]>(
          `providers/${id}`,
          remove ? undefined : { apiKey: key },
          remove ? "DELETE" : "PUT",
        ),
      );
      await refresh();
    } catch {
      node(`${id}-status`).textContent =
        "Could not update provider settings. Enter a valid key and retry.";
      node<HTMLButtonElement>(`${id}-remove`).disabled = false;
    } finally {
      node<HTMLButtonElement>(`${id}-save`).disabled = false;
    }
  };
  node(`${id}-form`).addEventListener("submit", (event) => {
    event.preventDefault();
    void save(false);
  });
  node(`${id}-remove`).addEventListener("click", () => {
    void save(true);
  });
}
