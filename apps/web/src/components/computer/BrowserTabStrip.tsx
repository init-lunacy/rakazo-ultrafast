import { useLingui } from "@lingui/react/macro";
import type { BrowserTabs } from "@rakazo/contracts";
import { browserTabLabel, shownBrowserTab } from "@rakazo/core";
import { Button, Tabs, TabsList, TabsTrigger } from "@rakazo/ui-web";
import { useLayoutEffect, useRef } from "react";

/**
 * The bot's browser tabs over its live screen. Hidden until there is a choice.
 * The tab on screen is highlighted; clicking a tab pins the view to it.
 */
export function BrowserTabStrip({
  tabs,
  onShow,
}: {
  tabs: BrowserTabs | undefined;
  onShow: (target: string | null) => void;
}) {
  const { t } = useLingui();
  const strip = useRef<HTMLDivElement>(null);
  const shown = shownBrowserTab(tabs);
  const visible = Boolean(tabs && tabs.tabs.length >= 2);

  useLayoutEffect(() => {
    if (!visible || !shown) return;
    const chip = [...(strip.current?.querySelectorAll<HTMLElement>("[data-target]") ?? [])].find(
      (element) => element.dataset.target === shown,
    );
    chip?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [visible, shown, tabs]);

  if (!tabs || !visible) return null;
  return (
    <nav
      aria-label={t`Tabs`}
      // Equal side columns keep the tabs centered while Follow sits at the right.
      className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-border bg-background px-2"
    >
      <div ref={strip} className="col-start-2 min-w-0 overflow-x-auto py-1">
        <Tabs value={shown ?? ""}>
          <TabsList variant="line" className="w-max">
            {tabs.tabs.map((tab) => {
              const label = browserTabLabel(tab);
              return (
                <TabsTrigger
                  key={tab.target}
                  value={tab.target}
                  data-target={tab.target}
                  title={tab.url}
                  aria-label={`${label}, ${tab.url}`}
                  // Pin on click, not on a value change: clicking the tab in front pins it too.
                  onClick={() => onShow(tab.target)}
                  className="max-w-56 flex-none truncate text-xs after:hidden"
                >
                  {label}
                </TabsTrigger>
              );
            })}
          </TabsList>
        </Tabs>
      </div>
      {tabs.pinned ? (
        <Button size="sm" variant="ghost" className="justify-self-end" onClick={() => onShow(null)}>
          {t`Follow`}
        </Button>
      ) : null}
    </nav>
  );
}
