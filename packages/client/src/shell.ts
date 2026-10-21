type Detail = "overview" | "files" | "tasks" | "search";
type Settings = "configuration" | "memory" | "skills" | "collaboration" | "routines" | "connection";
const node = (id: string) => document.getElementById(id) as HTMLElement;
const settings = node("settings-surface") as HTMLDialogElement;
const creation = node("create-surface") as HTMLDialogElement;
let detailReturn: HTMLElement | undefined;
let settingsReturn: HTMLElement | undefined;
let creationReturn: HTMLElement | undefined;
let currentBot: string | undefined;

export function openDetail(mode: Detail, trigger = document.activeElement): void {
  if (!currentBot) return;
  if (trigger instanceof HTMLElement && !node("detail-surface").contains(trigger))
    detailReturn = trigger;
  node("detail-surface").hidden = false;
  for (const mount of document.querySelectorAll<HTMLElement>("[data-detail-mount]"))
    mount.hidden = mount.dataset.detailMount !== mode;
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-detail]"))
    button.setAttribute("aria-pressed", String(button.dataset.detail === mode));
  node("detail-title").textContent = {
    overview: "Overview",
    files: "Files",
    tasks: "Tasks and Runs",
    search: "Search conversation",
  }[mode];
  node(mode === "search" ? "history-query" : "close-detail").focus();
}
function closeDetail(): void {
  node("detail-surface").hidden = true;
  if (detailReturn?.isConnected) detailReturn.focus();
  else node("bot-identity").focus();
}
function selectSettings(mode: Settings): void {
  for (const mount of document.querySelectorAll<HTMLElement>("[data-settings-mount]"))
    mount.hidden = mount.dataset.settingsMount !== mode || (!currentBot && mode !== "connection");
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-settings]"))
    button.setAttribute("aria-pressed", String(button.dataset.settings === mode));
}
function openSettings(): void {
  settingsReturn = document.activeElement as HTMLElement;
  selectSettings("configuration");
  settings.showModal();
  node("close-settings").focus();
}
export function closeCreation(): void {
  creation.close();
}
export function setShellBot(bot: { id: string; name: string } | undefined): void {
  if (currentBot !== bot?.id) node("detail-surface").hidden = true;
  currentBot = bot?.id;
  node("shell-empty").hidden = !!bot;
  for (const id of ["bot-identity", "open-tasks", "open-search", "bot-menu"])
    (node(id) as HTMLButtonElement).disabled = !bot;
  node("bot-identity-name").textContent = bot?.name ?? "Select a Bot";
  node("bot-identity").setAttribute(
    "aria-label",
    bot ? `Bot details: ${bot.name}` : "Select a Bot",
  );
  (node("bot-identity").querySelector(".avatar") as HTMLElement).textContent =
    bot?.name.slice(0, 1).toLocaleUpperCase() ?? "";
  node("detail-bot").textContent = node("settings-bot").textContent =
    bot?.name ?? "No Bot selected";
  node("settings-empty").hidden = !!bot;
}
node("bot-identity").addEventListener("click", () => openDetail("overview"));
node("bot-menu").addEventListener("click", () => openDetail("overview"));
node("open-search").addEventListener("click", () => openDetail("search"));
node("open-tasks").addEventListener("click", () => openDetail("tasks"));
node("close-detail").addEventListener("click", closeDetail);
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-detail]"))
  button.addEventListener("click", () => openDetail(button.dataset.detail as Detail));
node("open-settings").addEventListener("click", openSettings);
node("bot-settings").addEventListener("click", openSettings);
node("close-settings").addEventListener("click", () => settings.close());
settings.addEventListener("close", () => settingsReturn?.isConnected && settingsReturn.focus());
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-settings]"))
  button.addEventListener("click", () => selectSettings(button.dataset.settings as Settings));
node("notification-details").addEventListener("click", () => {
  settings.close();
  openDetail("tasks", node("open-tasks"));
});
node("open-create").addEventListener("click", () => {
  creationReturn = document.activeElement as HTMLElement;
  creation.showModal();
  node("bot-name").focus();
});
node("close-create").addEventListener("click", closeCreation);
creation.addEventListener("close", () => creationReturn?.isConnected && creationReturn.focus());
document.addEventListener("keydown", (event) => {
  if (
    event.key === "Escape" &&
    !settings.open &&
    !creation.open &&
    !node("detail-surface").hidden
  ) {
    event.preventDefault();
    closeDetail();
  }
});
