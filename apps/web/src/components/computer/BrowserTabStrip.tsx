import { useLingui } from "@lingui/react/macro";
import type { BrowserTabs } from "@rakazo/contracts";
import { browserTabLabel, shownBrowserTab } from "@rakazo/core";
import { Button, Tabs, TabsList, TabsTrigger } from "@rakazo/ui-web";
import { useLayoutEffect, useRef, useState } from "react";

/**
 * The bot's browser tabs over its live screen. Hidden until there is a choice.
 * The indicator slides to the tab on screen; clicking a tab pins the view to it.
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
  const [bar, setBar] = useState<{ left: number; width: number } | null>(null);
  const shown = shownBrowserTab(tabs);
  const visible = Boolean(tabs && tabs.tabs.length >= 2);

  useLayoutEffect(() => {
    if (!visible || !shown) {
      setBar(null);
      return;
    }
    const chip = [...(strip.current?.querySelectorAll<HTMLElement>("[data-target]") ?? [])].find(
      (element) => element.dataset.target === shown,
    );
    setBar(chip ? { left: chip.offsetLeft, width: chip.offsetWidth } : null);
    chip?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [visible, shown, tabs]);

  if (!tabs || !visible) return null;
  return (
    <nav
      aria-label={t`Tabs`}
      className="flex items-center gap-2 border-b border-border bg-background px-2"
    >
      <div ref={strip} className="relative min-w-0 flex-1 overflow-x-auto py-1">
        <Tabs value={shown ?? ""}>
          <TabsList variant="line" className="w-max justify-start">
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
        {bar ? (
          <span
            aria-hidden
            data-tab-indicator
            className="pointer-events-none absolute bottom-0 left-0 h-0.5 bg-primary transition-[transform,width] duration-300 ease-out motion-reduce:transition-none"
            style={{ transform: `translateX(${bar.left}px)`, width: bar.width }}
          />
        ) : null}
      </div>
      {tabs.pinned ? (
        <Button size="sm" variant="ghost" onClick={() => onShow(null)}>
          {t`Follow`}
        </Button>
      ) : null}
    </nav>
  );
}
