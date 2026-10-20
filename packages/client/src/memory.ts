interface MemoryFile {
  kind: "index" | "definition" | "topic";
  id: string | null;
  content: string;
  version: string;
  characters: number;
  truncated: boolean;
}
interface MemoryView {
  index: MemoryFile | null;
  definition: MemoryFile | null;
  topics: MemoryFile[];
  coreCharacterLimit: number;
}
interface Observed {
  target: "index" | "definition" | "topic";
  file: MemoryFile | null;
}

const section = document.querySelector<HTMLElement>("#memory") as HTMLElement;
const message = document.querySelector<HTMLElement>("#memory-message") as HTMLElement;
const conflict = document.querySelector<HTMLElement>("#memory-conflict") as HTMLElement;
const indexText = document.querySelector<HTMLTextAreaElement>(
  "#memory-index-text",
) as HTMLTextAreaElement;
const definitionText = document.querySelector<HTMLTextAreaElement>(
  "#memory-definition-text",
) as HTMLTextAreaElement;
const topicId = document.querySelector<HTMLInputElement>("#memory-topic-id") as HTMLInputElement;
const topicText = document.querySelector<HTMLTextAreaElement>(
  "#memory-topic-text",
) as HTMLTextAreaElement;
const topicList = document.querySelector<HTMLElement>("#memory-topics") as HTMLElement;
const indexMeta = document.querySelector<HTMLElement>("#memory-index-meta") as HTMLElement;
const definitionMeta = document.querySelector<HTMLElement>(
  "#memory-definition-meta",
) as HTMLElement;
const topicMeta = document.querySelector<HTMLElement>("#memory-topic-meta") as HTMLElement;
let currentBot: string | undefined;
let requestVersion = 0;
let observed: Observed | undefined;
const versions = {
  index: null as string | null,
  definition: null as string | null,
  topic: null as string | null,
};
let loaded = { index: "", definition: "", topic: "" };

function isMemoryFile(value: unknown): value is MemoryFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const file = value as Record<string, unknown>;
  return (
    (file.kind === "index" || file.kind === "definition" || file.kind === "topic") &&
    (file.id === null || typeof file.id === "string") &&
    typeof file.content === "string" &&
    typeof file.version === "string" &&
    typeof file.characters === "number" &&
    typeof file.truncated === "boolean"
  );
}

function isMemoryView(value: unknown): value is MemoryView {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const view = value as Record<string, unknown>;
  return (
    (view.index === null || isMemoryFile(view.index)) &&
    (view.definition === null || isMemoryFile(view.definition)) &&
    Array.isArray(view.topics) &&
    view.topics.every(isMemoryFile) &&
    typeof view.coreCharacterLimit === "number"
  );
}

function note(file: MemoryFile | null, limit: number, label: string): string {
  if (!file) return `${label} is not saved. Execution does not load it.`;
  const truncation = file.truncated
    ? ` Execution loads the first ${limit} characters and can read the file for the rest.`
    : "";
  return `${file.characters} characters.${truncation}`;
}

function assign(
  area: HTMLTextAreaElement,
  key: "index" | "definition" | "topic",
  next: string,
  force: boolean,
): boolean {
  if (force || area.value === loaded[key]) {
    area.value = next;
    loaded[key] = next;
    return true;
  }
  return false;
}

function apply(view: MemoryView, force: boolean): void {
  if (assign(indexText, "index", view.index?.content ?? "", force))
    versions.index = view.index?.version ?? null;
  if (assign(definitionText, "definition", view.definition?.content ?? "", force))
    versions.definition = view.definition?.version ?? null;
  const selected = view.topics.find((topic) => topic.id === topicId.value);
  if (selected) {
    if (assign(topicText, "topic", selected.content, force)) versions.topic = selected.version;
  } else if (!topicId.value && assign(topicText, "topic", "", force)) versions.topic = null;
  indexMeta.textContent = note(view.index, view.coreCharacterLimit, "Index");
  definitionMeta.textContent = note(view.definition, view.coreCharacterLimit, "Definition");
  topicList.replaceChildren();
  for (const topic of view.topics) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = topic.id;
    button.addEventListener("click", () => {
      topicId.value = topic.id ?? "";
      topicText.value = topic.content;
      loaded.topic = topic.content;
      versions.topic = topic.version;
      topicMeta.textContent = `${topic.characters} characters. Topic text is read from the file; it is not part of the initial 16,000-character load.`;
    });
    topicList.append(button);
  }
  if (!view.topics.some((topic) => topic.id === topicId.value))
    topicMeta.textContent = topicId.value
      ? "New topic. Saving creates memory/topics/<id>.md."
      : "Choose a topic or enter a new id.";
}

