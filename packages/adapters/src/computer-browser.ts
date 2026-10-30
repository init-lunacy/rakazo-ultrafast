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
  BrowserSnapshotNode,
  BrowserSnapshotRequest,
  BrowserSnapshotResult,
  BrowserTabInfo,
  BrowserTabsRequest,
  BrowserTabsResult,
  ComputerRef,
  PageBrowserCommand,
  PageBrowserResult,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { FakeBrowserProviderOptions } from "./fake-browser.js";
import { FakeBrowserProvider } from "./fake-browser.js";

const DETACHED_MESSAGE = "Page browser is not attached to this computer's Chrome.";

type LivePayload = Partial<PageBrowserResult>;

export type LivePageBrowserDriver = (
  computer: ComputerRef,
  request: PageBrowserCommand,
  context: AdapterContext,
) => Promise<LivePayload>;

/**
 * Production page-browser adapter for the bot computer.
 *
 * Fake computers (and the fake sandbox) use the in-process DOM session.
 * Real computers drive the live Chrome already on the graphical display via
 * CDP (`rakazo-page-browser`). If that path cannot operate, return
 * `fallback: "computer_act"` — never report success against a detached DOM.
 */
export class ComputerBrowserProvider implements BrowserProvider {
  private readonly fake: FakeBrowserProvider;
  private readonly sandbox?: SandboxProvider;
  private readonly liveDriver?: LivePageBrowserDriver;

  constructor(
    options: FakeBrowserProviderOptions & {
      sandbox?: SandboxProvider;
      /** Test seam for the live CDP helper. */
      liveDriver?: LivePageBrowserDriver;
    } = {},
  ) {
    const { sandbox, liveDriver, ...fakeOptions } = options;
    this.sandbox = sandbox;
    this.liveDriver = liveDriver;
    this.fake = new FakeBrowserProvider(fakeOptions);
  }

