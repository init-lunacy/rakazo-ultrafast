import type {
  AdapterContext,
  BrowserActivateTabRequest,
  BrowserActivateTabResult,
  BrowserActRequest,
  BrowserActResult,
  BrowserCloseTabRequest,
  BrowserCloseTabResult,
  BrowserNavigateRequest,
  BrowserNavigateResult,
  BrowserOpenTabRequest,
  BrowserProvider,
  BrowserScreenshotRequest,
  BrowserScreenshotResult,
  BrowserSnapshotRequest,
  BrowserSnapshotResult,
  BrowserTabsRequest,
  BrowserTabsResult,
  ComputerRef,
} from "@rakazo/adapter-kit";
import type { PageBrowserSession } from "./page-browser-session.js";
import { PageBrowserSessionStore, pageBrowserSessionKey } from "./page-browser-session.js";
import { fetchSafeWebText } from "./web-ssrf.js";

const CLOSED_TAB = "That tab is closed.";

type FakeTabs = {
  /** Open tabs in order. The first, "fake-1", uses the bot's original session. */
  order: string[];
  front: string;
  pinned: string | null;
  openers: Map<string, string>;
  next: number;
};

export interface FakeBrowserProviderOptions {
  /** Inject HTML for a URL without hitting the network (offline tests). */
  pages?: Record<string, { title?: string; html: string }>;
  fetch?: typeof globalThis.fetch;
}

/**
 * In-process page browser for offline tests and keyless core. Not a hosted
 * browser vendor: sessions are keyed by computer id so tools stay computer-scoped.
 */
export class FakeBrowserProvider implements BrowserProvider {
  readonly sessions = new PageBrowserSessionStore();
  private readonly pages: Record<string, { title?: string; html: string }>;
  private readonly fetchImpl?: typeof globalThis.fetch;
  navigateError?: Error;
  snapshotError?: Error;
  actError?: Error;
  /** When set, every method returns computer_act fallback (fallback-path tests). */
  forceFallback?: string;
  /** Models a computer image that predates the viewport capture. */
  noScreenshot?: boolean;

  private readonly tabState = new Map<string, FakeTabs>();
  /** Offline stand-in for a page opening a tab: the next successful act opens this URL. */
  popupOnNextAct?: string;

  private tabsOf(key: string): FakeTabs {
    let tabs = this.tabState.get(key);
    if (!tabs) {
      tabs = { order: ["fake-1"], front: "fake-1", pinned: null, openers: new Map(), next: 2 };
      this.tabState.set(key, tabs);
    }
    return tabs;
  }

  /**
   * The bot's first tab keeps its original session key and refs (e1, e2…), so existing
   * tests keep their page. Other tabs prefix their refs, so no two tabs share a ref.
   */
  private sessionFor(key: string, id: string): PageBrowserSession {
    if (id === "fake-1") return this.sessions.get(key);
    const session = this.sessions.get(`${key}#${id}`);
    session.refPrefix = `${id}:e`;
    return session;
  }

  /** The live pin, as the computer reports it on every reply. */
  private pinOf(key: string): { pinned: string | null } {
    const tabs = this.tabsOf(key);
    return { pinned: tabs.pinned && tabs.order.includes(tabs.pinned) ? tabs.pinned : null };
  }

  /** The session for a tab, or undefined when that tab is closed. Untargeted means the front tab. */
  private tabSession(computer: ComputerRef, context: AdapterContext, target?: string) {
    const key = pageBrowserSessionKey(computer, context);
    const tabs = this.tabsOf(key);
    const id = target ?? tabs.front;
    if (!tabs.order.includes(id)) return undefined;
    return { id, key, session: this.sessionFor(key, id) };
  }

