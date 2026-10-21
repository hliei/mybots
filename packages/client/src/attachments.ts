interface AttachmentSource {
  delegationId: string;
  botId: string;
  taskId: string;
  runId: string;
  kind: "attachment" | "artifact";
  fileId: string;
}
interface Attachment {
  id: string;
  filename: string;
  bytes: number;
  runId: string | null;
  source: AttachmentSource | null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSource(value: unknown): value is AttachmentSource {
  return (
    record(value) &&
    typeof value.delegationId === "string" &&
    typeof value.botId === "string" &&
    typeof value.taskId === "string" &&
    typeof value.runId === "string" &&
    (value.kind === "attachment" || value.kind === "artifact") &&
    typeof value.fileId === "string"
  );
}
function isAttachment(value: unknown): value is Attachment {
  return (
    record(value) &&
    typeof value.id === "string" &&
    typeof value.filename === "string" &&
    typeof value.bytes === "number" &&
    (value.runId === null || typeof value.runId === "string") &&
    (value.source === null || isSource(value.source))
  );
}

function textField(value: unknown, key: string): string | undefined {
  return record(value) && typeof value[key] === "string" ? value[key] : undefined;
}

const form = document.querySelector<HTMLFormElement>("#attachment-form") as HTMLFormElement;
const task = document.querySelector<HTMLSelectElement>("#attachment-task") as HTMLSelectElement;
const file = document.querySelector<HTMLInputElement>("#attachment-file") as HTMLInputElement;
const message = document.querySelector<HTMLElement>("#attachment-message") as HTMLElement;
const list = document.querySelector<HTMLElement>("#attachment-list") as HTMLElement;
const DEFAULT_LIMIT = 25 * 1024 * 1024;
let botId: string | undefined;
let taskIds = "";
let maxBytes = DEFAULT_LIMIT;
let signature = "";
let busy = false;

function controls(): void {
  for (const node of form.querySelectorAll<
    HTMLInputElement | HTMLSelectElement | HTMLButtonElement
  >("input, select, button"))
    node.disabled = busy || !botId || task.options.length === 0;
}

function limitMessage(): string {
  return maxBytes === DEFAULT_LIMIT
    ? "File exceeds the 25 MiB limit."
    : `File exceeds the installation file limit of ${maxBytes} bytes.`;
}

export async function showAttachments(
  selectedBot: string | undefined,
  ids: string[],
): Promise<void> {
  const nextIds = ids.join("\n");
  if (botId !== selectedBot) {
    message.textContent = "";
    list.replaceChildren();
    file.value = "";
    signature = "";
  }
  botId = selectedBot;
  if (!selectedBot) {
    task.replaceChildren();
    taskIds = "";
    controls();
    return;
  }
  if (taskIds !== nextIds) {
    const previous = task.value;
    task.replaceChildren(
      ...ids.map((id) =>
        Object.assign(document.createElement("option"), {
          value: id,
          textContent: `Task ${id}`,
        }),
      ),
    );
    if ([...task.options].some((option) => option.value === previous)) task.value = previous;
    taskIds = nextIds;
    signature = "";
  }
  controls();
  await refresh();
  await refreshWorkspace();
}

async function refresh(): Promise<void> {
  if (!botId || !task.value) {
    list.replaceChildren();
    signature = "";
    return;
  }
  const response = await fetch(
    `/api/bots/${encodeURIComponent(botId)}/tasks/${encodeURIComponent(task.value)}/attachments`,
    { cache: "no-store" },
  );
  if (!response.ok) {
    message.textContent = "Task attachments are unavailable.";
    return;
  }
  const body: unknown = await response.json();
  if (!record(body) || !Array.isArray(body.attachments) || !body.attachments.every(isAttachment)) {
    message.textContent = "Task attachments are unavailable.";
    return;
  }
  if (typeof body.maxBytes === "number") maxBytes = body.maxBytes;
  const next = JSON.stringify(body.attachments);
  if (next === signature) return;
  const drafts = new Map(
    [...list.querySelectorAll<HTMLInputElement>("input")].map((input) => [
      input.dataset.attachmentId,
      input.value,
    ]),
  );
  signature = next;
  render(body.attachments, drafts);
}

function render(attachments: Attachment[], drafts: Map<string | undefined, string>): void {
  list.replaceChildren();
  if (!botId || !task.value) return;
  if (attachments.length === 0) {
    list.append(
      Object.assign(document.createElement("p"), { textContent: "This Task has no attachments." }),
    );
    return;
  }
  for (const item of attachments) {
    const article = document.createElement("article");
    article.dataset.attachmentId = item.id;
    article.append(
      Object.assign(document.createElement("p"), {
        textContent: `${item.filename} · ${item.bytes} bytes`,
      }),
    );
    if (item.source)
      article.append(
        Object.assign(document.createElement("p"), {
          textContent: `Receiving Bot ${botId} · Task ${task.value} · Run ${item.runId} · Delegation ${item.source.delegationId} · Source ${item.source.kind} ${item.source.fileId} · Bot ${item.source.botId} · Task ${item.source.taskId} · Run ${item.source.runId}`,
        }),
      );
    const download = document.createElement("a");
    download.href = `/api/bots/${encodeURIComponent(botId)}/tasks/${encodeURIComponent(task.value)}/attachments/${encodeURIComponent(item.id)}`;
    download.textContent = `Download ${item.filename}`;
    download.download = item.filename;
    article.append(download);
    const save = document.createElement("form");
    const path = document.createElement("input");
    path.required = true;
    path.maxLength = 240;
    path.dataset.attachmentId = item.id;
    path.value = drafts.get(item.id) ?? "";
    path.setAttribute("aria-label", `Workspace path for ${item.filename}`);
    const label = document.createElement("label");
    label.append("Bot workspace path", path);
    const button = document.createElement("button");
    button.type = "submit";
    button.textContent = "Save to Bot workspace";
    save.append(label, button);
    save.addEventListener("submit", (event) => {
      event.preventDefault();
      void saveToWorkspace(item, path.value);
    });
    article.append(save);
    list.append(article);
  }
}

async function saveToWorkspace(item: Attachment, path: string): Promise<void> {
  if (!botId || !task.value || busy) return;
  busy = true;
  controls();
  try {
    const response = await fetch(
      `/api/bots/${encodeURIComponent(botId)}/tasks/${encodeURIComponent(task.value)}/attachments/${encodeURIComponent(item.id)}/workspace`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      },
    );
    const payload: unknown = await response.json().catch(() => undefined);
    const savedPath = textField(payload, "path");
    message.textContent = response.ok
      ? `Saved ${item.filename} to the Bot workspace at ${savedPath ?? path}. Other Tasks of this Bot can reuse that file.`
      : (textField(payload, "error") ?? "Workspace save failed.");
    if (response.ok) await refreshWorkspace();
  } finally {
    busy = false;
    controls();
  }
}

