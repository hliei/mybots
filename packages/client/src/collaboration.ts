const form = document.getElementById("collaboration-form") as HTMLFormElement;
const target = document.getElementById("collaboration-target") as HTMLSelectElement;
const mode = document.getElementById("collaboration-mode") as HTMLSelectElement;
const notice = document.getElementById("collaboration-notice") as HTMLParagraphElement;
const retry = document.getElementById("collaboration-retry") as HTMLButtonElement;

interface Peer {
  targetBotId: string;
  name: string;
  mode: "deny" | "ask-each-time" | "allow";
}
interface Pending {
  botId: string;
  requestId: string;
  targetBotId: string;
  mode: "deny" | "ask-each-time" | "allow";
}

let botId: string | undefined;
let refresh: (() => void) | undefined;
let sending = false;
let pending: Pending | undefined;
let admitting = true;

function controls(): void {
  const busy = sending || !!pending || !admitting;
  target.disabled = mode.disabled = busy || target.options.length === 0;
  const button = form.querySelector("button");
  if (button) button.disabled = busy || target.options.length === 0;
  retry.hidden = !pending;
  retry.disabled = sending;
  if (pending)
    notice.textContent = `Delegation permission unconfirmed for ${pending.targetBotId}: ${pending.mode}. Retry the saved request.`;
}

export function showCollaboration(
  selectedBotId: string | undefined,
  peers: Peer[],
  reload: () => void,
  nextAdmitting = true,
): void {
  admitting = nextAdmitting;
  botId = selectedBotId;
  refresh = reload;
  const section = document.getElementById("collaboration") as HTMLElement;
  section.hidden = !selectedBotId;
  if (!selectedBotId) return;
  const previous = target.value;
  target.replaceChildren(
    ...peers.map((peer) =>
      Object.assign(document.createElement("option"), {
        value: peer.targetBotId,
        textContent: `${peer.name} (${peer.targetBotId}) · ${peer.mode}`,
      }),
    ),
  );
  if ([...target.options].some((option) => option.value === previous)) target.value = previous;
  const selected = peers.find((peer) => peer.targetBotId === target.value);
  if (selected && !form.matches(":focus-within") && !pending) mode.value = selected.mode;
  controls();
}

async function save(input: Pending): Promise<void> {
  if (!botId || sending) return;
  sending = true;
  pending = input;
  controls();
  try {
    const response = await fetch(
      `/api/bots/${encodeURIComponent(input.botId)}/collaboration/${encodeURIComponent(input.targetBotId)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: input.requestId, mode: input.mode }),
      },
    );
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const message =
        body && typeof body === "object" && "error" in body && typeof body.error === "string"
          ? body.error
          : "Delegation permission was not saved.";
      throw new Error(message);
    }
    pending = undefined;
    notice.textContent = `Delegation from this Bot to ${input.targetBotId} is ${input.mode}. The other direction stays independent.`;
    refresh?.();
  } catch (error) {
    notice.textContent =
      error instanceof Error ? error.message : "Delegation permission was not saved.";
  } finally {
    sending = false;
    controls();
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!botId || sending || pending || !target.value) return;
  void save({
    botId,
    requestId: crypto.randomUUID(),
    targetBotId: target.value,
    mode:
      mode.value === "ask-each-time" ? "ask-each-time" : mode.value === "allow" ? "allow" : "deny",
  });
});
target.addEventListener("change", () => {
  const match = /\b(deny|ask-each-time|allow)$/.exec(target.selectedOptions[0]?.textContent ?? "");
  if (match?.[1] && !pending) mode.value = match[1];
});
retry.addEventListener("click", () => {
  if (pending) void save(pending);
});
