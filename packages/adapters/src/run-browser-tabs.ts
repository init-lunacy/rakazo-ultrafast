import type {
  AdapterContext,
  BrowserNavigateResult,
  BrowserProvider,
  ComputerRef,
} from "@rakazo/adapter-kit";
import type { BrowserTabs } from "@rakazo/contracts";
import type { RegistryTab } from "./browser-tab-registry.js";
import {
  BrowserTabRegistry,
  closedTabMessage,
  HELPER_LABEL,
  MAIN_AGENT,
  MAX_RUN_TABS,
} from "./browser-tab-registry.js";
import { redactUrlSecrets } from "./connector-safety.js";
import { normalizeText } from "./page-decision-chain.js";

// Every refusal says what to do next, in the tools' own words.
/** A probe failed without a definite answer: never guess the focused tab meanwhile. */
export const TABS_NOT_ANSWERING =
  "The page browser is not answering. Try again in a moment; if it keeps failing, use desktop tools.";
export const TABS_NEED_UPDATE =
  "This computer's browser cannot address tabs. Leave out tab and newTab.";
const TAB_CAP_REACHED = `This run has ${MAX_RUN_TABS} tabs open, the most it can. Navigate one of yours with tab; browser_tabs lists them.`;
const OPEN_FIRST = "Open a tab with browser_navigate first.";
const SNAPSHOT_FIRST = "Take a browser_snapshot of the tab to act in first; its refs name the tab.";
const ONE_TAB_PER_ACT = "These refs come from different tabs. Act in one tab per call.";
const TAB_OR_NEW_TAB = "Use tab or newTab, not both.";
const FRONT_IS_ANOTHERS =
  "Another agent's tab is in front, so desktop actions would land in it. Open a tab with browser_navigate first.";
/** The computer's own wording when a target no longer exists. */
const COMPUTER_CLOSED_TAB = "That tab is closed.";
// Only a structural answer means "no tabs": an older helper's unknown command (the
// supervisor passes it through) or a sandbox with no page browser. Anything else,
// a server error included, may pass, and treating it as "no tabs" would send helpers
// into the shared focused tab for the rest of the run.
const NO_TAB_COMMANDS = /unknown command|not attached to this computer's Chrome/i;
const MAX_PURPOSE_CHARS = 120;
/** The strip's schema bounds (Task 5). */
const MAX_VIEW_TABS = 64;

export type TabPlace = { target?: string } | { open: true } | { error: string };
export interface PlacedTab {
  tab?: string;
  opened: string[];
  error?: string;
}
type TabReply = {
  target?: string;
  opened?: string[];
  pinned?: string | null;
  url?: string;
  title?: string;
  fallback?: "computer_act";
  error?: string;
};

export function normalizePurpose(value: unknown): string | undefined {
  return normalizeText(value, MAX_PURPOSE_CHARS);
}

/** A `tab` argument: a handle in any case, absent, or an error for anything else. */
function tabArg(value: unknown): string | undefined | { error: string } {
  if (value === undefined || value === null || value === "") return undefined;
  const handle = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^t[0-9a-z]{4,7}$/.test(handle)
    ? handle
    : { error: "tab must be a tab handle such as t4k2z, from a result or browser_tabs." };
}

/** The refs a browser_act call names. */
function actionRefs(actions: unknown): string[] {
  if (!Array.isArray(actions)) return [];
  return actions.flatMap((action: unknown) => {
    const ref = (action as { ref?: unknown } | null)?.ref;
    return typeof ref === "string" ? [ref] : [];
  });
}

function whichTab(own: RegistryTab[]): string {
  const handles = own.map((tab) => tab.handle).join(", ");
  return `You have ${own.length} tabs: ${handles}. Name one with tab, or use newTab.`;
}

/**
 * The browser tabs of one run: which agent may use which tab, what the user's
 * strip shows, and what the run leaves behind. Never throws: every refusal is a
 * message the model can act on.
 */