async function load(botId: string): Promise<void> {
  const request = ++requestVersion;
  const response = await fetch(`/api/bots/${encodeURIComponent(botId)}/memory`, {
    cache: "no-store",
  });
  if (!response.ok || currentBot !== botId || request !== requestVersion) return;
  const body: unknown = await response.json();
  if (!isMemoryView(body)) return;
  apply(body, false);
}

export async function showMemory(botId: string | undefined): Promise<void> {
  const switched = currentBot !== botId;
  if (switched) {
    observed = undefined;
    conflict.hidden = true;
    message.textContent = "";
    indexText.value = "";
    definitionText.value = "";
    topicId.value = "";
    topicText.value = "";
    versions.index = null;
    versions.definition = null;
    versions.topic = null;
    loaded = { index: "", definition: "", topic: "" };
  }
  currentBot = botId;
  section.hidden = !botId;
  if (!botId) return;
  try {
    await load(botId);
  } catch {
    message.textContent = "Memory could not be loaded. Refresh to retry.";
  }
}

function showObserved(target: Observed["target"], file: MemoryFile | null): void {
  observed = { target, file };
  conflict.hidden = false;
  conflict.textContent = file
    ? `Observed intervening ${target} memory. Reread it and reconcile before saving again.\n\n${file.content}`
    : `Observed that the ${target} file is gone. Reread memory before saving again.`;
}

async function send(
  target: "index" | "definition" | "topic",
  method: "PUT" | "DELETE",
): Promise<void> {
  if (!currentBot) return;
  message.textContent = "";
  const id = topicId.value.trim();
  if (target === "topic" && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
    message.textContent = "Topic id must use lowercase letters, digits, and hyphens.";
    return;
  }
  const path =
    target === "topic"
      ? `/api/bots/${encodeURIComponent(currentBot)}/memory/topics/${encodeURIComponent(id)}`
      : `/api/bots/${encodeURIComponent(currentBot)}/memory/${target}`;
  const version = target === "topic" ? versions.topic : versions[target];
  const content =
    target === "index"
      ? indexText.value
      : target === "definition"
        ? definitionText.value
        : topicText.value;
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(method === "DELETE" ? { version } : { content, version }),
  });
  const body: unknown = await response.json();
  const record =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const error = typeof record.error === "string" ? record.error : undefined;
  if (response.status === 409 && "observed" in record) {
    showObserved(target, isMemoryFile(record.observed) ? record.observed : null);
    message.textContent = error ?? "Memory changed since it was read.";
    return;
  }
  if (!response.ok || !isMemoryView(body)) {
    message.textContent = error ?? "Memory could not be saved.";
    return;
  }
  conflict.hidden = true;
  observed = undefined;
  message.textContent =
    method === "DELETE"
      ? "Deleted. Execution stops loading this file as current memory. Conversation evidence remains, this does not guarantee forgetting, and a later save can record a fact again."
      : "Saved. The next Run turn loads this current memory. An in-flight model request keeps the memory it already started with.";
  apply(body, true);
}

topicId.addEventListener("input", () => {
  versions.topic = null;
});

document.querySelector<HTMLFormElement>("#memory-index")?.addEventListener("submit", (event) => {
  event.preventDefault();
  void send("index", "PUT").catch(() => {
    message.textContent = "Memory could not be saved. Keep the Host running and try again.";
  });
});
document
  .querySelector<HTMLFormElement>("#memory-definition")
  ?.addEventListener("submit", (event) => {
    event.preventDefault();
    void send("definition", "PUT").catch(() => {
      message.textContent = "Memory could not be saved. Keep the Host running and try again.";
    });
  });
document.querySelector<HTMLFormElement>("#memory-topic")?.addEventListener("submit", (event) => {
  event.preventDefault();
  void send("topic", "PUT").catch(() => {
    message.textContent = "Memory could not be saved. Keep the Host running and try again.";
  });
});
for (const [id, target] of [
  ["memory-index-delete", "index"],
  ["memory-definition-delete", "definition"],
  ["memory-topic-delete", "topic"],
] as const) {
  document.querySelector<HTMLButtonElement>(`#${id}`)?.addEventListener("click", () => {
    void send(target, "DELETE").catch(() => {
      message.textContent = "Memory could not be deleted. Keep the Host running and try again.";
    });
  });
}
document.querySelector<HTMLButtonElement>("#memory-use-observed")?.addEventListener("click", () => {
  if (!observed) return;
  const file = observed.file;
  if (observed.target === "index") {
    indexText.value = file?.content ?? "";
    loaded.index = indexText.value;
    versions.index = file?.version ?? null;
  } else if (observed.target === "definition") {
    definitionText.value = file?.content ?? "";
    loaded.definition = definitionText.value;
    versions.definition = file?.version ?? null;
  } else {
    topicText.value = file?.content ?? "";
    loaded.topic = topicText.value;
    versions.topic = file?.version ?? null;
    if (file?.id) topicId.value = file.id;
  }
  message.textContent = "Loaded the observed file. Edit it, then save to reconcile.";
});
