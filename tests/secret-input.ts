import type { Locator } from "@playwright/test";

export async function setSecretInput(input: Locator, value: string): Promise<void> {
  // Playwright fill failures include their value in the reporter's call log.
  await input.evaluate((element, secret) => {
    (element as HTMLInputElement).value = secret;
  }, value);
}
