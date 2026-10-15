import type { BrowserTabs } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { browserTabChoice, browserTabMenu } from "./computer-tabs";

const tabs: BrowserTabs = {
  tabs: [
    { target: "T1", title: "Flights", url: "https://f.test/", owner: "Ada" },
    { target: "T2", title: "Booking", url: "https://b.test/", owner: "Hotels", purpose: "hotels" },
  ],
  front: "T1",
  pinned: null,
};

describe("browser tab menu", () => {
  it("is empty until there is more than one tab", () => {
    expect(browserTabMenu(undefined, "Follow")).toEqual([]);
    expect(browserTabMenu({ ...tabs, tabs: [tabs.tabs[0]!] }, "Follow")).toEqual([]);
  });

  it("lists tabs with the shown one checked", () => {
    expect(browserTabMenu(tabs, "Follow")).toEqual([
      { id: "tab:T1", title: "Ada · Flights", state: "on" },
      { id: "tab:T2", title: "Hotels · hotels", state: "off" },
    ]);
  });

  it("adds Follow while pinned, and maps choices back", () => {
    const menu = browserTabMenu({ ...tabs, pinned: "T2" }, "Follow");
    expect(menu.map((item) => [item.title, item.state])).toEqual([
      ["Ada · Flights", "off"],
      ["Hotels · hotels", "on"],
      ["Follow", "off"],
    ]);
    expect(browserTabChoice("tab:T2")).toBe("T2");
    expect(browserTabChoice("follow")).toBeNull();
    expect(browserTabChoice("other")).toBeUndefined();
  });
});