  /** Load a URL into a session from the seeded pages, or the network when unseeded. */
  private async loadInto(
    session: PageBrowserSession,
    url: string,
    signal: AbortSignal | undefined,
    context: AdapterContext,
  ): Promise<BrowserNavigateResult> {
    const seeded = this.pages[url] ?? this.pages[stripHash(url)];
    if (seeded) {
      const html = seeded.title ? ensureTitle(seeded.html, seeded.title) : seeded.html;
      return session.load(url, html);
    }
    try {
      const { url: finalUrl, body } = await fetchSafeWebText(url, {
        fetch: this.fetchImpl,
        signal: signal ?? context.signal,
      });
      return session.load(finalUrl, body);
    } catch (error) {
      return {
        url,
        title: "",
        fallback: "computer_act",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private newTab(key: string, opener?: string): string {
    const tabs = this.tabsOf(key);
    const id = `fake-${tabs.next++}`;
    tabs.order.push(id);
    if (opener) tabs.openers.set(id, opener);
    return id;
  }

  constructor(options: FakeBrowserProviderOptions = {}) {
    this.pages = options.pages ?? {};
    this.fetchImpl = options.fetch;
  }

  describe() {
    return {
      id: "fake",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        page: true,
        refs: true,
        keyless: true,
      },
    };
  }

  async navigate(
    computer: ComputerRef,
    request: BrowserNavigateRequest,
    context: AdapterContext,
  ): Promise<BrowserNavigateResult> {
    if (this.forceFallback) {
      return {
        url: request.url,
        title: "",
        fallback: "computer_act",
        error: this.forceFallback,
      };
    }
    if (this.navigateError) throw this.navigateError;
    const url = request.url.trim();
    if (!url) {
      return { url: "", title: "", fallback: "computer_act", error: "url is required" };
    }
    const tab = this.tabSession(computer, context, request.target);
    if (!tab) return { url, title: "", fallback: "computer_act", error: CLOSED_TAB };
    const loaded = await this.loadInto(tab.session, url, request.signal, context);
    return loaded.fallback ? loaded : { ...loaded, target: tab.id, ...this.pinOf(tab.key) };
  }

  async snapshot(
    computer: ComputerRef,
    request: BrowserSnapshotRequest,
    context: AdapterContext,
  ): Promise<BrowserSnapshotResult> {
    if (this.forceFallback) {
      return {
        url: "",
        title: "",
        tree: "",
        elements: [],
        fallback: "computer_act",
        error: this.forceFallback,
      };
    }
    if (this.snapshotError) throw this.snapshotError;
    const tab = this.tabSession(computer, context, request.target);
    if (!tab) {
      return {
        url: "",
        title: "",
        tree: "",
        elements: [],
        fallback: "computer_act",
        error: CLOSED_TAB,
      };
    }
    return { ...tab.session.snapshot(request.extended), target: tab.id, ...this.pinOf(tab.key) };
  }

  // Declares the interface's parameters: callers pass all three, and a
  // zero-parameter method would reject that call.
  async screenshot(
    _computer?: ComputerRef,
    _request?: BrowserScreenshotRequest,
    _context?: AdapterContext,
  ): Promise<BrowserScreenshotResult> {
    const unavailable = this.noScreenshot
      ? "This computer has no page capture."
      : this.forceFallback;
    if (unavailable) {
      return {
        data: "",
        mimeType: "image/png",
        scale: 1,
        fallback: "computer_act",
        error: unavailable,
      };
    }
    return {
      // 1x1 transparent PNG.
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==",
      mimeType: "image/png",
      scale: 1,
    };
  }

  async act(
    computer: ComputerRef,
    request: BrowserActRequest,
    context: AdapterContext,
  ): Promise<BrowserActResult> {
    if (this.forceFallback) {
      return {
        ok: false,
        completed: 0,
        url: "",
        title: "",
        fallback: "computer_act",
        error: this.forceFallback,
      };
    }
    if (this.actError) throw this.actError;
    const tab = this.tabSession(computer, context, request.target);
    if (!tab) {
      return {
        ok: false,
        completed: 0,
        url: "",
        title: "",
        fallback: "computer_act",
        error: CLOSED_TAB,
      };
    }
    if (!request.actions?.length) {
      return {
        ok: false,
        completed: 0,
        url: tab.session.url,
        title: tab.session.title,
        error: "actions is required",
        fallback: "computer_act",
      };
    }
    const result = tab.session.act(request.actions);
    if (!result.ok || !this.popupOnNextAct) {
      return { ...result, target: tab.id, ...this.pinOf(tab.key) };
    }
    const popup = this.newTab(tab.key, tab.id);
    const url = this.popupOnNextAct;
    this.popupOnNextAct = undefined;
    await this.loadInto(this.sessionFor(tab.key, popup), url, request.signal, context);
    return { ...result, target: tab.id, opened: [popup], ...this.pinOf(tab.key) };
  }

  async tabs(
    computer: ComputerRef,
    _request: BrowserTabsRequest,
    context: AdapterContext,
  ): Promise<BrowserTabsResult> {
    if (this.forceFallback)
      return { tabs: [], fallback: "computer_act", error: this.forceFallback };
    const key = pageBrowserSessionKey(computer, context);
    const tabs = this.tabsOf(key);
    return {
      ...this.pinOf(key),
      tabs: tabs.order.map((id) => {
        const session = this.sessionFor(key, id);
        const opener = tabs.openers.get(id);
        return {
          target: id,
          title: session.title,
          url: session.url,
          ...(opener ? { openerId: opener } : {}),
        };
      }),
    };
  }

  async openTab(
    computer: ComputerRef,
    request: BrowserOpenTabRequest,
    context: AdapterContext,
  ): Promise<BrowserNavigateResult> {
    if (this.forceFallback) {
      return { url: request.url, title: "", fallback: "computer_act", error: this.forceFallback };
    }
    const key = pageBrowserSessionKey(computer, context);
    const id = this.newTab(key);
    const loaded = await this.loadInto(
      this.sessionFor(key, id),
      request.url.trim(),
      request.signal,
      context,
    );
    if (loaded.fallback) {
      // Like the computer's helper: a tab that failed to open is closed, never leaked.
      await this.closeTab(computer, { target: id }, context);
      return loaded;
    }
    return { ...loaded, target: id, ...this.pinOf(key) };
  }

  async activateTab(
    computer: ComputerRef,
    request: BrowserActivateTabRequest,
    context: AdapterContext,
  ): Promise<BrowserActivateTabResult> {
    if (this.forceFallback) {
      return { front: null, pinned: null, fallback: "computer_act", error: this.forceFallback };
    }
    const tabs = this.tabsOf(pageBrowserSessionKey(computer, context));
    if (request.pin === true && request.target === null) {
      return {
        front: null,
        pinned: null,
        fallback: "computer_act",
        error: "Pinning needs a target",
      };
    }
    if (request.target !== null && !tabs.order.includes(request.target)) {
      return { front: null, pinned: null, fallback: "computer_act", error: CLOSED_TAB };
    }
    if (request.pin === true) tabs.pinned = request.target;
    if (request.pin === false) tabs.pinned = null;
    if (tabs.pinned && !tabs.order.includes(tabs.pinned)) tabs.pinned = null;
    if (request.target !== null && (request.pin === true || tabs.pinned === null)) {
      tabs.front = request.target;
      return { front: request.target, pinned: tabs.pinned };
    }
    return { front: null, pinned: tabs.pinned };
  }

  async closeTab(
    computer: ComputerRef,
    request: BrowserCloseTabRequest,
    context: AdapterContext,
  ): Promise<BrowserCloseTabResult> {
    if (this.forceFallback) return { ok: false, error: this.forceFallback };
    const key = pageBrowserSessionKey(computer, context);
    const tabs = this.tabsOf(key);
    if (!tabs.order.includes(request.target)) return { ok: false, error: CLOSED_TAB };
    tabs.order = tabs.order.filter((id) => id !== request.target);
    tabs.openers.delete(request.target);
    this.sessions.clear(request.target === "fake-1" ? key : `${key}#${request.target}`);
    if (tabs.front === request.target) tabs.front = tabs.order[0] ?? "fake-1";
    if (tabs.order.length === 0) tabs.order.push("fake-1");
    return { ok: true };
  }
}

function stripHash(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return url;
  }
}

function ensureTitle(html: string, title: string): string {
  if (/<title[\s>]/i.test(html)) {
    return html.replace(/<title[^>]*>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`);
  }
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1><title>${escapeHtml(title)}</title>`);
  }
  return `<!doctype html><html><head><title>${escapeHtml(title)}</title></head><body>${html}</body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
