import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import type { BrowserTabs } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { MAIN_AGENT, tabHandle } from "./browser-tab-registry.js";
import { FakeBrowserProvider } from "./fake-browser.js";
import { RunBrowserTabs, TABS_NEED_UPDATE, TABS_NOT_ANSWERING } from "./run-browser-tabs.js";
import { lazyRunComputer } from "./run-computer.js";

const context: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  botId: "bot-1",
  signal: new AbortController().signal,
};
const computer: ComputerRef = { id: "c", botId: "bot-1", kind: "fake", providerRef: "c" };
const pages = {
  "https://a.test/": { title: "A", html: "<button>Go</button>" },
  "https://b.test/": { title: "B", html: "<button>Go</button>" },
};
const [t1, t2, t3] = ["fake-1", "fake-2", "fake-3"].map((target) => tabHandle(target));

function setup(
  browser = new FakeBrowserProvider({ pages }),
  now = () => 0,
  start = async () => computer,
) {
  const published: BrowserTabs[] = [];
  const tabs = new RunBrowserTabs({
    browser,
    computer: lazyRunComputer(start),
    context,
    botName: "Ada",
    publish: async (view) => {
      published.push(view);
    },
    // By default a fixed clock: the first follow happens, and any later one falls within the dwell.
    now,
  });
  return { browser, tabs, published };
}

/** A helper's tab, opened and recorded as browser_navigate would. */
async function helperTab(tabs: RunBrowserTabs, url = "https://a.test/", purpose = "hotels") {
  return tabs.after("helper-1", await tabs.open("helper-1", url, purpose), "act", purpose);
}

