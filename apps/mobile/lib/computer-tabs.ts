import type { BrowserTabs } from "@rakazo/contracts";
import { browserTabLabel } from "@rakazo/core";

const TAB = "tab:";
const FOLLOW = "follow";

/** The native tabs menu: one item per tab, the shown one checked, and Follow while pinned. */
export function browserTabMenu(
  tabs: BrowserTabs | undefined,
  follow: string,
): Array<{ id: string; title: string; state: "on" | "off" }> {
  if (!tabs || tabs.tabs.length < 2) return [];
  const shown = tabs.pinned ?? tabs.front;
  return [
    ...tabs.tabs.map((tab) => ({
      id: `${TAB}${tab.target}`,
      title: browserTabLabel(tab),
      state: tab.target === shown ? ("on" as const) : ("off" as const),
    })),
    ...(tabs.pinned ? [{ id: FOLLOW, title: follow, state: "off" as const }] : []),
  ];
}

/** A chosen menu item: the tab to pin, null to follow again, undefined for anything else. */
export function browserTabChoice(id: string): string | null | undefined {
  if (id === FOLLOW) return null;
  return id.startsWith(TAB) ? id.slice(TAB.length) : undefined;
}
