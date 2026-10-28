import { expect, test } from "@playwright/test";
import { setSecretInput } from "../secret-input.ts";

test("secret form entry does not expose its value when the input is unavailable", async ({
  page,
}) => {
  const secret = "synthetic-acceptance-credential";
  await page.setContent(
    '<input type="password" aria-label="Secret"><input type="password" aria-label="Disabled secret" disabled>',
  );
  await setSecretInput(page.getByLabel("Secret", { exact: true }), secret);
  expect(await page.getByLabel("Secret", { exact: true }).inputValue()).toBe(secret);
  page.setDefaultTimeout(100);
  const failures: string[] = [];
  for (const label of ["Disabled secret", "Missing input"]) {
    try {
      await setSecretInput(page.getByLabel(label, { exact: true }), secret);
    } catch (error) {
      failures.push(String(error));
    }
  }
  expect(failures.join("\n")).toContain("Timeout");
  expect(failures.join("\n")).not.toContain(secret);
});
