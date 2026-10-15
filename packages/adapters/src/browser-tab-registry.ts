/** A run may open this many tabs; tabs it did not open never count. */
export const MAX_RUN_TABS = 12;
/** The screen follows a different tab at most this often, so parallel agents do not flicker it. */
export const FOLLOW_DWELL_MS = 1_500;
/** The run's own agent; helpers are named by their agent IDs. */
export const MAIN_AGENT = "main";
/** A helper's label when it has none; run_subagent's own default name. */
export const HELPER_LABEL = "helper";

/**
 * A short handle for a tab, from its computer id: the same in every registry, so
 * a paused run that resumes still means the same tab by the same handle.
 */
export function tabHandle(target: string, length = 4): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < target.length; index++) {
    hash ^= target.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `t${hash.toString(36).padStart(7, "0").slice(-length)}`;
}

export function closedTabMessage(handle: string): string {
  return `${handle} is closed. Call browser_tabs.`;
}

export interface RegistryTab {
  handle: string;
  target: string;
  title: string;
  url: string;
  owner?: string;
  purpose?: string;
  /** Opened during this run, by an agent or a page; closed when the run ends. */
  opened: boolean;
  /** When this registry first saw the tab, in mark() units. */
  seen: number;
}

export type TabUse = { ok: true; tab: RegistryTab } | { ok: false; error: string };

/**
 * Which agent of one run may act in which tab. Helpers run inside the run's own
 * process, so every claim goes through this one object and two cannot both win.
 * It coordinates a run's agents; it is not a boundary against the bot.
 */
export class BrowserTabRegistry {
  private readonly tabs = new Map<string, RegistryTab>();
  private readonly lastUsed = new Map<string, string>();
  private readonly labels = new Map<string, string>();
  /** Refs each tab's snapshots handed out. Refs never repeat, so a ref names its tab. */
  private readonly refs = new Map<string, Set<string>>();
  private clock = 0;
  private pendingOpens = 0;
  private lastFollowAt = Number.NEGATIVE_INFINITY;
  front: string | null = null;
  pinned: string | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** Taken before listing tabs, so the listing cannot drop a tab learned while it was in flight. */
  mark(): number {
    return ++this.clock;
  }

  /** Match the computer's live tabs: new ones are recorded, closed ones seen before `since` drop out. */
  sync(
    live: ReadonlyArray<{ target: string; title: string; url: string }>,
    since = Number.POSITIVE_INFINITY,
  ): void {
    const alive = new Set(live.map((tab) => tab.target));
    for (const tab of this.list()) {
      if (!alive.has(tab.target) && tab.seen < since) this.forget(tab.target);
    }
    for (const tab of live) this.note(tab.target, { title: tab.title, url: tab.url });
  }

  /** Record a tab, the first time with its handle, and what it now shows. */
  note(target: string, page: { title?: string; url?: string } = {}): RegistryTab {
    let tab = this.tabs.get(target);
    if (!tab) {
      // A 4-character clash is rare; the longer form keeps both distinct.
      const short = tabHandle(target);
      const handle = this.byHandle(short) ? tabHandle(target, 7) : short;
      tab = { handle, target, title: "", url: "", opened: false, seen: this.clock };
      this.tabs.set(target, tab);
    }
    if (page.title !== undefined) tab.title = page.title;
    if (page.url !== undefined) tab.url = page.url;
    return tab;
  }

  forget(target: string): void {
    this.tabs.delete(target);
    this.refs.delete(target);
    for (const [agent, used] of [...this.lastUsed])
      if (used === target) this.lastUsed.delete(agent);
    if (this.front === target) this.front = null;
    if (this.pinned === target) this.pinned = null;
  }

  list(): RegistryTab[] {
    return [...this.tabs.values()];
  }

  byHandle(handle: string): RegistryTab | undefined {
    return this.list().find((tab) => tab.handle === handle);
  }

  byTarget(target: string): RegistryTab | undefined {
    return this.tabs.get(target);
  }

  lastTabOf(agent: string): RegistryTab | undefined {
    const target = this.lastUsed.get(agent);
    return target ? this.tabs.get(target) : undefined;
  }

  /** Whether any agent of this run has used a tab yet. */
  hasOwnedTabs(): boolean {
    return this.list().some((tab) => tab.owner);
  }

  ownedBy(agent: string): RegistryTab[] {
    return this.list().filter((tab) => tab.owner === agent);
  }

  /**
   * Record the refs a snapshot of `target` handed out. They add to earlier ones: another
   * agent's read must not orphan refs the owner still holds. A closed tab drops its set.
   */
  rememberRefs(target: string, refs: readonly string[]): void {
    if (!this.tabs.has(target)) return;
    const issued = this.refs.get(target) ?? new Set<string>();
    for (const ref of refs) issued.add(ref);
    this.refs.set(target, issued);
  }

