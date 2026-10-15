// @vitest-environment jsdom

import type { BrowserTabs } from "@rakazo/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserTabStrip } from "./BrowserTabStrip";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    String.raw({ raw: parts }, ...values);
  return { useLingui: () => ({ t }) };
});

const two: BrowserTabs = {
  tabs: [
    { target: "T1", title: "Flights", url: "https://f.test/", owner: "Ada" },
    { target: "T2", title: "Booking", url: "https://b.test/", owner: "Hotels", purpose: "hotels" },
  ],
  front: "T1",
  pinned: null,
};

let container: HTMLDivElement;
afterEach(() => container?.remove());

function render(tabs: BrowserTabs | undefined, onShow = vi.fn()) {
  container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<BrowserTabStrip tabs={tabs} onShow={onShow} />));
  return { root, onShow };
}

it("stays hidden until there is more than one tab", () => {
  render({ ...two, tabs: [two.tabs[0]!] });
  expect(container.textContent).toBe("");
  render(undefined);
  expect(container.textContent).toBe("");
});

it("labels each tab by owner and purpose, marks the front one, and pins on click", () => {
  const { onShow } = render(two);
  const buttons = [...container.querySelectorAll('[role="tab"]')] as HTMLElement[];
  expect(buttons.map((button) => button.textContent)).toEqual(["Ada · Flights", "Hotels · hotels"]);
  expect(buttons[0]?.getAttribute("aria-selected")).toBe("true");
  expect(buttons[1]?.getAttribute("title")).toBe("https://b.test/");
  act(() => buttons[1]?.click());
  expect(onShow).toHaveBeenCalledWith("T2");
  expect(container.textContent).not.toContain("Follow");
});

it("offers Follow only while pinned, which unpins", () => {
  const { onShow } = render({ ...two, pinned: "T2" });
  const follow = [...container.querySelectorAll("button")].find((b) => b.textContent === "Follow");
  expect(follow).toBeTruthy();
  expect(container.querySelector('[aria-selected="true"]')?.textContent).toBe("Hotels · hotels");
  act(() => follow?.click());
  expect(onShow).toHaveBeenCalledWith(null);
});

it("pins the tab already in front when it is clicked", () => {
  const { onShow } = render(two);
  const front = container.querySelector('[role="tab"][aria-selected="true"]') as HTMLElement;
  act(() => front.click());
  expect(onShow).toHaveBeenCalledWith("T1");
});
