import { describe, expect, it } from "vitest";
import {
  BrowserTabRegistry,
  closedTabMessage,
  FOLLOW_DWELL_MS,
  MAIN_AGENT,
  MAX_RUN_TABS,
  tabHandle,
} from "./browser-tab-registry.js";

const live = (...targets: string[]) =>
  targets.map((target) => ({ target, title: `Title ${target}`, url: `https://${target}.test/` }));

describe("browser tab registry", () => {
  it("derives a short handle from the tab's id, the same in every registry", () => {
    expect(tabHandle("A")).toMatch(/^t[0-9a-z]{4}$/);
    expect(tabHandle("A")).toBe(tabHandle("A"));
    expect(tabHandle("A")).not.toBe(tabHandle("B"));
    const first = new BrowserTabRegistry();
    const resumed = new BrowserTabRegistry();
    first.sync(live("A", "B"));
    resumed.sync(live("B", "A"));
    expect(resumed.byTarget("A")?.handle).toBe(first.byTarget("A")?.handle);
    expect(closedTabMessage("tabcd")).toBe("tabcd is closed. Call browser_tabs.");
  });

  it("drops closed tabs, but never one first seen after the listing was requested", () => {
    const registry = new BrowserTabRegistry();
    registry.sync(live("A", "B"));
    const mark = registry.mark();
    registry.adopt("helper-1", "NEW");
    registry.sync(live("B"), mark);
    expect(registry.list().map((tab) => tab.target)).toEqual(["B", "NEW"]);
    expect(registry.byHandle(tabHandle("A"))).toBeUndefined();
  });

  it("lets one agent claim an unowned tab and refuses another agent's", () => {
    const registry = new BrowserTabRegistry();
    registry.sync(live("A"));
    const tab = registry.byTarget("A")!;
    registry.label("helper-1", "Hotels");
    expect(registry.claim("helper-1", tab)).toMatchObject({ ok: true });
    // Two parallel claims cannot both win: the second sees the first's owner.
    expect(registry.claim(MAIN_AGENT, tab)).toEqual({
      ok: false,
      error: `${tab.handle} belongs to helper 'Hotels' until it finishes. Read it with browser_snapshot, or open your own tab with browser_navigate newTab.`,
    });
    registry.handBack("helper-1");
    expect(registry.claim("helper-2", tab)).toEqual({
      ok: false,
      error: `${tab.handle} belongs to the main agent. Read it with browser_snapshot, or open your own tab with browser_navigate newTab.`,
    });
    expect(registry.claim(MAIN_AGENT, tab)).toMatchObject({ ok: true });
  });

  it("describes owners from the asker's side", () => {
    const registry = new BrowserTabRegistry();
    registry.label("helper-1", "Hotels");
    expect(registry.ownerFor(undefined, MAIN_AGENT)).toBeUndefined();
    expect(registry.ownerFor(MAIN_AGENT, MAIN_AGENT)).toBe("you");
    expect(registry.ownerFor(MAIN_AGENT, "helper-1")).toBe("main");
    expect(registry.ownerFor("helper-1", MAIN_AGENT)).toBe("helper: Hotels");
    expect(registry.ownerFor("helper-2", MAIN_AGENT)).toBe("helper: helper");
  });

  it("remembers each agent's last tab and forgets it when the tab closes", () => {
    const registry = new BrowserTabRegistry();
    registry.adopt("helper-1", "A", { title: "A", url: "https://a.test/" }, "flights");
    expect(registry.lastTabOf("helper-1")).toMatchObject({ target: "A", purpose: "flights" });
    registry.forget("A");
    expect(registry.lastTabOf("helper-1")).toBeUndefined();
  });

  it("gives tabs a page opened to the owner of the tab that opened them", () => {
    const registry = new BrowserTabRegistry();
    registry.adopt("helper-1", "A");
    expect(registry.adoptOpened("A", ["B"])).toEqual([tabHandle("B")]);
    expect(registry.byTarget("B")).toMatchObject({ owner: "helper-1", opened: true });
    registry.sync(live("C"));
    registry.adoptOpened("C", ["D"]);
    expect(registry.byTarget("D")?.owner).toBeUndefined();
  });

  it("hands a finished helper's tabs to the main agent, named after the helper", () => {
    const registry = new BrowserTabRegistry();
    registry.label("helper-1", "Hotels");
    registry.adopt("helper-1", "A");
    registry.adopt("helper-1", "B", undefined, "hotel search");
    registry.handBack("helper-1");
    expect(registry.byTarget("A")).toMatchObject({ owner: MAIN_AGENT, purpose: "Hotels" });
    expect(registry.byTarget("B")).toMatchObject({ owner: MAIN_AGENT, purpose: "hotel search" });
    expect(registry.ownedBy(MAIN_AGENT).map((tab) => tab.target)).toEqual(["A", "B"]);
    expect(registry.lastTabOf("helper-1")).toBeUndefined();
  });

  it("knows which tab issued a ref, and that refs from two tabs name no one tab", () => {
    const registry = new BrowserTabRegistry();
    registry.sync(live("A", "B"));
    registry.rememberRefs("A", ["e1", "e2"]);
    registry.rememberRefs("B", ["e3"]);
    expect(registry.tabOfRefs(["e1", "e2"])?.target).toBe("A");
    expect(registry.tabOfRefs(["e1", "e3"])).toBeNull();
    expect(registry.tabOfRefs(["e9"])).toBeUndefined();
    // Another snapshot of the tab adds refs: the earlier ones still work there.
    registry.rememberRefs("A", ["e4"]);
    expect(registry.tabOfRefs(["e1"])?.target).toBe("A");
    // A closed tab's refs are gone.
    registry.forget("B");
    expect(registry.tabOfRefs(["e3"])).toBeUndefined();
  });

  it("caps the tabs one run opens, counting opens in flight and only tabs it opened", () => {
    const registry = new BrowserTabRegistry();
    registry.sync(live("user-1", "user-2"));
    for (let i = 0; i < MAX_RUN_TABS - 1; i++) registry.adopt(MAIN_AGENT, `opened-${i}`);
    expect(registry.reserveOpen()).toBe(true);
    expect(registry.canOpen()).toBe(false);
    expect(registry.reserveOpen()).toBe(false);
    registry.releaseOpen();
    expect(registry.canOpen()).toBe(true);
  });

  it("closes the run's tabs at the end, keeping the front, pinned and final ones, never every tab", () => {
    const registry = new BrowserTabRegistry();
    registry.sync(live("user"));
    registry.adopt(MAIN_AGENT, "A");
    // The main agent's current tab is where it finished: it stays for the user.
    registry.adopt(MAIN_AGENT, "M");
    registry.adopt("helper-1", "B");
    registry.adopt("helper-1", "C");
    registry.fronted({ front: "B", pinned: "C" });
    expect(registry.closable()).toEqual(["A"]);

    const allOpened = new BrowserTabRegistry();
    allOpened.adopt("helper-1", "A");
    allOpened.adopt("helper-1", "B");
    // Front unknown and every tab opened by the run: the first one stays.
    expect(allOpened.closable()).toEqual(["B"]);
  });

  it("follows at most once per dwell, counting attempts, and never to the tab in front", () => {
    let now = 10_000;
    const registry = new BrowserTabRegistry(() => now);
    expect(registry.takeFollow("A")).toBe(true);
    registry.fronted({ front: "A", pinned: null });
    expect(registry.takeFollow("A")).toBe(false);
    now += FOLLOW_DWELL_MS;
    expect(registry.takeFollow("B")).toBe(true);
    // A pinned view answers with no front; the attempt still counts toward the dwell.
    registry.fronted({ front: null, pinned: "A" });
    expect(registry.takeFollow("B")).toBe(false);
    expect(registry.pinned).toBe("A");
    expect(registry.front).toBe("A");
  });
});
