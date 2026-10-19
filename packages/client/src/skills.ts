export interface SkillSelection {
  id: string;
  revision: string;
}
interface Revision extends SkillSelection {
  files: { path: string; base64: string }[];
}
const choices = document.querySelector<HTMLFieldSetElement>("#saved-skills") as HTMLFieldSetElement;
const section = document.querySelector<HTMLElement>("#local-skills") as HTMLElement;
const message = document.querySelector<HTMLElement>("#skill-message") as HTMLElement;
const library = document.querySelector<HTMLElement>("#skill-library") as HTMLElement;
let currentBot: string | undefined;
let signature = "";
let saved: SkillSelection[] = [];
let loadedBot: string | undefined;
let requestVersion = 0;

export function selectedSkills(): SkillSelection[] {
  if (!currentBot || loadedBot !== currentBot)
    throw new Error("Refresh local Skills before saving.");
  return [...choices.querySelectorAll("select")].flatMap((select) =>
    select.value ? [{ id: select.name, revision: select.value }] : [],
  );
}

export async function showSkills(
  botId: string | undefined,
  selection: SkillSelection[] = [],
): Promise<void> {
  const request = ++requestVersion;
  if (currentBot !== botId) {
    loadedBot = undefined;
    library.replaceChildren();
    choices.replaceChildren();
  }
  currentBot = botId;
  saved = selection;
  section.hidden = !botId;
  if (!botId) return;
  try {
    const response = await fetch(`/api/bots/${encodeURIComponent(botId)}/skills`);
    if (!response.ok) throw new Error();
    const { revisions } = (await response.json()) as { revisions: Revision[] };
    if (currentBot !== botId || request !== requestVersion) return;
    loadedBot = botId;
    const next = JSON.stringify([botId, selection, revisions]);
    if (next === signature) return;
    signature = next;
    choices.replaceChildren(
      Object.assign(document.createElement("legend"), {
        textContent: "Skill revisions to activate on save",
      }),
    );
    library.replaceChildren();
    for (const id of new Set(revisions.map((revision) => revision.id))) {
      const label = document.createElement("label");
      label.textContent = `Skill ${id}`;
      const select = document.createElement("select");
      select.name = id;
      select.setAttribute("aria-label", `Skill ${id}`);
      select.append(
        Object.assign(document.createElement("option"), { value: "", textContent: "Disabled" }),
      );
      for (const revision of revisions.filter((revision) => revision.id === id))
        select.append(
          Object.assign(document.createElement("option"), {
            value: revision.revision,
            textContent: revision.revision,
          }),
        );
      select.value = selection.find((skill) => skill.id === id)?.revision ?? "";
      label.append(select);
      choices.append(label);
    }
    for (const revision of revisions) {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = `${revision.id} · ${revision.revision}`;
      details.append(summary);
      for (const file of revision.files) {
        const name = document.createElement("h4");
        name.textContent = file.path;
        const pre = document.createElement("pre");
        pre.textContent = new TextDecoder().decode(
          Uint8Array.from(atob(file.base64), (char) => char.charCodeAt(0)),
        );
        details.append(name, pre);
      }
      library.append(details);
    }
    message.textContent =
      "Inspect imported files, then select revisions and Save configuration to activate them.";
  } catch {
    if (currentBot !== botId || request !== requestVersion) return;
    loadedBot = undefined;
    message.textContent = "Local Skills unavailable. Refresh before changing Skill selection.";
  }
}

(document.querySelector<HTMLFormElement>("#skill-import") as HTMLFormElement).addEventListener(
  "submit",
  async (event) => {
    event.preventDefault();
    const botId = currentBot;
    if (!botId) return;
    const form = event.currentTarget as HTMLFormElement;
    const button = form.querySelector("button") as HTMLButtonElement;
    button.disabled = true;
    try {
      const response = await fetch(`/api/bots/${encodeURIComponent(botId)}/skills`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: (form.elements.namedItem("skill-id") as HTMLInputElement).value,
          path: (form.elements.namedItem("skill-path") as HTMLInputElement).value,
        }),
      });
      if (currentBot !== botId) return;
      if (!response.ok) {
        message.textContent = (await response.json()).error;
        return;
      }
      const selection = loadedBot === botId ? selectedSkills() : saved;
      signature = "";
      await showSkills(botId, selection);
    } catch {
      message.textContent =
        "Import response unconfirmed. Inspect the local library before retrying.";
    } finally {
      button.disabled = false;
    }
  },
);