export class RunBrowserTabs {
  readonly registry: BrowserTabRegistry;
  private supported?: boolean;
  private probing?: Promise<boolean>;
  /** A helper has asked for a tab: the focused tab may now be someone else's. */
  private helpersBrowsing = false;
  private unaddressedCalls = 0;
  /** Tabs opening now. A new window takes focus while it opens, so an unaddressed call waits. */
  private opening = 0;
  /** Calls waiting for an open or an unaddressed call to finish; each re-checks when woken. */
  private waiting: Array<() => void> = [];
  /** Every screen change goes through this one queue, so none lands out of order. */
  private activations: Promise<unknown> = Promise.resolve();
  /** The agent whose desktop actions own the screen; nothing follows while one does. */
  private screenHolder?: string;
  private publishing: Promise<void> = Promise.resolve();
  private published = "";
  private publishedCount = 0;

  constructor(
    private readonly deps: {
      browser: BrowserProvider;
      computer: ComputerRef;
      context: AdapterContext;
      botName: string;
      publish: (view: BrowserTabs) => Promise<void>;
      now?: () => number;
    },
  ) {
    this.registry = new BrowserTabRegistry(deps.now);
  }

  /** Whether the computer addresses tabs. Only a definite answer is remembered for the run. */
  async support(): Promise<boolean> {
    if (this.supported !== undefined) return this.supported;
    const { browser } = this.deps;
    if (!browser.tabs || !browser.openTab || !browser.activateTab) {
      this.supported = false;
      return false;
    }
    this.probing ??= this.refresh(this.deps.context.signal).finally(() => {
      this.probing = undefined;
    });
    return this.probing;
  }

  /** Re-read the live tabs. A listing never drops a tab learned while it was in flight. */
  private async refresh(signal: AbortSignal): Promise<boolean> {
    const { browser, computer, context } = this.deps;
    if (!browser.tabs) return false;
    const mark = this.registry.mark();
    const listed = await browser
      .tabs(computer, { signal }, { ...context, signal })
      .catch(() => undefined);
    if (!listed || listed.fallback || listed.error) {
      if (listed?.error && NO_TAB_COMMANDS.test(listed.error)) this.supported = false;
      return false;
    }
    this.supported = true;
    this.registry.sync(listed.tabs, mark);
    if (listed.pinned !== undefined) this.registry.pinned = listed.pinned;
    return true;
  }

  /** The main agent may still use today's focused tab: no tab work yet, and no helper browsing. */
  private mainFastPath(agent: string): boolean {
    return agent === MAIN_AGENT && !this.helpersBrowsing && !this.registry.hasOwnedTabs();
  }

  async forNavigate(agent: string, args: Record<string, unknown>): Promise<TabPlace> {
    if (agent !== MAIN_AGENT) this.helpersBrowsing = true;
    this.releaseScreen(agent);
    const named = tabArg(args.tab);
    if (typeof named === "object") return named;
    const newTab = args.newTab === true;
    if (named && newTab) return { error: TAB_OR_NEW_TAB };
    if (!named && !newTab) {
      // Navigating replaces a page: an agent with two tabs of its own must say which.
      const own = this.registry.ownedBy(agent);
      if (own.length > 1) return { error: whichTab(own) };
      // A tab learned from an echo proves the helper addresses tabs: no probe needed.
      const last = this.registry.lastTabOf(agent);
      if (last) return this.use(agent, last.handle);
      if (this.mainFastPath(agent)) return {};
    }
    if (!(await this.support())) {
      if (this.supported !== false) return { error: TABS_NOT_ANSWERING };
      // A helper on a computer without tabs shares the focused tab, as before tabs existed.
      return named || newTab ? { error: TABS_NEED_UPDATE } : {};
    }
    if (named) return this.use(agent, named);
    // A new tab on request, a helper's first tab, or the main agent once tabs are in use.
    return this.registry.canOpen() ? { open: true } : { error: TAB_CAP_REACHED };
  }

  async forAct(agent: string, args: Record<string, unknown>): Promise<TabPlace> {
    if (agent !== MAIN_AGENT) this.helpersBrowsing = true;
    this.releaseScreen(agent);
    // Refs come from one tab's snapshot, so they say where to act.
    const routed = this.registry.tabOfRefs(actionRefs(args.actions));
    if (routed === null) return { error: ONE_TAB_PER_ACT };
    if (routed) return this.use(agent, routed.handle);
    const last = this.registry.lastTabOf(agent);
    if (last) return this.use(agent, last.handle);
    if (this.mainFastPath(agent)) return {};
    if (!(await this.support()))
      return this.supported === false ? {} : { error: TABS_NOT_ANSWERING };
    // Never the focused tab once tabs are in use: it may be another agent's.
    return { error: agent === MAIN_AGENT ? SNAPSHOT_FIRST : OPEN_FIRST };
  }

