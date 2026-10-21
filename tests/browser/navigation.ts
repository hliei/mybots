import type { Page } from "@playwright/test";

type Feature =
  | "chat"
  | "create"
  | "overview"
  | "files"
  | "tasks"
  | "search"
  | "Configuration"
  | "Memory"
  | "Skills"
  | "Collaboration"
  | "Routines";

/** Follow the same entry points as the owner when exercising rehomed controls. */
export async function showFeature(page: Page, feature: Feature): Promise<void> {
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  if (["Configuration", "Memory", "Skills", "Collaboration", "Routines"].includes(feature)) {
    if (!(await settings.isVisible()))
      await page.getByRole("button", { name: "Settings", exact: true }).click();
    const section = settings.getByRole("button", { name: feature, exact: true });
    if ((await section.getAttribute("aria-pressed")) !== "true") await section.click();
    return;
  }
  if (await settings.isVisible())
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
  if (feature === "create") {
    if (!(await page.getByRole("dialog", { name: "Create a Bot", exact: true }).isVisible()))
      await page.getByRole("button", { name: "Create a Bot", exact: true }).click();
  } else if (feature === "overview") {
    if (!(await page.locator('[data-detail-mount="overview"]').isVisible()))
      await page.getByRole("button", { name: "Bot menu", exact: true }).click();
  } else if (feature === "tasks") {
    if (!(await page.locator('[data-detail-mount="tasks"]').isVisible()))
      await page.getByRole("button", { name: "Tasks", exact: true }).click();
  } else if (feature === "files") {
    if (!(await page.locator('[data-detail-mount="files"]').isVisible())) {
      await page.getByRole("button", { name: "Bot menu", exact: true }).click();
      await page.getByRole("button", { name: "Files", exact: true }).click();
    }
  } else if (feature === "search") {
    if (!(await page.locator('[data-detail-mount="search"]').isVisible()))
      await page.getByRole("button", { name: "Search conversation", exact: true }).click();
  }
}