  tabOfRefs(refs: readonly string[]): RegistryTab | null | undefined {
    const targets = [...this.refs]
      .filter(([, issued]) => refs.some((ref) => issued.has(ref)))
      .map(([target]) => target);
    if (targets.length > 1) return null;
    const [target] = targets;
    return target === undefined ? undefined : this.tabs.get(target);
  }

  /** Act in a tab: allowed when the agent owns it or nobody does, which claims it. */
  claim(agent: string, tab: RegistryTab): TabUse {
    if (tab.owner && tab.owner !== agent) {
      const who =
        tab.owner === MAIN_AGENT
          ? this.describe(tab.owner)
          : `${this.describe(tab.owner)} until it finishes`;
      return {
        ok: false,
        error: `${tab.handle} belongs to ${who}. Read it with browser_snapshot, or open your own tab with browser_navigate newTab.`,
      };
    }
    tab.owner = agent;
    this.lastUsed.set(agent, tab.target);
    return { ok: true, tab };
  }

  /** A tab this run opened for an agent. */
  adopt(
    agent: string,
    target: string,
    page?: { title?: string; url?: string },
    purpose?: string,
  ): RegistryTab {
    const tab = this.note(target, page);
    tab.owner = agent;
    tab.opened = true;
    if (purpose) tab.purpose = purpose;
    this.lastUsed.set(agent, target);
    return tab;
  }

  /** Tabs a page opened from `from` belong to whoever owns `from`. Returns their handles. */
  adoptOpened(from: string, targets: readonly string[]): string[] {
    const owner = this.tabs.get(from)?.owner;
    return targets.map((target) => {
      const tab = this.note(target);
      tab.opened = true;
      if (owner) tab.owner = owner;
      return tab.handle;
    });
  }

  canOpen(): boolean {
    return this.list().filter((tab) => tab.opened).length + this.pendingOpens < MAX_RUN_TABS;
  }

  /** Hold a place under the cap for an open in flight; false when the run is at the cap. */
  reserveOpen(): boolean {
    if (!this.canOpen()) return false;
    this.pendingOpens++;
    return true;
  }

  releaseOpen(): void {
    this.pendingOpens = Math.max(0, this.pendingOpens - 1);
  }

  label(agent: string, name: string): void {
    this.labels.set(agent, name);
  }

  /** How a refusal names an agent to another one. */
  describe(agent: string): string {
    return agent === MAIN_AGENT ? "the main agent" : `helper '${this.labelOf(agent)}'`;
  }

  labelOf(agent: string): string {
    return this.labels.get(agent) ?? HELPER_LABEL;
  }

  /** A finished helper's tabs pass to the main agent and stay open. */
  handBack(agent: string): void {
    const label = this.labels.get(agent);
    for (const tab of this.tabs.values()) {
      if (tab.owner !== agent) continue;
      tab.owner = MAIN_AGENT;
      // The helper's name keeps telling the main agent and the user what the tab was for.
      if (!tab.purpose && label) tab.purpose = label;
    }
    this.lastUsed.delete(agent);
  }

  /** How browser_tabs names an owner to the agent asking. */
  ownerFor(owner: string | undefined, viewer: string): string | undefined {
    if (!owner) return undefined;
    if (owner === viewer) return "you";
    if (owner === MAIN_AGENT) return "main";
    return `helper: ${this.labelOf(owner)}`;
  }

  /** Whether to bring `target` forward now; a yes starts the dwell. The computer still honors a pin. */
  takeFollow(target: string): boolean {
    if (this.front === target) return false;
    if (this.now() - this.lastFollowAt < FOLLOW_DWELL_MS) return false;
    this.lastFollowAt = this.now();
    return true;
  }

  /** Record which tab is in front and which is pinned, from a reply or a page opening a tab. */
  fronted(result: { front: string | null; pinned: string | null }): void {
    if (result.front) this.front = result.front;
    this.pinned = result.pinned;
  }

  /**
   * Tabs to close when the run ends: the ones it opened, except the front and
   * pinned ones and the main agent's current tab, where it finished. Never every
   * tab, since a browser with no tab is gone.
   */
  closable(): string[] {
    const all = this.list();
    const keep = new Set([this.front, this.pinned, this.lastUsed.get(MAIN_AGENT) ?? null]);
    const close = all.filter((tab) => tab.opened && !keep.has(tab.target)).map((tab) => tab.target);
    return close.length === all.length ? close.slice(1) : close;
  }
}