describe("run browser tabs", () => {
  it("leaves the main agent on the focused tab with no extra calls or events", async () => {
    const { browser, tabs, published } = setup();
    const listed = vi.spyOn(browser, "tabs");
    expect(await tabs.forNavigate(MAIN_AGENT, { url: "https://a.test/" })).toEqual({});
    const result = await browser.navigate(computer, { url: "https://a.test/" }, context);
    expect(await tabs.after(MAIN_AGENT, result, "act")).toEqual({ tab: t1, opened: [] });
    expect(await tabs.forAct(MAIN_AGENT, {})).toEqual({ target: "fake-1" });
    expect(listed).not.toHaveBeenCalled();
    expect(published).toEqual([]);
  });

  it("opens a helper's first tab and refuses a helper's act before it has one", async () => {
    const { tabs } = setup();
    expect(await tabs.forNavigate("helper-1", { url: "https://a.test/" })).toEqual({ open: true });
    expect(await tabs.forAct("helper-1", {})).toEqual({
      error: "Open a tab with browser_navigate first.",
    });
  });

  it("keeps the main agent off the focused tab once a helper browses", async () => {
    const { tabs } = setup();
    tabs.labelHelper("helper-1", "Hotels");
    // The helper's request alone ends the main agent's fast path, before any tab exists.
    const helperPlace = tabs.forNavigate("helper-1", { url: "https://a.test/" });
    expect(await tabs.forNavigate(MAIN_AGENT, { url: "https://b.test/" })).toEqual({ open: true });
    await helperPlace;
    await helperTab(tabs);
    expect(await tabs.forAct(MAIN_AGENT, {})).toEqual({
      error: "Take a browser_snapshot of the tab to act in first; its refs name the tab.",
    });
    expect(await tabs.forRead(MAIN_AGENT, { tab: t2 })).toEqual({ target: "fake-2" });
    // Refs from reading the helper's tab lead back to that tab, which is not the main agent's.
    tabs.remember("fake-2", { elements: [{ ref: "fake-2:e1" }] });
    expect(
      await tabs.forAct(MAIN_AGENT, { actions: [{ kind: "click", ref: "fake-2:e1" }] }),
    ).toEqual({
      error: `${t2} belongs to helper 'Hotels' until it finishes. Read it with browser_snapshot, or open your own tab with browser_navigate newTab.`,
    });
  });

  it("does not follow while an unaddressed command is in flight", async () => {
    let clock = 0;
    const { browser, tabs } = setup(undefined, () => clock);
    await tabs.support();
    await helperTab(tabs);
    await tabs.after(MAIN_AGENT, await tabs.open(MAIN_AGENT, "https://b.test/", undefined), "act");
    clock += 10_000;
    const activate = vi.spyOn(browser, "activateTab");
    let release!: () => void;
    const unaddressed = tabs.within({}, () => new Promise<void>((done) => (release = done)));
    // Past the dwell this act would be followed, but an unaddressed command is in flight.
    await tabs.after(MAIN_AGENT, { target: "fake-3", url: "https://b.test/", title: "B" }, "act");
    expect(activate).not.toHaveBeenCalled();
    release();
    await unaddressed;
  });

  it("keeps handles across a paused run's resume", async () => {
    const browser = new FakeBrowserProvider({ pages });
    const before = setup(browser).tabs;
    await before.support();
    expect((await helperTab(before)).tab).toBe(t2);
    const resumed = setup(browser).tabs;
    // Ownership resets with the run; the handle still names the same tab.
    expect(await resumed.forNavigate(MAIN_AGENT, { url: "https://a.test/", tab: t2 })).toEqual({
      target: "fake-2",
    });
  });

  it("lists tabs with handles, owners as the asker sees them, and purposes", async () => {
    const { tabs } = setup();
    await tabs.support();
    tabs.labelHelper("helper-1", "Hotels");
    await helperTab(tabs);
    expect(await tabs.list(MAIN_AGENT)).toEqual({
      tabs: [
        { tab: t1, title: "", url: "about:blank" },
        { tab: t2, title: "A", url: "https://a.test/", owner: "helper: Hotels", purpose: "hotels" },
      ],
    });
    // The asker's own current tab is marked, so it knows where unnamed calls go.
    expect(await tabs.list("helper-1")).toMatchObject({
      tabs: [{ tab: t1 }, { tab: t2, owner: "you", current: true }],
    });
  });

  it("reports a closed handle instead of acting in another tab", async () => {
    const { browser, tabs } = setup();
    await tabs.support();
    await helperTab(tabs);
    await browser.closeTab(computer, { target: "fake-2" }, context);
    expect(await tabs.forAct("helper-1", {})).toEqual({ target: "fake-2" });
    const result = await browser.act(
      computer,
      { actions: [{ kind: "click", ref: "e1" }], target: "fake-2" },
      context,
    );
    expect(await tabs.after("helper-1", { ...result, target: "fake-2" }, "act")).toEqual({
      opened: [],
      error: `${t2} is closed. Call browser_tabs.`,
    });
    expect(await tabs.forRead("helper-1", { tab: t2 })).toEqual({
      error: `${t2} is closed. Call browser_tabs.`,
    });
  });

  it("refuses tab arguments on a computer without tab commands and keeps unnamed calls working", async () => {
    const browser = new FakeBrowserProvider({ pages });
    browser.tabs = undefined as never;
    const { tabs } = setup(browser);
    expect(await tabs.support()).toBe(false);
    expect(await tabs.forNavigate(MAIN_AGENT, { url: "https://a.test/", newTab: true })).toEqual({
      error: TABS_NEED_UPDATE,
    });
    expect(await tabs.forRead(MAIN_AGENT, { tab: t1 })).toEqual({ error: TABS_NEED_UPDATE });
    // A helper on such a computer shares the focused tab, as before tabs existed.
    expect(await tabs.forNavigate("helper-1", { url: "https://a.test/" })).toEqual({});
    expect(await tabs.list(MAIN_AGENT)).toEqual({ error: TABS_NEED_UPDATE });
  });

  it("probes again after a passing failure, but not after an old image's answer", async () => {
    const browser = new FakeBrowserProvider({ pages });
    const listed = vi
      .spyOn(browser, "tabs")
      .mockResolvedValueOnce({ tabs: [], fallback: "computer_act", error: "CDP not ready" });
    const { tabs } = setup(browser);
    expect(await tabs.support()).toBe(false);
    expect(await tabs.support()).toBe(true);
    listed.mockClear();

    const old = new FakeBrowserProvider({ pages });
    const oldListed = vi.spyOn(old, "tabs").mockResolvedValue({
      tabs: [],
      fallback: "computer_act",
      error: "unknown command: tabs",
    });
    const oldTabs = setup(old).tabs;
    expect(await oldTabs.support()).toBe(false);
    expect(await oldTabs.support()).toBe(false);
    expect(oldListed).toHaveBeenCalledTimes(1);
  });

  it("caps tabs per run", async () => {
    const { tabs } = setup();
    await tabs.support();
    for (let i = 0; i < 12; i++) tabs.registry.adopt(MAIN_AGENT, `opened-${i}`);
    expect(await tabs.forNavigate(MAIN_AGENT, { url: "https://a.test/", newTab: true })).toEqual({
      error: expect.stringContaining("12 tabs open"),
    });
    expect(await tabs.open(MAIN_AGENT, "https://a.test/", undefined)).toMatchObject({
      error: expect.stringContaining("12 tabs open"),
    });
  });

  it("acts in the tab its refs came from, and refuses refs from two tabs", async () => {
    const { browser, tabs } = setup();
    await tabs.support();
    await helperTab(tabs);
    await tabs.after(MAIN_AGENT, await tabs.open(MAIN_AGENT, "https://b.test/", undefined), "act");
    const mine = await browser.snapshot(computer, { target: "fake-3" }, context);
    const theirs = await browser.snapshot(computer, { target: "fake-2" }, context);
    tabs.remember("fake-3", mine);
    tabs.remember("fake-2", theirs);
    const click = (ref: string) => ({ kind: "click", ref });
    expect(await tabs.forAct(MAIN_AGENT, { actions: [click(mine.elements[0]!.ref)] })).toEqual({
      target: "fake-3",
    });
    expect(
      await tabs.forAct(MAIN_AGENT, {
        actions: [click(mine.elements[0]!.ref), click(theirs.elements[0]!.ref)],
      }),
    ).toEqual({ error: "These refs come from different tabs. Act in one tab per call." });
  });

  it("asks which tab to navigate once an agent has two, and accepts any handle's case", async () => {
    const { tabs } = setup();
    await tabs.support();
    await helperTab(tabs);
    await tabs.after("helper-1", await tabs.open("helper-1", "https://b.test/", undefined), "act");
    expect(await tabs.forNavigate("helper-1", { url: "https://a.test/" })).toEqual({
      error: `You have 2 tabs: ${t2}, ${t3}. Name one with tab, or use newTab.`,
    });
    expect(
      await tabs.forNavigate("helper-1", { url: "https://a.test/", tab: t2!.toUpperCase() }),
    ).toEqual({ target: "fake-2" });
    expect(
      await tabs.forNavigate("helper-1", { url: "https://a.test/", tab: t2, newTab: true }),
    ).toEqual({ error: "Use tab or newTab, not both." });
  });

  it("makes a tab current when its owner reads it, never when another agent does", async () => {
    const { browser, tabs } = setup();
    await tabs.support();
    await helperTab(tabs);
    await tabs.after(MAIN_AGENT, await tabs.open(MAIN_AGENT, "https://b.test/", undefined), "act");
    await tabs.after(MAIN_AGENT, await tabs.open(MAIN_AGENT, "https://a.test/", undefined), "act");
    const read = (target: string) => browser.snapshot(computer, { target }, context);
    await tabs.after(MAIN_AGENT, await read("fake-3"), "read");
    expect(await tabs.forRead(MAIN_AGENT, {})).toEqual({ target: "fake-3" });
    await tabs.after(MAIN_AGENT, await read("fake-2"), "read");
    expect(await tabs.forRead(MAIN_AGENT, {})).toEqual({ target: "fake-3" });
  });

  it("lets one agent at a time use the desktop once there are tabs, and stops following", async () => {
    let clock = 0;
    const { browser, tabs } = setup(undefined, () => clock);
    await tabs.support();
    // One tab: desktop actions work as they do today, and hold nothing.
    expect(await tabs.forDesktop(MAIN_AGENT)).toEqual({});
    tabs.labelHelper("helper-1", "Hotels");
    await helperTab(tabs);
    expect(await tabs.forDesktop("helper-1")).toEqual({});
    expect(tabs.view().front).toBe("fake-2");
    expect(await tabs.forDesktop(MAIN_AGENT)).toEqual({
      error: "The screen is in use by helper 'Hotels'. Use page tools in your own tab.",
    });
    // Past the dwell, the main agent's act would be followed; the hold keeps the screen still.
    clock += 10_000;
    const activate = vi.spyOn(browser, "activateTab");
    await tabs.after(MAIN_AGENT, await tabs.open(MAIN_AGENT, "https://b.test/", undefined), "act");
    expect(activate).not.toHaveBeenCalled();
    await tabs.handBack("helper-1");
    expect(await tabs.forDesktop(MAIN_AGENT)).toEqual({});
    expect(tabs.view().front).toBe("fake-3");
  });

  it("refuses desktop actions to an agent with no tab while another agent's tab is in front", async () => {
    const { tabs } = setup();
    await tabs.support();
    // The helper's act is followed, so its tab is in front.
    await helperTab(tabs);
    expect(await tabs.forDesktop(MAIN_AGENT)).toEqual({
      error:
        "Another agent's tab is in front, so desktop actions would land in it. Open a tab with browser_navigate first.",
    });
  });

  it("still routes an owner's refs after another agent reads its tab", async () => {
    const { browser, tabs } = setup();
    await tabs.support();
    await helperTab(tabs);
    const before = await browser.snapshot(computer, { target: "fake-2" }, context);
    tabs.remember("fake-2", before);
    // The helper moves on to a second tab; then the main agent reads the first.
    await tabs.after("helper-1", await tabs.open("helper-1", "https://b.test/", undefined), "act");
    tabs.remember("fake-2", await browser.snapshot(computer, { target: "fake-2" }, context));
    const ref = before.elements[0]!.ref;
    expect(await tabs.forAct("helper-1", { actions: [{ kind: "click", ref }] })).toEqual({
      target: "fake-2",
    });
  });

  it("lets no follow land after a desktop hold is taken", async () => {
    let clock = 0;
    const browser = new FakeBrowserProvider({ pages });
    const { tabs } = setup(browser, () => clock);
    await tabs.support();
    await helperTab(tabs);
    await tabs.after(MAIN_AGENT, await tabs.open(MAIN_AGENT, "https://b.test/", undefined), "act");
    clock += 10_000;
    // The main agent's act is followed: its tab is in front.
    await tabs.after(MAIN_AGENT, { target: "fake-3", url: "https://b.test/", title: "B" }, "act");
    clock += 10_000;
    const activate = browser.activateTab.bind(browser);
    let release!: () => void;
    const slow = new Promise<void>((done) => (release = done));
    const order: Array<string | null> = [];
    vi.spyOn(browser, "activateTab").mockImplementation(async (c, request, ctx) => {
      if (request.target === "fake-2") await slow;
      order.push(request.target);
      return activate(c, request, ctx);
    });
    // The helper's act starts a follow that is still in flight when the hold is taken.
    const helperAct = tabs.after(
      "helper-1",
      { target: "fake-2", url: "https://a.test/", title: "A" },
      "act",
    );
    const hold = tabs.forDesktop(MAIN_AGENT);
    release();
    await helperAct;
    expect(await hold).toEqual({});
    expect(order.at(-1)).toBe("fake-3");
  });

  it("gives the screen to one of two agents asking for it at once", async () => {
    const { tabs } = setup();
    await tabs.support();
    tabs.labelHelper("helper-1", "Hotels");
    await helperTab(tabs);
    await tabs.after(MAIN_AGENT, await tabs.open(MAIN_AGENT, "https://b.test/", undefined), "act");
    const answers = await Promise.all([tabs.forDesktop("helper-1"), tabs.forDesktop(MAIN_AGENT)]);
    expect(answers.filter((answer) => !answer.error)).toHaveLength(1);
  });

  it("gives the screen back when its holder returns to page tools", async () => {
    const { tabs } = setup();
    await tabs.support();
    tabs.labelHelper("helper-1", "Hotels");
    await helperTab(tabs);
    await tabs.after(MAIN_AGENT, await tabs.open(MAIN_AGENT, "https://b.test/", undefined), "act");
    expect(await tabs.forDesktop(MAIN_AGENT)).toEqual({});
    expect(await tabs.forDesktop("helper-1")).toMatchObject({ error: expect.any(String) });
    await tabs.forNavigate(MAIN_AGENT, { url: "https://b.test/" });
    expect(await tabs.forDesktop("helper-1")).toEqual({});
  });

  it("never sends a helper to the focused tab when the tab probe fails once", async () => {
    const browser = new FakeBrowserProvider({ pages });
    vi.spyOn(browser, "tabs").mockResolvedValueOnce({
      tabs: [],
      fallback: "computer_act",
      error: "CDP not ready",
    });
    const { tabs } = setup(browser);
    expect(await tabs.forNavigate("helper-1", { url: "https://a.test/" })).toEqual({
      error: TABS_NOT_ANSWERING,
    });
    expect(await tabs.forNavigate("helper-1", { url: "https://a.test/" })).toEqual({ open: true });
  });

  it("never takes a server error for a computer without tabs: helpers stay out of the focused tab", async () => {
    const browser = new FakeBrowserProvider({ pages });
    vi.spyOn(browser, "tabs").mockResolvedValue({
      tabs: [],
      fallback: "computer_act",
      error: "page browser failed: 500",
    });
    const { tabs } = setup(browser);
    expect(await tabs.forNavigate("helper-1", { url: "https://a.test/" })).toEqual({
      error: TABS_NOT_ANSWERING,
    });
    expect(await tabs.forNavigate("helper-1", { url: "https://a.test/" })).toEqual({
      error: TABS_NOT_ANSWERING,
    });
  });

  it("waits for an unaddressed command to finish before opening a tab", async () => {
    const { browser, tabs } = setup();
    await tabs.support();
    const openTab = vi.spyOn(browser, "openTab");
    let release!: () => void;
    const unaddressed = tabs.within({}, () => new Promise<void>((done) => (release = done)));
    const opening = tabs.open("helper-1", "https://a.test/", undefined);
    await new Promise((done) => setTimeout(done, 0));
    // A new window takes focus while it opens: the unaddressed command must not see it.
    expect(openTab).not.toHaveBeenCalled();
    release();
    await unaddressed;
    await opening;
    expect(openTab).toHaveBeenCalledTimes(1);
  });

  it("closes tabs a paused run opened before it resumed", async () => {
    const browser = new FakeBrowserProvider({ pages });
    const before = setup(browser);
    await before.tabs.support();
    await helperTab(before.tabs);
    await helperTab(before.tabs, "https://b.test/");
    const left = before.published.at(-1)!;
    expect(left.tabs.filter((tab) => tab.opened).map((tab) => tab.target)).toEqual([
      "fake-2",
      "fake-3",
    ]);
    // A fresh registry for the resumed run learns what the paused one opened.
    const resumed = setup(browser).tabs;
    resumed.restoreOpened(left);
    // The resumed run uses the computer, so it is there to clean up.
    await resumed.support();
    await resumed.closeOpened(new AbortController().signal);
    // The tab in front stays; the other one the run opened closes.
    expect((await browser.tabs(computer, {}, context)).tabs.map((tab) => tab.target)).toEqual([
      "fake-1",
      "fake-2",
    ]);
  });

  // A run that never touches its computer must not start one, even to tidy up.
  it("starts no computer to close tabs after a resumed run that never used one", async () => {
    const browser = new FakeBrowserProvider({ pages });
    const before = setup(browser);
    await before.tabs.support();
    await helperTab(before.tabs);
    const left = before.published.at(-1)!;
    const start = vi.fn(async () => computer);
    const listTabs = vi.spyOn(browser, "tabs");
    const resumed = setup(browser, () => 0, start).tabs;
    resumed.restoreOpened(left);
    await resumed.closeOpened(new AbortController().signal);
    expect(start).not.toHaveBeenCalled();
    expect(listTabs).not.toHaveBeenCalled();
  });

  // Stop shuts the browser down; a relaunch would restore every tab of the run under new ids.
  it("never launches the browser to tidy up, and skips quietly when it is not running", async () => {
    const { browser, tabs } = setup();
    await tabs.support();
    await helperTab(tabs);
    await helperTab(tabs, "https://b.test/");
    const listTabs = vi.spyOn(browser, "tabs");
    const activateTab = vi.spyOn(browser, "activateTab");
    const closeTab = vi.spyOn(browser, "closeTab");
    await tabs.closeOpened(new AbortController().signal);
    expect(closeTab).toHaveBeenCalled();
    for (const call of [...listTabs.mock.calls, ...activateTab.mock.calls, ...closeTab.mock.calls])
      expect(call[2]).toMatchObject({ skipBrowserLaunch: true });

    // The computer answers that its browser is not running: nothing more is asked of it.
    const stopped = setup();
    await stopped.tabs.support();
    await helperTab(stopped.tabs);
    await helperTab(stopped.tabs, "https://b.test/");
    const strip = stopped.published.length;
    vi.spyOn(stopped.browser, "tabs").mockResolvedValue({
      tabs: [],
      fallback: "computer_act",
      error: "The computer's browser is not running.",
    });
    const notActivated = vi.spyOn(stopped.browser, "activateTab");
    const notClosed = vi.spyOn(stopped.browser, "closeTab");
    await stopped.tabs.closeOpened(new AbortController().signal);
    expect(notActivated).not.toHaveBeenCalled();
    expect(notClosed).not.toHaveBeenCalled();
    expect(stopped.published).toHaveLength(strip);
  });

  it("publishes tab addresses without their query or fragment, which can carry login codes", async () => {
    const { browser, tabs, published } = setup(
      new FakeBrowserProvider({
        pages: {
          ...pages,
          "https://a.test/callback?code=fake-oauth-code#token=fake-token": {
            title: "A",
            html: "<p>signed in</p>",
          },
        },
      }),
    );
    await tabs.support();
    await tabs.after(
      "helper-1",
      await tabs.open(
        "helper-1",
        "https://a.test/callback?code=fake-oauth-code#token=fake-token",
        undefined,
      ),
      "act",
    );
    const urls = published.at(-1)?.tabs.map((tab) => tab.url);
    expect(urls).toContain("https://a.test/callback");
    expect(JSON.stringify(published)).not.toContain("fake-oauth-code");
    expect(JSON.stringify(published)).not.toContain("fake-token");
    void browser;
  });

  it("holds an unaddressed command until a tab that is opening has opened", async () => {
    const { browser, tabs } = setup();
    await tabs.support();
    const openTab = browser.openTab.bind(browser);
    let release!: () => void;
    const slow = new Promise<void>((done) => (release = done));
    vi.spyOn(browser, "openTab").mockImplementation(async (c, request, ctx) => {
      await slow;
      return openTab(c, request, ctx);
    });
    const opening = tabs.open("helper-1", "https://a.test/", undefined);
    await new Promise((done) => setTimeout(done, 0));
    let ran = false;
    const unaddressed = tabs.within({}, async () => {
      ran = true;
    });
    await new Promise((done) => setTimeout(done, 0));
    // The opening window has focus: an unaddressed command would find it.
    expect(ran).toBe(false);
    release();
    await opening;
    await unaddressed;
    expect(ran).toBe(true);
  });

  it("says the browser is not answering, not that it lacks tabs, after a passing failure", async () => {
    const browser = new FakeBrowserProvider({ pages });
    vi.spyOn(browser, "tabs").mockResolvedValue({
      tabs: [],
      fallback: "computer_act",
      error: "CDP not ready",
    });
    const { tabs } = setup(browser);
    expect(await tabs.forRead(MAIN_AGENT, { tab: t1 })).toEqual({ error: TABS_NOT_ANSWERING });
    expect(await tabs.list(MAIN_AGENT)).toEqual({ error: TABS_NOT_ANSWERING });
  });

  it("lists the tabs once for a run's first browser_tabs", async () => {
    const { browser, tabs } = setup();
    const listed = vi.spyOn(browser, "tabs");
    await tabs.list(MAIN_AGENT);
    expect(listed).toHaveBeenCalledTimes(1);
    await tabs.list(MAIN_AGENT);
    expect(listed).toHaveBeenCalledTimes(2);
  });

  it("keeps desktop actions out of a tab the user pinned on screen", async () => {
    const { browser, tabs } = setup();
    await tabs.support();
    await helperTab(tabs);
    await browser.activateTab(computer, { target: "fake-1", pin: true }, context);
    expect(await tabs.forDesktop("helper-1")).toEqual({
      error: `The user pinned another tab on screen, so desktop actions would land in it. Use page tools in ${t2}, or have the user choose Follow.`,
    });
  });

  it("mirrors the computer's pin from every reply, so a pin set from the UI is never undone", async () => {
    const { browser, tabs, published } = setup();
    await tabs.support();
    await helperTab(tabs);
    // The viewer pins the user's own tab directly on the computer, as the API does.
    await browser.activateTab(computer, { target: "fake-1", pin: true }, context);
    const snap = await browser.snapshot(computer, { target: "fake-2" }, context);
    await tabs.after("helper-1", snap, "read");
    expect(published.at(-1)?.pinned).toBe("fake-1");
  });

  it("hands a helper's tabs back, publishes in order, and closes the run's background tabs", async () => {
    const { browser, tabs, published } = setup();
    await tabs.support();
    tabs.labelHelper("helper-1", "Hotels");
    await helperTab(tabs);
    expect(published.at(-1)?.tabs.find((tab) => tab.target === "fake-2")).toMatchObject({
      owner: "Hotels",
      purpose: "hotels",
    });
    // The first follow brings the helper's tab forward; the next falls within the dwell.
    expect(published.at(-1)?.front).toBe("fake-2");
    await tabs.after(MAIN_AGENT, await tabs.open(MAIN_AGENT, "https://b.test/", undefined), "act");
    await tabs.handBack("helper-1");
    expect(published.at(-1)?.tabs.find((tab) => tab.target === "fake-2")?.owner).toBe("Ada");
    await tabs.closeOpened(new AbortController().signal);
    // The main agent's final tab comes forward and stays, the helper's closes, and the
    // user's own tab is untouched.
    expect((await browser.tabs(computer, {}, context)).tabs.map((tab) => tab.target)).toEqual([
      "fake-1",
      "fake-3",
    ]);
    expect(published.at(-1)).toMatchObject({ front: "fake-3" });
    expect(published.at(-1)?.tabs.map((tab) => tab.target)).toEqual(["fake-1", "fake-3"]);
  });
});