  describe() {
    return {
      id: "computer",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        page: Boolean(
          this.liveDriver || this.sandbox?.pageBrowser || this.sandbox?.describe().id === "fake",
        ),
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
    if (this.canUseInProcess(computer)) {
      return this.fake.navigate(computer, request, context);
    }
    const live = await this.runLive(
      computer,
      { command: "navigate", url: request.url, target: request.target },
      context,
    );
    if (live?.ok !== true || live.fallback === "computer_act") {
      return {
        url: request.url,
        title: "",
        fallback: "computer_act",
        error: live?.error || DETACHED_MESSAGE,
      };
    }
    return {
      url: typeof live.url === "string" ? live.url : request.url,
      title: typeof live.title === "string" ? live.title : "",
      ...targetOf(live),
      ...openedOf(live),
      ...pinnedOf(live),
    };
  }

  async snapshot(
    computer: ComputerRef,
    request: BrowserSnapshotRequest,
    context: AdapterContext,
  ): Promise<BrowserSnapshotResult> {
    if (this.canUseInProcess(computer)) {
      return this.fake.snapshot(computer, request, context);
    }
    const live = await this.runLive(
      computer,
      {
        command: "snapshot",
        extended: request.extended,
        textOffset: request.textOffset,
        target: request.target,
      },
      context,
    );
    if (live?.ok !== true || live.fallback === "computer_act") {
      return {
        url: "",
        title: "",
        tree: "",
        elements: [],
        fallback: "computer_act",
        error: live?.error || DETACHED_MESSAGE,
      };
    }
    const elements = Array.isArray(live.elements) ? live.elements : [];
    return {
      url: typeof live.url === "string" ? live.url : "",
      title: typeof live.title === "string" ? live.title : "",
      tree: typeof live.tree === "string" ? live.tree : formatTree(elements),
      elements,
      ...(live.loading === true ? { loading: true } : {}),
      ...targetOf(live),
      ...pinnedOf(live),
    };
  }

  async screenshot(
    computer: ComputerRef,
    request: BrowserScreenshotRequest,
    context: AdapterContext,
  ): Promise<BrowserScreenshotResult> {
    if (this.canUseInProcess(computer)) {
      return this.fake.screenshot(computer, request, context);
    }
    const live = await this.runLive(
      computer,
      { command: "screenshot", target: request.target },
      context,
    );
    if (live?.ok !== true || live.fallback === "computer_act" || !live.data) {
      return {
        data: "",
        mimeType: "image/png",
        scale: 1,
        fallback: "computer_act",
        error: live?.error || DETACHED_MESSAGE,
      };
    }
    return {
      data: live.data,
      mimeType: "image/png",
      scale: typeof live.scale === "number" && live.scale > 0 ? live.scale : 1,
    };
  }

  async act(
    computer: ComputerRef,
    request: BrowserActRequest,
    context: AdapterContext,
  ): Promise<BrowserActResult> {
    if (this.canUseInProcess(computer)) {
      return this.fake.act(computer, request, context);
    }
    const live = await this.runLive(
      computer,
      { command: "act", actions: request.actions, target: request.target },
      context,
    );
    const elements = Array.isArray(live?.elements) ? live.elements : undefined;
    // The helper refused a step before changing the page: settled, and fixable without desktop tools.
    if (live?.ok === false && live.uncertain === false && live.fallback === undefined) {
      // A page snapshot sent with the refusal is kept, so the bot can pick the right field.
      const tree =
        typeof live.tree === "string" ? live.tree : elements ? formatTree(elements) : undefined;
      return {
        ok: false,
        completed: typeof live.completed === "number" ? live.completed : 0,
        uncertain: false,
        url: typeof live.url === "string" ? live.url : "",
        title: typeof live.title === "string" ? live.title : "",
        ...(tree !== undefined ? { tree, elements } : {}),
        error: live.error || DETACHED_MESSAGE,
      };
    }
    if (live?.ok !== true || live.fallback === "computer_act") {
      return {
        ok: false,
        completed: typeof live?.completed === "number" ? live.completed : 0,
        uncertain: live?.uncertain ?? true,
        url: typeof live?.url === "string" ? live.url : "",
        title: typeof live?.title === "string" ? live.title : "",
        // A step that stopped partway, such as typing, still shows the page as it was left.
        ...(elements
          ? { tree: typeof live?.tree === "string" ? live.tree : formatTree(elements), elements }
          : {}),
        fallback: "computer_act",
        error: live?.error || DETACHED_MESSAGE,
        // A partial act can open a tab before a later step fails.
        ...targetOf(live ?? {}),
        ...openedOf(live ?? {}),
        ...pinnedOf(live ?? {}),
      };
    }
    return {
      ok: true,
      completed: typeof live.completed === "number" ? live.completed : request.actions.length,
      url: typeof live.url === "string" ? live.url : "",
      title: typeof live.title === "string" ? live.title : "",
      tree: typeof live.tree === "string" ? live.tree : elements ? formatTree(elements) : undefined,
      elements,
      ...targetOf(live),
      ...openedOf(live),
      ...pinnedOf(live),
      ...(live.loading === true ? { loading: true } : {}),
    };
  }

  async tabs(
    computer: ComputerRef,
    request: BrowserTabsRequest,
    context: AdapterContext,
  ): Promise<BrowserTabsResult> {
    if (this.canUseInProcess(computer)) return this.fake.tabs(computer, request, context);
    const live = await this.runLive(computer, { command: "tabs" }, context);
    if (live?.ok !== true || live.fallback === "computer_act" || !Array.isArray(live.tabs)) {
      return { tabs: [], fallback: "computer_act", error: live?.error || DETACHED_MESSAGE };
    }
    return { tabs: tabsOf(live), ...pinnedOf(live) };
  }

  async openTab(
    computer: ComputerRef,
    request: BrowserOpenTabRequest,
    context: AdapterContext,
  ): Promise<BrowserNavigateResult> {
    if (this.canUseInProcess(computer)) return this.fake.openTab(computer, request, context);
    const live = await this.runLive(computer, { command: "open", url: request.url }, context);
    if (live?.ok !== true || live.fallback === "computer_act" || typeof live.target !== "string") {
      return {
        url: request.url,
        title: "",
        fallback: "computer_act",
        error: live?.error || DETACHED_MESSAGE,
      };
    }
    return {
      url: typeof live.url === "string" ? live.url : request.url,
      title: typeof live.title === "string" ? live.title : "",
      target: live.target,
      ...pinnedOf(live),
    };
  }

  async activateTab(
    computer: ComputerRef,
    request: BrowserActivateTabRequest,
    context: AdapterContext,
  ): Promise<BrowserActivateTabResult> {
    if (this.canUseInProcess(computer)) return this.fake.activateTab(computer, request, context);
    const live = await this.runLive(
      computer,
      // JSON drops an undefined pin, so a follow sends none.
      { command: "activate", target: request.target, pin: request.pin },
      context,
    );
    if (live?.ok !== true || live.fallback === "computer_act") {
      return {
        front: null,
        pinned: null,
        fallback: "computer_act",
        error: live?.error || DETACHED_MESSAGE,
      };
    }
    return {
      front: typeof live.front === "string" ? live.front : null,
      pinned: typeof live.pinned === "string" ? live.pinned : null,
    };
  }

  async closeTab(
    computer: ComputerRef,
    request: BrowserCloseTabRequest,
    context: AdapterContext,
  ): Promise<BrowserCloseTabResult> {
    if (this.canUseInProcess(computer)) return this.fake.closeTab(computer, request, context);
    const live = await this.runLive(
      computer,
      { command: "close", target: request.target },
      context,
    );
    return live?.ok === true ? { ok: true } : { ok: false, error: live?.error || DETACHED_MESSAGE };
  }

  private canUseInProcess(computer: ComputerRef): boolean {
    return computer.kind === "fake";
  }

  private async runLive(
    computer: ComputerRef,
    request: PageBrowserCommand,
    context: AdapterContext,
  ): Promise<LivePayload> {
    context.signal.throwIfAborted();
    try {
      const result = this.liveDriver
        ? await this.liveDriver(computer, request, context)
        : this.sandbox?.pageBrowser
          ? await this.sandbox.pageBrowser(computer, request, context)
          : {
              ok: false,
              error: DETACHED_MESSAGE,
              fallback: "computer_act" as const,
              uncertain: false,
            };
      if (result?.ok === true) {
        if (request.command === "screenshot") {
          if (typeof result.data !== "string") throw new Error("Incomplete page capture");
        } else if (request.command === "tabs") {
          if (!Array.isArray(result.tabs)) throw new Error("Incomplete tab list");
        } else if (request.command === "activate" || request.command === "close") {
          // ok alone is the whole reply.
        } else if (typeof result.url !== "string" || typeof result.title !== "string") {
          throw new Error("Incomplete page browser response");
        }
        if (request.command === "open" && typeof result.target !== "string") {
          throw new Error("Incomplete page browser response");
        }
        if (
          request.command === "snapshot" &&
          (typeof result.tree !== "string" || !Array.isArray(result.elements))
        ) {
          throw new Error("Incomplete page snapshot");
        }
        if (
          request.command === "act" &&
          (!Number.isInteger(result.completed) ||
            result.completed !== request.actions.length ||
            result.uncertain)
        ) {
          throw new Error("Unconfirmed page actions");
        }
      }
      return result;
    } catch (error) {
      context.signal.throwIfAborted();
      return {
        uncertain: request.command === "act",
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        fallback: "computer_act",
      };
    }
  }
}

/** The tab a reply ran in, when the computer reported one. */
function targetOf(live: LivePayload): { target?: string } {
  return typeof live.target === "string" && live.target ? { target: live.target } : {};
}

/** Tabs a reply says the call opened; anything malformed is dropped. */
function openedOf(live: LivePayload): { opened?: string[] } {
  const opened = Array.isArray(live.opened)
    ? live.opened.filter((value): value is string => typeof value === "string" && value !== "")
    : [];
  return opened.length > 0 ? { opened } : {};
}

/** The computer's pin, when the reply reports one (a target, or null for none). */
function pinnedOf(live: LivePayload): { pinned?: string | null } {
  return typeof live.pinned === "string" || live.pinned === null ? { pinned: live.pinned } : {};
}

/** Listed tabs with a usable id, title and URL; anything else is dropped. */
function tabsOf(live: LivePayload): BrowserTabInfo[] {
  return (Array.isArray(live.tabs) ? live.tabs : []).filter(
    (tab): tab is BrowserTabInfo =>
      Boolean(tab) &&
      typeof tab.target === "string" &&
      tab.target !== "" &&
      typeof tab.title === "string" &&
      typeof tab.url === "string",
  );
}

function formatTree(elements: BrowserSnapshotNode[]): string {
  if (elements.length === 0) return "(no interactive elements)";
  return elements
    .map((el) => {
      const value =
        el.value !== undefined && el.value !== "" ? ` value=${JSON.stringify(el.value)}` : "";
      return `- ${el.role} "${el.name}" [${el.ref}]${value}`;
    })
    .join("\n");
}