  remember(
    target: string | undefined,
    result: { elements?: ReadonlyArray<{ ref: string }> },
  ): void {
    if (target && result.elements) {
      this.registry.rememberRefs(
        target,
        result.elements.map((element) => element.ref),
      );
    }
  }

  /**
   * Desktop actions land on whatever tab is in front. Once a run has two tabs, the
   * first agent to use them holds the screen until it finishes or goes back to page
   * tools: its tab comes forward, follow stops, and other agents keep to page tools.
   * A user's pin wins.
   */
  async forDesktop(agent: string): Promise<{ error?: string }> {
    if (this.registry.list().length < 2) return {};
    const holder = this.screenHolder;
    if (holder && holder !== agent) {
      const who =
        holder === MAIN_AGENT ? "the main agent" : `helper '${this.registry.labelOf(holder)}'`;
      return { error: `The screen is in use by ${who}. Use page tools in your own tab.` };
    }
    // Taken before any await, so two agents asking at once cannot both win, and no
    // follow decided from here on moves the screen.
    this.screenHolder = agent;
    const refused = await this.serialized(() => this.showForDesktop(agent));
    if (refused && this.screenHolder === agent) this.screenHolder = undefined;
    return refused ? { error: refused } : {};
  }

  /** Bring the agent's tab forward for its desktop actions; a refusal says why not. */
  private async showForDesktop(agent: string): Promise<string | undefined> {
    const mine = this.registry.lastTabOf(agent);
    const { browser, computer, context } = this.deps;
    if (mine && browser.activateTab) {
      const shown = await browser
        .activateTab(computer, { target: mine.target, signal: context.signal }, context)
        .catch(() => undefined);
      // Only a definite answer refuses: with the page browser down, the desktop is the way on.
      if (shown && !shown.fallback && !shown.error) {
        this.registry.fronted(shown);
        if (shown.front !== mine.target && shown.pinned !== mine.target) {
          return `The user pinned another tab on screen, so desktop actions would land in it. Use page tools in ${mine.handle}, or have the user choose Follow.`;
        }
      }
      return undefined;
    }
    // No tab of its own to bring forward: never click into another agent's.
    const front = this.registry.front ? this.registry.byTarget(this.registry.front) : undefined;
    return front?.owner && front.owner !== agent ? FRONT_IS_ANOTHERS : undefined;
  }

  /** Why tab work cannot go ahead: a computer without tabs, or one not answering yet. */
  private unsupported(): string {
    return this.supported === false ? TABS_NEED_UPDATE : TABS_NOT_ANSWERING;
  }

  /** A holder going back to page tools gives the screen back to follow. */
  private releaseScreen(agent: string): void {
    if (this.screenHolder === agent) this.screenHolder = undefined;
  }

  private serialized<T>(run: () => Promise<T>): Promise<T> {
    const next = this.activations.then(run, run);
    this.activations = next.catch(() => undefined);
    return next;
  }

  async forRead(agent: string, args: Record<string, unknown>): Promise<TabPlace> {
    if (agent !== MAIN_AGENT) this.helpersBrowsing = true;
    const named = tabArg(args.tab);
    if (typeof named === "object") return named;
    if (named) {
      if (!(await this.support())) return { error: this.unsupported() };
      const tab = this.registry.byHandle(named);
      return tab ? { target: tab.target } : { error: closedTabMessage(named) };
    }
    const last = this.registry.lastTabOf(agent);
    return last ? { target: last.target } : {};
  }

  private use(agent: string, handle: string): TabPlace {
    const tab = this.registry.byHandle(handle);
    if (!tab) return { error: closedTabMessage(handle) };
    const use = this.registry.claim(agent, tab);
    return use.ok ? { target: use.tab.target } : { error: use.error };
  }

