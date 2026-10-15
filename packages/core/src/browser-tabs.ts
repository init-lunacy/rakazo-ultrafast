import type { BrowserTabs } from "@rakazo/contracts";

/** What a tab strip or menu calls a tab: who is using it, and what it is for. */
export function browserTabLabel(tab: BrowserTabs["tabs"][number]): string {
  return [tab.owner, tab.purpose || tab.title || tab.url].filter(Boolean).join(" · ");
}

/** The tab on screen: the pinned one while the viewer has pinned one, else the one in front. */
export function shownBrowserTab(tabs: BrowserTabs | undefined): string | null {
  return tabs?.pinned ?? tabs?.front ?? null;
}
