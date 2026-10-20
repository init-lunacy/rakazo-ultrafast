import { expect, type Page, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

async function openComputer(page: Page) {
  const screenUrl = "https://screen.example/vnc.html";
  await page.route("https://screen.example/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Test desktop</title><body style='margin:0;background:#3a4a5a'>",
    }),
  );
  await page.route("**/rpc/computer/screenUrl", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { url: screenUrl } }),
    }),
  );
  await page.getByTitle("Agent computer").click();
  const preview = page.getByTestId("computer-preview");
  await preview.hover();
  await preview.getByTestId("computer-preview-open").click();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
}

test("the computer shows the bot's browser tabs and pins one", async ({ page }, testInfo) => {
  await signup(page, `tabs-${Date.now()}@rakazo.test`, "password12", "Tabs");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "computer/boot", { botId });
  const browserTabs = {
    tabs: [
      {
        target: "T1",
        title: "United",
        url: "https://united.example/",
        owner: "Tabs",
        purpose: "flights",
      },
      {
        target: "T2",
        title: "Booking",
        url: "https://booking.example/",
        owner: "Hotels",
        purpose: "hotels in Lisbon",
      },
      { target: "T3", title: "Reddit", url: "https://reddit.example/", owner: "Reviews" },
    ],
    front: "T2",
    pinned: null as string | null,
  };
  for (const pattern of ["**/rpc/computer/status", "**/rpc/threads/get"]) {
    await page.route(pattern, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const target = pattern.endsWith("status") ? body.json : body.json?.computer;
      if (target) target.browserTabs = browserTabs;
      await route.fulfill({ response, json: body });
    });
  }
  await page.route("**/rpc/computer/showBrowserTab", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { ok: true } }),
    }),
  );
  await openComputer(page);
  const strip = page.getByRole("navigation", { name: "Tabs" });
  await expect(strip.getByRole("tab", { name: /Hotels · hotels in Lisbon/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await captureScreenshot(page, testInfo, "computer-browser-tabs");
  // Listen before clicking, or the request can be missed.
  const pinned = page.waitForRequest("**/rpc/computer/showBrowserTab");
  await strip.getByRole("tab", { name: /Reviews · Reddit/ }).click();
  expect((await pinned).postDataJSON()).toMatchObject({ json: { target: "T3" } });
});