  /** Run a browser call for a place. While an unaddressed call is in flight, nothing follows. */
  async within<T>(place: TabPlace, call: () => Promise<T>): Promise<T> {
    const unaddressed = !("target" in place && place.target) && !("open" in place);
    if (!unaddressed) return call();
    // A window still opening has focus: the focused-tab lookup would find it.
    while (this.opening > 0) await this.changed();
    this.unaddressedCalls++;
    try {
      return await call();
    } finally {
      this.unaddressedCalls--;
      this.wake();
    }
  }

  private changed(): Promise<void> {
    return new Promise((done) => this.waiting.push(done));
  }

  private wake(): void {
    for (const done of this.waiting.splice(0)) done();
  }

  /** Open a background tab for an agent, holding a place under the cap while it opens. */
  async open(
    agent: string,
    url: string,
    purpose: string | undefined,
  ): Promise<BrowserNavigateResult> {
    const { browser, computer, context } = this.deps;
    if (!browser.openTab) {
      return { url, title: "", fallback: "computer_act", error: TABS_NEED_UPDATE };
    }
    if (!this.registry.reserveOpen()) return { url, title: "", error: TAB_CAP_REACHED };
    try {
      // A new window takes focus while it opens: an unaddressed call must not find it.
      while (this.unaddressedCalls > 0) await this.changed();
      this.opening++;
      const result = await browser
        .openTab(computer, { url, signal: context.signal }, context)
        .finally(() => {
          this.opening--;
          this.wake();
        });
      if (result.target) {
        this.registry.adopt(
          agent,
          result.target,
          { title: result.title, url: result.url },
          purpose,
        );
      }
      return result;
    } finally {
      this.registry.releaseOpen();
    }
  }

  /**
   * Record where a call ran and what it opened, follow it on screen, and update
   * the strip. A computer that says the tab is gone forgets it, and the agent is
   * told to look again rather than handed another tab.
   */
  async after(
    agent: string,
    result: TabReply,
    mode: "act" | "read",
    purpose?: string,
  ): Promise<PlacedTab> {
    if (result.pinned !== undefined) this.registry.pinned = result.pinned;
    if (!result.target) {
      await this.publishIfChanged();
      return { opened: [] };
    }
    if (result.error === COMPUTER_CLOSED_TAB) {
      const handle = this.registry.byTarget(result.target)?.handle;
      this.registry.forget(result.target);
      await this.publishIfChanged();
      return { opened: [], error: closedTabMessage(handle ?? "That tab") };
    }
    const tab = this.registry.note(
      result.target,
      result.fallback ? {} : { title: result.title, url: result.url },
    );
    if (mode === "act") {
      if (!tab.owner) this.registry.claim(agent, tab);
      if (purpose) tab.purpose = purpose;
    } else if (tab.owner === agent) {
      // Reading a tab of its own makes it the agent's current one; reading another's does not.
      this.registry.claim(agent, tab);
    }
    const opened = this.registry.adoptOpened(result.target, result.opened ?? []);
    const newest = result.opened?.at(-1);
    // Chromium shows a tab a page opened; following the acting tab would pull the view away.
    if (newest) this.registry.fronted({ front: newest, pinned: this.registry.pinned });
    else if (mode === "act") await this.follow(result.target);
    await this.publishIfChanged();
    return { tab: tab.handle, opened };
  }

  /** Tabs a page opened from `from` (a page-decider click), given to its owner. */
  async adoptOpened(from: string, targets: readonly string[]): Promise<string[]> {
    if (targets.length === 0) return [];
    const handles = this.registry.adoptOpened(from, targets);
    await this.publishIfChanged();
    return handles;
  }

  async list(agent: string) {
    // A first call's probe is itself a fresh listing: no need to list twice.
    const probed = this.supported === undefined;
    if (!(await this.support())) return { error: this.unsupported() };
    if (!probed) await this.refresh(this.deps.context.signal);
    await this.publishIfChanged();
    const current = this.registry.lastTabOf(agent)?.target;
    return {
      tabs: this.registry.list().map((tab) => {
        const owner = this.registry.ownerFor(tab.owner, agent);
        return {
          tab: tab.handle,
          title: tab.title,
          url: tab.url,
          ...(owner ? { owner } : {}),
          ...(tab.purpose ? { purpose: tab.purpose } : {}),
          ...(tab.target === current ? { current: true as const } : {}),
        };
      }),
    };
  }

