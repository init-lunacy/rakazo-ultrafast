import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("a bot's action card runs its task on one tap and is listed under Actions", async ({
  page,
}, testInfo) => {
  await signup(page, `action-cards-${Date.now()}@rakazo.test`, "password12", "Action Cards");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill('offer the card "Book the hotel" to "Book the Lisbon hotel we compared."');
  await page.keyboard.press("Enter");

  const card = page.getByRole("button", { name: "Book the hotel", exact: true });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Book the Lisbon hotel we compared.").first()).toBeVisible();
  // "Actions for …" menus also exist, so find the sidebar row by its test id.
  const actionsRow = page.getByTestId("sidebar-actions");
  await expect(actionsRow).toContainText("1", { timeout: 10_000 });
  await captureScreenshot(page, testInfo, "action-cards");

  await actionsRow.click();
  await expect(page).toHaveURL(/\/app\/actions/);
  await expect(page.getByRole("button", { name: "Book the hotel", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "action-cards-list");

  const taken = page.waitForRequest("**/rpc/actionOffers/take");
  await page.getByRole("button", { name: "Book the hotel", exact: true }).click();
  expect((await taken).postDataJSON()).toMatchObject({ json: { offerId: expect.any(String) } });
  await expect
    .poll(async () => (await rpc<unknown[]>(page, "actionOffers/list", {})).length, {
      timeout: 15_000,
    })
    .toBe(0);
  expect(botId).toBeTruthy();
});
