import { openDetail, openSettings, resolveBotTrigger } from "./shell.ts";

export interface BotSummary {
  id: string;
  name: string;
  availability: "active" | "disabled" | "deleted";
  activityAt: string;
  latestMessage: { id: string; role: string; excerpt: string; createdAt: string } | null;
  working: boolean;
  attention: boolean;
}
const list = document.getElementById("bots") as HTMLElement;
const filter = document.getElementById("bot-filter") as HTMLInputElement;
const menu = document.getElementById("bot-actions") as HTMLDialogElement;
let summaries: BotSummary[] = [];
let selectedId: string | null = null;
let select: (id: string) => void;
let lifecycle: (id: string, operation: "enable" | "disable" | "delete") => void;
let signature = "";
let available = false;
export function setNavigationAvailable(value: boolean): void {
  if (available !== value && menu.open) menu.close();
  available = value;
}
let menuBot: string | undefined;
let menuReturn: HTMLElement | undefined;

export function showBotNavigation(
  bots: BotSummary[],
  current: string | null,
  onSelect: typeof select,
  onLifecycle: typeof lifecycle,
): void {
  summaries = bots;
  selectedId = current;
  select = onSelect;
  lifecycle = onLifecycle;
  if (
    menu.open &&
    !bots.some((bot) => bot.id === menuBot && bot.availability === menu.dataset.availability)
  )
    menu.close();
  render();
}
function render(): void {
  const next = JSON.stringify([summaries, selectedId, filter.value]);
  if (next === signature) return;
  signature = next;
  const focused = list.contains(document.activeElement)
    ? (document.activeElement as HTMLButtonElement)
    : undefined;
  const focusBot = focused?.closest<HTMLElement>("[data-bot-id]")?.dataset.botId;
  const focusMenu = focused?.classList.contains("row-menu");
  list.replaceChildren();
  const matching = summaries.filter((bot) =>
    bot.name.toLocaleLowerCase().includes(filter.value.trim().toLocaleLowerCase()),
  );
  for (const availability of ["active", "disabled", "deleted"] as const) {
    const group = matching.filter((bot) => bot.availability === availability);
    if (!group.length) continue;
    if (availability !== "active") {
      const heading = document.createElement("h2");
      heading.className = "bot-group";
      heading.textContent =
        availability === "disabled" ? "Disabled Bots" : "Deleted Bots · retained records";
      list.append(heading);
    }
    for (const bot of group) {
      const row = document.createElement("article");
      row.className = "bot-row";
      row.dataset.botId = bot.id;
      row.classList.toggle("selected", selectedId === bot.id);
      const avatar = document.createElement("span");
      avatar.className = "avatar";
      avatar.setAttribute("aria-hidden", "true");
      avatar.textContent = Array.from(bot.name.trim())[0]?.toLocaleUpperCase() ?? "?";
      const heading = document.createElement("h3");
      heading.textContent = bot.name;
      const preview = document.createElement("p");
      preview.className = "bot-preview";
      preview.textContent = bot.latestMessage?.excerpt || "No messages yet";
      preview.title = preview.textContent;
      const state = document.createElement("span");
      state.className = "bot-state";
      state.textContent = [
        bot.attention ? "Needs attention" : "",
        bot.working ? "Working" : "",
        bot.availability !== "active" ? `Availability: ${bot.availability}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      row.append(avatar, heading, preview, state);
      const choose = document.createElement("button");
      choose.type = "button";
      choose.className = "choose-bot";
      choose.setAttribute("aria-label", `Select ${bot.name}`);
      choose.setAttribute("aria-pressed", String(selectedId === bot.id));
      choose.addEventListener("click", () => select(bot.id));
      const more = document.createElement("button");
      more.type = "button";
      more.className = "row-menu";
      more.textContent = "⋯";
      more.setAttribute("aria-label", `${bot.name} menu`);
      more.setAttribute("aria-haspopup", "dialog");
      more.addEventListener("click", () => openMenu(bot, more));
      row.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        openMenu(bot, more);
      });
      row.append(choose, more);
      list.append(row);
      if (focusBot === bot.id) (focusMenu ? more : choose).focus();
    }
  }
  if (!matching.length)
    list.textContent = summaries.length
      ? "No Bots found."
      : "No Bots configured. Create a Bot to start chatting.";
  else if (!summaries.some((bot) => bot.availability === "active")) {
    const empty = document.createElement("p");
    empty.textContent = "No active Bots. Create a Bot or inspect retained records below.";
    list.prepend(empty);
  }
}
function openMenu(bot: BotSummary, trigger: HTMLElement): void {
  if (menu.open) menu.close();
  menuBot = bot.id;
  menuReturn = trigger;
  menu.dataset.availability = bot.availability;
  menu.replaceChildren();
  const heading = document.createElement("h2");
  heading.id = "bot-actions-heading";
  heading.textContent = bot.name;
  menu.append(heading);
  const action = (label: string, run: (returnTo: HTMLElement) => void, disabled = false) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.disabled = disabled;
    button.addEventListener("click", () => {
      menuReturn = undefined;
      menu.close();
      select(bot.id);
      const returnTo = resolveBotTrigger(trigger);
      returnTo.focus();
      run(returnTo);
    });
    menu.append(button);
  };
  action("Bot details", (returnTo) => openDetail("overview", returnTo));
  action("Search conversation", (returnTo) => openDetail("search", returnTo));
  action("Configuration", (returnTo) => openSettings(returnTo));
  if (bot.availability === "active") {
    action(
      "Reset chat background",
      (returnTo) => {
        openDetail("overview", returnTo);
        document.getElementById("reset-background")?.click();
      },
      !available,
    );
  }
  menu.append(document.createElement("hr"));
  if (bot.availability === "active")
    action("Disable Bot", () => lifecycle(bot.id, "disable"), !available);
  if (bot.availability === "disabled")
    action("Enable Bot", () => lifecycle(bot.id, "enable"), !available);
  if (bot.availability !== "deleted")
    action("Logically delete Bot", () => lifecycle(bot.id, "delete"), !available);
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Close Bot menu";
  close.addEventListener("click", () => menu.close());
  menu.append(close);
  const bounds = trigger.getBoundingClientRect();
  menu.style.left = `${Math.max(12, Math.min(bounds.left, window.innerWidth - 280))}px`;
  menu.style.top = `${Math.max(12, Math.min(bounds.bottom + 6, window.innerHeight - 430))}px`;
  menu.showModal();
}
menu.addEventListener("close", () => {
  if (menuReturn) resolveBotTrigger(menuReturn).focus();
});
menu.addEventListener("click", (event) => {
  if (event.target === menu) {
    const rect = menu.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      menu.close();
  }
});
filter.addEventListener("input", render);
document.getElementById("bot-menu")?.addEventListener("click", (event) => {
  const bot = summaries.find((item) => item.id === selectedId);
  if (bot) openMenu(bot, event.currentTarget as HTMLElement);
});
