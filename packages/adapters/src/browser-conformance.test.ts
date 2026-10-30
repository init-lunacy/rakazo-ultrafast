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
      <span id="first" hidden>  Share </span><span id="second"> with   team </span><span id="empty"> </span>
      <button aria-labelledby=" second missing first " aria-label="Other"></button>
      <button aria-labelledby=" missing " aria-label="Fallback"></button>
      <button aria-labelledby="   " aria-label="Whitespace fallback"></button>
      <button aria-labelledby="empty" aria-label="Empty fallback"></button>
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
  expect(snap.elements.map((el) => el.name)).toEqual(
    expect.arrayContaining([
      "with team Share",
      "Fallback",
      "Whitespace fallback",
      "Empty fallback",
    ]),
  );

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

  it("keeps each tab's page apart and reports the tab it used", async () => {
    const provider = new FakeBrowserProvider({
      pages: {
        ...seededPages,
        "https://example.test/second": { title: "Second", html: "<button>Go</button>" },
      },
    });
    const first = await provider.navigate(computer, { url: "https://example.test/form" }, context);
    expect(first.target).toBe("fake-1");
    const opened = await provider.openTab(
      computer,
      { url: "https://example.test/second" },
      context,
    );
    expect(opened).toMatchObject({ title: "Second", target: "fake-2" });
    // Opening is in the background: untargeted calls still use the front tab.
    expect((await provider.snapshot(computer, {}, context)).title).toBe("Signup");
    expect((await provider.snapshot(computer, { target: "fake-2" }, context)).title).toBe("Second");
    expect((await provider.tabs(computer, {}, context)).tabs).toEqual([
      { target: "fake-1", title: "Signup", url: "https://example.test/form" },
      { target: "fake-2", title: "Second", url: "https://example.test/second" },
    ]);
  });

  it("reports a tab a click opened, and refuses a closed tab", async () => {
    const provider = new FakeBrowserProvider({ pages: seededPages });
    await provider.navigate(computer, { url: "https://example.test/form" }, context);
    const snap = await provider.snapshot(computer, {}, context);
    const button = snap.elements.find((el) => el.name.toLowerCase().includes("continue"))!;
    provider.popupOnNextAct = "https://example.test/form";
    const acted = await provider.act(
      computer,
      { actions: [{ kind: "click", ref: button.ref }] },
      context,
    );
    expect(acted).toMatchObject({ ok: true, target: "fake-1", opened: ["fake-2"] });
    expect((await provider.tabs(computer, {}, context)).tabs[1]).toMatchObject({
      target: "fake-2",
      openerId: "fake-1",
    });
    expect(await provider.closeTab(computer, { target: "fake-2" }, context)).toEqual({ ok: true });
    expect(await provider.snapshot(computer, { target: "fake-2" }, context)).toMatchObject({
      fallback: "computer_act",
      error: "That tab is closed.",
    });
  });

  it("follows unless pinned, and a pin on a closed tab counts as unpinned", async () => {
    const provider = new FakeBrowserProvider({ pages: seededPages });
    await provider.openTab(computer, { url: "https://example.test/form" }, context);
    expect(await provider.activateTab(computer, { target: "fake-2" }, context)).toEqual({
      front: "fake-2",
      pinned: null,
    });
    expect(await provider.activateTab(computer, { target: "fake-1", pin: true }, context)).toEqual({
      front: "fake-1",
      pinned: "fake-1",
    });
    expect(await provider.activateTab(computer, { target: "fake-2" }, context)).toEqual({
      front: null,
      pinned: "fake-1",
    });
    await provider.closeTab(computer, { target: "fake-1" }, context);
    expect(await provider.activateTab(computer, { target: "fake-2" }, context)).toEqual({
      front: "fake-2",
      pinned: null,
    });
  });

  it("hands out the same ref for the same element on every read", async () => {
    const provider = new FakeBrowserProvider({ pages: seededPages });
    await provider.navigate(computer, { url: "https://example.test/form" }, context);
    const first = await provider.snapshot(computer, {}, context);
    const second = await provider.snapshot(computer, {}, context);
    expect(second.elements.map((el) => el.ref)).toEqual(first.elements.map((el) => el.ref));
  });

  it("never hands two tabs the same ref, and a second read keeps the first read's refs", async () => {
    const provider = new FakeBrowserProvider({ pages: seededPages });
    await provider.navigate(computer, { url: "https://example.test/form" }, context);
    await provider.openTab(computer, { url: "https://example.test/form" }, context);
    const first = await provider.snapshot(computer, {}, context);
    const second = await provider.snapshot(computer, { target: "fake-2" }, context);
    const refs = (snap: { elements: Array<{ ref: string }> }) => snap.elements.map((el) => el.ref);
    expect(refs(second).some((ref) => refs(first).includes(ref))).toBe(false);
    // Another reader's snapshot of the same tab leaves the owner's refs working.
    await provider.snapshot(computer, {}, context);
    const button = first.elements.find((el) => el.name.toLowerCase().includes("continue"))!;
    expect(
      await provider.act(computer, { actions: [{ kind: "click", ref: button.ref }] }, context),
    ).toMatchObject({ ok: true, completed: 1 });
  });
});
