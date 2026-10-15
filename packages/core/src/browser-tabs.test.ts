import { BrowserTabsSchema, ComputerStatusSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { browserTabLabel, shownBrowserTab } from "./browser-tabs.js";

describe("browser tab labels", () => {
  it("names the owner and what the tab is for, falling back to its title, then its URL", () => {
    expect(
      browserTabLabel({
        target: "T",
        title: "Booking",
        url: "https://b.test/",
        owner: "Hotels",
        purpose: "hotels in Lisbon",
      }),
    ).toBe("Hotels · hotels in Lisbon");
    expect(browserTabLabel({ target: "T", title: "Booking", url: "https://b.test/" })).toBe(
      "Booking",
    );
    expect(browserTabLabel({ target: "T", title: "", url: "https://b.test/", owner: "Ada" })).toBe(
      "Ada · https://b.test/",
    );
  });

  it("accepts a tab list on the computer status and rejects an oversized one", () => {
    const tabs = {
      tabs: [{ target: "T", title: "A", url: "https://a.test/" }],
      front: "T",
      pinned: null,
    };
    expect(BrowserTabsSchema.parse(tabs)).toEqual(tabs);
    expect(ComputerStatusSchema.shape.browserTabs.safeParse(undefined).success).toBe(true);
    expect(
      BrowserTabsSchema.safeParse({ ...tabs, tabs: Array.from({ length: 65 }, () => tabs.tabs[0]) })
        .success,
    ).toBe(false);
  });
});

describe("shown browser tab", () => {
  it("is the pinned tab while one is pinned, otherwise the one in front", () => {
    const tabs = { tabs: [], front: "T1", pinned: null };
    expect(shownBrowserTab(tabs)).toBe("T1");
    expect(shownBrowserTab({ ...tabs, pinned: "T2" })).toBe("T2");
    expect(shownBrowserTab(undefined)).toBeNull();
  });
});