  labelHelper(agent: string, name: string): void {
    this.registry.label(agent, name);
  }

  async handBack(agent: string): Promise<void> {
    this.registry.handBack(agent);
    if (this.screenHolder === agent) this.screenHolder = undefined;
    await this.publishIfChanged();
  }

  /**
   * Close the background tabs this run opened. Called once the run is terminal,
   * with a signal of its own: a cancelled run's signal is already aborted.
   */
  async closeOpened(signal: AbortSignal): Promise<void> {
    const { browser, computer, context } = this.deps;
    if (!browser.closeTab || !this.registry.list().some((tab) => tab.opened)) return;
    // Decide from the live tabs: one the user closed must not count as still open.
    if (!(await this.refresh(signal))) return;
    // Leave the user looking at where the main agent finished; a pin still wins.
    const last = this.registry.lastTabOf(MAIN_AGENT);
    const { activateTab } = browser;
    if (last && activateTab) {
      const shown = await this.serialized(() =>
        activateTab
          .call(browser, computer, { target: last.target, signal }, { ...context, signal })
          .catch(() => undefined),
      );
      if (shown && !shown.fallback && !shown.error) this.registry.fronted(shown);
    }
    for (const target of this.registry.closable()) {
      await browser
        .closeTab(computer, { target, signal }, { ...context, signal })
        .catch(() => undefined);
    }
    await this.refresh(signal);
    await this.publishIfChanged();
  }

  /**
   * What a paused run's last published strip says it opened. A resumed run starts a
   * fresh registry, and without this it would leave those tabs open for good.
   */
  restoreOpened(view: BrowserTabs): void {
    for (const tab of view.tabs) {
      if (tab.opened)
        this.registry.note(tab.target, { title: tab.title, url: tab.url }).opened = true;
    }
    this.registry.front ??= view.front;
  }

  view(): BrowserTabs {
    return {
      tabs: this.registry
        .list()
        .slice(0, MAX_VIEW_TABS)
        .map((tab) => ({
          target: tab.target,
          title: tab.title.slice(0, 200),
          // The strip is stored and shown to everyone who can see the bot: no tokens in it.
          url: redactUrlSecrets(tab.url).slice(0, 2048),
          ...(tab.owner ? { owner: this.ownerLabel(tab.owner).slice(0, 80) } : {}),
          ...(tab.purpose ? { purpose: tab.purpose } : {}),
          ...(tab.opened ? { opened: true } : {}),
        })),
      front: this.registry.front,
      pinned: this.registry.pinned,
    };
  }

  private ownerLabel(owner: string): string {
    return owner === MAIN_AGENT ? this.deps.botName : this.registry.labelOf(owner) || HELPER_LABEL;
  }

  /**
   * Bring a tab forward for the viewer: only once there is a choice, never during
   * an unaddressed call, and never while an agent's desktop actions hold the screen.
   */
  private async follow(target: string): Promise<void> {
    const { browser, computer, context } = this.deps;
    if (
      !browser.activateTab ||
      this.registry.list().length < 2 ||
      this.unaddressedCalls > 0 ||
      this.screenHolder !== undefined
    ) {
      return;
    }
    if (!this.registry.takeFollow(target)) return;
    await this.serialized(async () => {
      // A desktop hold taken while this follow waited wins.
      if (this.screenHolder !== undefined || !browser.activateTab) return;
      try {
        const result = await browser.activateTab(
          computer,
          { target, signal: context.signal },
          context,
        );
        if (!result.fallback && !result.error) this.registry.fronted(result);
      } catch {
        // Following is for the viewer; a miss changes nothing for the agent.
      }
    });
  }

  /**
   * Publish the strip when it changed: only once there are two or more tabs, plus
   * the one update that takes it back below two. Publishes go out in the order they
   * were decided, so an older view can never land last.
   */
  private publishIfChanged(): Promise<void> {
    const view = this.view();
    if (view.tabs.length < 2 && this.publishedCount < 2) return this.publishing;
    const serialized = JSON.stringify(view);
    if (serialized === this.published) return this.publishing;
    this.published = serialized;
    this.publishedCount = view.tabs.length;
    this.publishing = this.publishing.then(() => this.deps.publish(view)).catch(() => undefined);
    return this.publishing;
  }
}
