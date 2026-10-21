import { Trans } from "@lingui/react/macro";
import type { ActionOfferListItem, SpaceNavigation } from "@rakazo/contracts";
import { ChevronLeft } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { chatMessagePath } from "../lib/chat-message-path";
import { desktopBridge } from "../lib/desktop";
import { formatRelativeTime } from "../lib/relative-time";
import { rpc } from "../lib/rpc";
import { OfferCard } from "./shell/message-cards";
import { WindowChrome } from "./WindowChrome";

export function ActionsPage() {
  const [items, setItems] = useState<ActionOfferListItem[] | null>(null);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const load = useCallback(async () => {
    const [list, navigation] = await Promise.all([rpc.actionOffers.list(), rpc.spaces.list()]);
    setItems(list);
    setNames(chatNames(navigation));
  }, []);
  useEffect(() => {
    void load().catch(() => undefined);
    const poll = window.setInterval(() => void load().catch(() => undefined), 5_000);
    return () => window.clearInterval(poll);
  }, [load]);

  return (
    <div className="flex h-full min-w-0 flex-col bg-background text-foreground/90">
      <header className="app-drag border-b border-border px-4 py-4 md:px-6">
        <div className="flex items-center gap-2">
          {desktopBridge() ? <WindowChrome /> : null}
          <Link
            to="/app"
            className="app-no-drag flex shrink-0 items-center gap-0.5 rounded-lg py-1 pe-1.5 text-[13px] font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <ChevronLeft size={16} strokeWidth={1.9} aria-hidden="true" />
            <Trans>Bots</Trans>
          </Link>
          <h1 className="text-xl font-semibold">
            <Trans>Actions</Trans>
          </h1>
        </div>
      </header>
      <main className="rk-scroll mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col gap-4 overflow-y-auto px-4 py-6">
        {(items ?? []).map((item) => (
          <section key={item.id} className="flex flex-col gap-1.5">
            <Link
              to={chatMessagePath(item)}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              {names.get(item.groupId ?? item.botId) ?? ""} · {formatRelativeTime(item.createdAt)}
            </Link>
            <OfferCard card={item} />
          </section>
        ))}
      </main>
    </div>
  );
}

function chatNames(navigation: SpaceNavigation): Map<string, string> {
  return new Map([
    ...navigation.current.bots.map((bot) => [bot.id, bot.name] as const),
    ...navigation.current.groups.map((group) => [group.id, group.name] as const),
  ]);
}