async function refreshWorkspace(): Promise<void> {
  const node = document.querySelector("#workspace-files");
  if (!node) return;
  node.replaceChildren();
  if (!botId) return;
  const response = await fetch(`/api/bots/${encodeURIComponent(botId)}/workspace/files`, {
    cache: "no-store",
  });
  if (!response.ok) {
    node.append(
      Object.assign(document.createElement("li"), {
        textContent: "Workspace files are unavailable.",
      }),
    );
    return;
  }
  const body: unknown = await response.json();
  const listed = record(body) && Array.isArray(body.files) ? body.files : undefined;
  if (
    !listed?.every(
      (file) => record(file) && typeof file.path === "string" && typeof file.bytes === "number",
    )
  ) {
    node.append(
      Object.assign(document.createElement("li"), {
        textContent: "Workspace files are unavailable.",
      }),
    );
    return;
  }
  const files = listed as { path: string; bytes: number }[];
  if (files.length === 0) {
    node.append(
      Object.assign(document.createElement("li"), {
        textContent: "No workspace files.",
      }),
    );
    return;
  }
  for (const file of files) {
    node.append(
      Object.assign(document.createElement("li"), {
        textContent: `${file.path} · ${file.bytes} bytes`,
      }),
    );
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void upload();
});
task.addEventListener("change", () => {
  signature = "";
  message.textContent = "";
  void refresh();
});

async function upload(): Promise<void> {
  const chosen = file.files?.[0];
  if (!botId || !task.value || !chosen || busy) return;
  if (chosen.size > maxBytes) {
    message.textContent = limitMessage();
    return;
  }
  busy = true;
  controls();
  try {
    const response = await fetch(
      `/api/bots/${encodeURIComponent(botId)}/tasks/${encodeURIComponent(task.value)}/attachments`,
      {
        method: "POST",
        headers: { "X-Filename": encodeURIComponent(chosen.name) },
        body: chosen,
      },
    );
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      message.textContent = textField(payload, "error") ?? "Upload failed.";
      return;
    }
    const filename = textField(payload, "filename") ?? chosen.name;
    const size = record(payload) && typeof payload.bytes === "number" ? payload.bytes : chosen.size;
    message.textContent = `Uploaded ${filename} (${size} bytes) to the selected Task.`;
    file.value = "";
    signature = "";
    await refresh();
  } finally {
    busy = false;
    controls();
  }
}
