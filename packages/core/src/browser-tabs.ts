import type { BrowserTabs } from "@rakazo/contracts";

/** What a tab strip or menu calls a tab: who is using it, and what it is for. */
export function browserTabLabel(tab: BrowserTabs["tabs"][number]): string {
  return [tab.owner, tab.purpose || tab.title || tab.url].filter(Boolean).join(" · ");
}
