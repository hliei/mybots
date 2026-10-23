import { expect, type Page, type TestInfo } from "@playwright/test";

/** Check containment and retain rendered evidence at the supported desktop sizes. */
export async function captureDesktopState(page: Page, info: TestInfo, state: string) {
  const original = page.viewportSize();
  try {
    for (const viewport of [
      { width: 1280, height: 900 },
      { width: 1440, height: 900 },
      { width: 1920, height: 1080 },
    ]) {
      await page.setViewportSize(viewport);
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              document.documentElement.scrollWidth <= innerWidth &&
              document.documentElement.scrollHeight <= innerHeight,
          ),
        )
        .toBe(true);
      const sidebar = await page.getByRole("navigation", { name: "Bots" }).boundingBox();
      expect(sidebar?.width).toBeGreaterThanOrEqual(300);
      expect(sidebar?.width).toBeLessThanOrEqual(380);
      const panel = page.getByRole("complementary", { name: "Bot details" });
      if (await panel.isVisible()) {
        const detail = await panel.boundingBox();
        const composer = await page.locator("#message-form").boundingBox();
        expect(detail?.width).toBe(380);
        if (composer) expect(composer.x + composer.width).toBeLessThanOrEqual(detail?.x ?? 0);
        expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
          true,
        );
      }
      for (const dialog of await page.locator("dialog:visible").all()) {
        expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
          true,
        );
      }
      const name = `${state}-${viewport.width}`;
      const path = info.outputPath(`${name}.png`);
      await page.screenshot({ path });
      await info.attach(name, { path, contentType: "image/png" });
    }
  } finally {
    if (original) await page.setViewportSize(original);
  }
}
