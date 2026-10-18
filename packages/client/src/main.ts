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

const pairing = document.querySelector<HTMLElement>("#pairing") as HTMLElement;
const status = document.querySelector<HTMLElement>("#status") as HTMLElement;
const connection = document.querySelector<HTMLElement>("#connection") as HTMLElement;
const bots = document.querySelector<HTMLElement>("#bots") as HTMLElement;
const credential = document.querySelector<HTMLInputElement>("#credential") as HTMLInputElement;
const pairButton = document.querySelector<HTMLButtonElement>(
  "#pair-form button",
) as HTMLButtonElement;
const refresh = document.querySelector<HTMLButtonElement>("#refresh") as HTMLButtonElement;

function render(snapshot: Snapshot): void {
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
    bots.append(article);
  }
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
    render(snapshot);
    pairing.hidden = true;
    status.hidden = false;
    connection.textContent = "Connected to your local Host · Read-only status";
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
refresh.addEventListener("click", () => void load());
window.addEventListener("online", () => void load());
window.setInterval(() => {
  if (!document.hidden) void load();
}, 3000);
void load();
