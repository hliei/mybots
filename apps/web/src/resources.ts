import type { Bot, MemoryDocument, Skill } from "@mybots/contracts";
import { request } from "./api.ts";

const node = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// Keep edits and scope selection fixed while a resource request is pending.
function editResource(kind: "skill" | "memory", action: () => Promise<void>): void {
  const fields = node<HTMLFieldSetElement>(`${kind}-fields`);
  if (fields.disabled) return;
  fields.disabled = true;
  node(`${kind}-status`).textContent = "Loading…";
  void action()
    .catch((error: unknown) => {
      node(`${kind}-status`).textContent =
        error instanceof Error ? error.message : "Request failed";
    })
    .finally(() => {
      fields.disabled = false;
    });
}

export function resourceEditors(currentBot: () => Bot | undefined): void {
  const skillsDialog = node<HTMLDialogElement>("skills-dialog");
  const skillList = node<HTMLSelectElement>("skill-list");
  const name = node<HTMLInputElement>("skill-name");
  const description = node<HTMLInputElement>("skill-description");
  const content = node<HTMLTextAreaElement>("skill-content");
  function skillFields(skill?: Skill): void {
    name.value = skill?.name ?? "";
    name.readOnly = skill !== undefined;
    description.value = skill?.description ?? "";
    content.value = skill?.content ?? "";
    description.readOnly = content.readOnly = skill?.readOnly ?? false;
    node<HTMLButtonElement>("save-skill").disabled = skill?.readOnly ?? false;
    node<HTMLButtonElement>("delete-skill").disabled = !skill || skill.readOnly;
    node("skill-status").textContent = skill?.readOnly
      ? "Built-in · read-only"
      : "Shared across all Bots";
  }
  async function listSkills(preferred = ""): Promise<void> {
    const { skills } = await request<{ skills: Omit<Skill, "content">[] }>("skills");
    skillList.replaceChildren(
      new Option("New user Skill", ""),
      ...skills.map(
        (skill) => new Option(`${skill.name}${skill.readOnly ? " · built-in" : ""}`, skill.name),
      ),
    );
    skillList.value = preferred;
  }
  async function selectSkill(): Promise<void> {
    node<HTMLButtonElement>("save-skill").disabled = true;
    node<HTMLButtonElement>("delete-skill").disabled = true;
    const skill = skillList.value ? await request<Skill>(`skills/${skillList.value}`) : undefined;
    skillFields(skill);
  }
  node("open-skills").addEventListener("click", () => {
    skillsDialog.showModal();
    editResource("skill", async () => {
      await listSkills();
      await selectSkill();
    });
  });
  skillList.addEventListener("change", () => editResource("skill", selectSkill));
  node("skill-form").addEventListener("submit", (event) => {
    event.preventDefault();
    editResource("skill", async () => {
      const skillName = name.value;
      await request(
        `skills/${encodeURIComponent(skillName)}`,
        { description: description.value, content: content.value },
        "PUT",
      );
      await listSkills(skillName);
      await selectSkill();
      node("skill-status").textContent = "Skill saved";
    });
  });
  node("delete-skill").addEventListener("click", () =>
    editResource("skill", async () => {
      await request(`skills/${skillList.value}`, undefined, "DELETE");
      await listSkills();
      await selectSkill();
      node("skill-status").textContent = "Skill removed";
    }),
  );
  node("close-skills").addEventListener("click", () => skillsDialog.close());

  const memoryDialog = node<HTMLDialogElement>("memory-dialog");
  const memoryScope = node<HTMLSelectElement>("memory-scope");
  const memoryContent = node<HTMLTextAreaElement>("memory-content");
  let memoryBot: Bot | undefined;
  const memoryPath = () =>
    memoryScope.value === "owner" ? "memory/owner" : `bots/${memoryBot?.id}/memory`;
  async function loadMemory(): Promise<void> {
    node<HTMLButtonElement>("save-memory").disabled = true;
    node<HTMLButtonElement>("delete-memory").disabled = true;
    const document = await request<MemoryDocument>(memoryPath());
    memoryContent.value = document.content;
    node<HTMLButtonElement>("save-memory").disabled = false;
    node<HTMLButtonElement>("delete-memory").disabled = false;
    node("memory-status").textContent = "";
  }
  node("open-memory").addEventListener("click", () => {
    memoryDialog.showModal();
    editResource("memory", async () => {
      memoryBot = currentBot();
      memoryScope.replaceChildren(new Option("Owner · shared across Bots", "owner"));
      if (memoryBot) memoryScope.append(new Option(`${memoryBot.name} · Bot memory`, "bot"));
      await loadMemory();
    });
  });
  memoryScope.addEventListener("change", () => editResource("memory", loadMemory));
  node("memory-form").addEventListener("submit", (event) => {
    event.preventDefault();
    editResource("memory", async () => {
      await request(memoryPath(), { content: memoryContent.value }, "PUT");
      node("memory-status").textContent = "Memory saved";
    });
  });
  node("delete-memory").addEventListener("click", () =>
    editResource("memory", async () => {
      await request(memoryPath(), undefined, "DELETE");
      await loadMemory();
      node("memory-status").textContent = "Memory removed";
    }),
  );
  node("close-memory").addEventListener("click", () => memoryDialog.close());
}
