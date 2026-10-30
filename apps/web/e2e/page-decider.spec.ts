import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, expandAdvancedSection, signup } from "./helpers";

// Fork-only: upstream has no page decider, so this lives apart from upstream's model settings spec.
test("bot settings offer a page decider that starts off", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `page-decider-${stamp}@rakazo.test`, "password12", `Decider ${stamp}`);
  await completeOnboarding(page);
  await page.locator("main").getByRole("button", { name: "Chief", exact: true }).click();
  const settings = page.getByTestId("bot-settings");
  await expect(settings).toBeVisible();
  await expandAdvancedSection(settings.getByTestId("bot-settings-advanced"));
  const decider = settings.getByRole("combobox", { name: "Page decider", exact: true });
  await expect(decider).toHaveValue("");
  await decider.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "page-decider");
});
