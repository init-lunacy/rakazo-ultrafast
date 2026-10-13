import type { AdapterContext, BrowserProvider, ComputerRef } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { EmulatorBrowserProvider } from "./browser-emulator.js";
import { FakeBrowserProvider } from "./fake-browser.js";

const context: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

const computer: ComputerRef = {
  id: "computer-1",
  botId: "bot-1",
  kind: "fake",
  providerRef: "computer-1",
};

const seededPages = {
  "https://example.test/form": {
    title: "Signup",
    html: `<!doctype html><html><head><title>Signup</title></head><body>
      <label>Email <input id="email" name="email" /></label>
      <button type="submit">Continue</button>
    </body></html>`,
  },
};

/**
 * Offline conformance: every BrowserProvider must advertise page+refs and honor
 * navigate / snapshot / act. Seed HTML so this stays offline.
 */
async function assertBrowserConformance(provider: BrowserProvider) {
  const desc = provider.describe();
  expect(desc.capabilities.page).toBe(true);
  expect(desc.capabilities.refs).toBe(true);
  expect(desc.contractVersion).toBe("1");

  const navigated = await provider.navigate(
    computer,
    { url: "https://example.test/form" },
    context,
  );
  expect(navigated.fallback).toBeUndefined();
  expect(navigated.title).toBe("Signup");

  const snap = await provider.snapshot(computer, {}, context);
  expect(snap.elements.length).toBeGreaterThan(0);
  expect(snap.tree).toMatch(/\[e\d+\]/);
  const email = snap.elements.find((el) => el.name.toLowerCase().includes("email"));
  const button = snap.elements.find((el) => el.name.toLowerCase().includes("continue"));
  expect(email?.ref).toBeTruthy();
  expect(button?.ref).toBeTruthy();

  const filled = await provider.act(
    computer,
    {
      actions: [
        { kind: "fill", ref: email!.ref, text: "ada@example.test" },
        { kind: "click", ref: button!.ref },
      ],
    },
    context,
  );
  expect(filled.ok).toBe(true);
  expect(filled.completed).toBe(2);
  expect(filled.fallback).toBeUndefined();

  // The default snapshot is what the model sees, and must not change.
  expect(snap.elements.some((element) => element.rect)).toBe(false);

  // Rects come only with an extended snapshot, and are optional there — older
  // computer images report none — but a rect that is present must be usable.
  const extended = await provider.snapshot(computer, { extended: true }, context);
  for (const element of extended.elements) {
    if (!element.rect) continue;
    expect(element.rect.width).toBeGreaterThan(0);
    expect(element.rect.height).toBeGreaterThan(0);
  }

  if (provider.screenshot) {
    const shot = await provider.screenshot(computer, {}, context);
    if (!shot.fallback) {
      expect(shot.data.length).toBeGreaterThan(0);
      expect(shot.mimeType).toBe("image/png");
      expect(shot.scale).toBeGreaterThan(0);
    }
  }
}

describe("browser provider conformance", () => {
  it("holds for fake (offline)", async () => {
    await assertBrowserConformance(new FakeBrowserProvider({ pages: seededPages }));
  });

  it("holds for emulator (offline)", async () => {
    const provider = new EmulatorBrowserProvider({ pages: seededPages });
    expect(provider.describe().id).toBe("emulator");
    await assertBrowserConformance(provider);
  });

  it("returns computer_act fallback when the page tool cannot operate", async () => {
    const provider = new FakeBrowserProvider({ pages: seededPages });
    provider.forceFallback = "page browser unavailable";
    const result = await provider.navigate(computer, { url: "https://example.test/form" }, context);
    expect(result.fallback).toBe("computer_act");
    expect(result.error).toMatch(/unavailable/i);
  });

  it("reports rects and a capture offline", async () => {
    const provider = new FakeBrowserProvider({ pages: seededPages });
    await provider.navigate(computer, { url: "https://example.test/form" }, context);
    const snap = await provider.snapshot(computer, { extended: true }, context);
    expect(snap.elements.every((element) => element.rect)).toBe(true);
    expect((await provider.screenshot(computer, {}, context)).fallback).toBeUndefined();
  });

  it("reports no capture when the computer image predates it", async () => {
    const provider = new FakeBrowserProvider({ pages: seededPages });
    provider.noScreenshot = true;
    expect((await provider.screenshot(computer, {}, context)).fallback).toBe("computer_act");
  });
});
