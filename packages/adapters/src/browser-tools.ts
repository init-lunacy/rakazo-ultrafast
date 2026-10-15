import type {
  AdapterContext,
  BrowserActKind,
  BrowserActStep,
  BrowserProvider,
  BrowserSnapshotNode,
  BrowserSnapshotResult,
  ComputerRef,
  PageDecider,
} from "@rakazo/adapter-kit";
import type { LoginField } from "./bot-secrets.js";
import { redactConnectorPayload } from "./connector-safety.js";
import type { PageDecisionChainResult } from "./page-decision-chain.js";
import { normalizeGoal, readPage, runPageDecisionChain } from "./page-decision-chain.js";
import type { RunBrowserTabs } from "./run-browser-tabs.js";
import { normalizePurpose } from "./run-browser-tabs.js";

const MAX_BROWSER_ACTIONS = 24;

/** Fills a saved website login by name; the model never supplies or sees the value. */
export type SecretFillStep = {
  kind: "fill_secret";
  ref: string;
  secret: string;
  field: LoginField;
};
export type BrowserActInput = BrowserActStep | SecretFillStep;
export type ResolveSecretFill = (
  step: SecretFillStep,
) => Promise<{ text: string; origin: string } | { error: string }>;

/** The run's tabs and the agent making this call. */
export type ToolTabs = { run: RunBrowserTabs; agent: string };

/** A model-facing result: the tab it ran in by handle, never the computer's own ids or pin. */
function placed<T extends { target?: string; opened?: string[]; pinned?: string | null }>(
  result: T,
  place?: { tab?: string; opened: string[] },
) {
  const { target: _target, opened: _opened, pinned: _pinned, ...rest } = result;
  return {
    ...rest,
    ...(place?.tab ? { tab: place.tab } : {}),
    ...(place?.opened.length ? { opened: place.opened } : {}),
  };
}

export async function browserTabsFromTool(run: RunBrowserTabs, agent: string) {
  return run.list(agent);
}

export async function browserNavigateFromTool(
  browser: BrowserProvider,
  computer: ComputerRef,
  context: AdapterContext,
  args: Record<string, unknown>,
  options: { decider?: PageDecider; redactions?: () => string[]; tabs?: ToolTabs } = {},
) {
  const url = String(args.url ?? "").trim();
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
      return {
        error: "An HTTP(S) URL without embedded credentials is required",
        fallback: "computer_act" as const,
      };
    }
    const where = options.tabs ? await options.tabs.run.forNavigate(options.tabs.agent, args) : {};
    if ("error" in where) return { error: where.error };
    const purpose = normalizePurpose(args.purpose);
    const requested = "target" in where ? where.target : undefined;
    const navigate = () =>
      browser.navigate(computer, { url, target: requested, signal: context.signal }, context);
    const result =
      "open" in where && options.tabs
        ? await options.tabs.run.open(options.tabs.agent, url, purpose)
        : options.tabs
          ? await options.tabs.run.within(where, navigate)
          : await navigate();
    // A failure reply names no tab; the requested one is where it failed (a closed tab, say).
    const place = options.tabs
      ? await options.tabs.run.after(
          options.tabs.agent,
          { ...result, target: result.target ?? requested },
          "act",
          purpose,
        )
      : undefined;
    if (place?.error) return { error: place.error };
    const chain = await chainForGoal(browser, computer, context, args, options, {
      ...result,
      target: result.target ?? requested,
    });
    const chainOpened =
      chain?.opened && result.target && options.tabs
        ? await options.tabs.run.adoptOpened(result.target, chain.opened)
        : [];
    const shaped = chain ? withChain(result, chain) : formatBrowserResult(result);
    return placed(shaped, place && { ...place, opened: [...place.opened, ...chainOpened] });
  } catch (error) {
    context.signal.throwIfAborted();
    return {
      error: error instanceof Error ? error.message : String(error),
      fallback: "computer_act" as const,
    };
  }
}

export async function browserSnapshotFromTool(
  browser: BrowserProvider,
  computer: ComputerRef,
  context: AdapterContext,
  args: Record<string, unknown>,
  options: { tabs?: ToolTabs } = {},
) {
  try {
    const where = options.tabs ? await options.tabs.run.forRead(options.tabs.agent, args) : {};
    if ("error" in where) return { error: where.error };
    const requested = "target" in where ? where.target : undefined;
    const read = () =>
      browser.snapshot(computer, { target: requested, signal: context.signal }, context);
    const result = options.tabs ? await options.tabs.run.within(where, read) : await read();
    const place = options.tabs
      ? await options.tabs.run.after(
          options.tabs.agent,
          { ...result, target: result.target ?? requested },
          "read",
        )
      : undefined;
    if (place?.error) return { error: place.error };
    options.tabs?.run.remember(result.target ?? requested, result);
    return placed(formatBrowserResult(result), place);
  } catch (error) {
    context.signal.throwIfAborted();
    return {
      error: error instanceof Error ? error.message : String(error),
      fallback: "computer_act" as const,
    };
  }
}

export async function browserActFromTool(
  browser: BrowserProvider,
  computer: ComputerRef,
  context: AdapterContext,
  args: Record<string, unknown>,
  options: {
    resolveSecretFill?: ResolveSecretFill;
    redactions?: () => string[];
    decider?: PageDecider;
    tabs?: ToolTabs;
  } = {},
) {
  try {
    const where = options.tabs ? await options.tabs.run.forAct(options.tabs.agent, args) : {};
    if ("error" in where) return { ok: false, completed: 0, error: where.error };
    const requested = "target" in where ? where.target : undefined;
    const actions: BrowserActStep[] = [];
    // Resolve every saved login before acting, so a missing one cannot leave a half-filled form.
    for (const step of parseBrowserActions(args.actions)) {
      if (step.kind !== "fill_secret") {
        actions.push(step);
        continue;
      }
      const resolved = options.resolveSecretFill
        ? await options.resolveSecretFill(step)
        : { error: "Saved logins are unavailable here." };
      if ("error" in resolved) return { ok: false, completed: 0, error: resolved.error };
      actions.push({ kind: "fill", ref: step.ref, text: resolved.text, origin: resolved.origin });
    }
    const act = () =>
      browser.act(computer, { actions, target: requested, signal: context.signal }, context);
    // While an unaddressed call is in flight, nothing brings another tab forward under it.
    const result = options.tabs ? await options.tabs.run.within(where, act) : await act();
    const place = options.tabs
      ? await options.tabs.run.after(
          options.tabs.agent,
          { ...result, target: result.target ?? requested },
          "act",
        )
      : undefined;
    if (place?.error) return { ok: false, completed: 0, error: place.error };
    const chain = await chainForGoal(browser, computer, context, args, options, {
      ...result,
      target: result.target ?? requested,
    });
    // Reading the page for the decider renumbered every ref, and a click left the
    // page, so the act's own tree is stale once a chain ran. A default snapshot is
    // exactly what the model would see from browser_snapshot.
    const view = chain
      ? await readPage(browser, computer, context, false, result.target ?? requested)
      : undefined;
    // The model acts next with these refs: the act's fresh tree, or the chain's view.
    options.tabs?.run.remember(result.target ?? requested, view ?? result);
    const chainOpened =
      chain?.opened && result.target && options.tabs
        ? await options.tabs.run.adoptOpened(result.target, chain.opened)
        : [];
    return redactConnectorPayload(
      placed(
        chain ? withChain(result, chain, view) : formatBrowserResult(result),
        place && { ...place, opened: [...place.opened, ...chainOpened] },
      ),
      options.redactions?.() ?? [],
    );
  } catch (error) {
    context.signal.throwIfAborted();
    return {
      ok: false,
      uncertain: true,
      error: error instanceof Error ? error.message : String(error),
      fallback: "computer_act" as const,
    };
  }
}

/**
 * Runs the chain when a goal and a decider are both present and the tool's own
 * step succeeded; otherwise undefined. A failed or uncertain step may have
 * half-happened, so nothing acts on top of it.
 */
async function chainForGoal(
  browser: BrowserProvider,
  computer: ComputerRef,
  context: AdapterContext,
  args: Record<string, unknown>,
  { decider, redactions }: { decider?: PageDecider; redactions?: () => string[] },
  step: {
    ok?: boolean;
    uncertain?: boolean;
    fallback?: "computer_act";
    error?: string;
    target?: string;
  },
): Promise<PageDecisionChainResult | undefined> {
  const goal = normalizeGoal(args.goal);
  if (!goal || !decider) return undefined;
  if (step.ok === false || step.uncertain || step.fallback || step.error) return undefined;
  const snapshot = await readPage(browser, computer, context, true, step.target);
  if (!snapshot) return undefined;
  return await runPageDecisionChain({
    browser,
    decider,
    computer,
    context,
    goal,
    snapshot,
    redactions,
    target: step.target,
  });
}

/**
 * The calling tool's own result, moved to where the chain landed, with the
 * decider's claims and an account of what it clicked. The tool's own tree is
 * stale once a chain ran: `view` replaces it, and without one it is dropped
 * rather than left with dead refs. browser_navigate's result carries no tree
 * and keeps its shape.
 */
function withChain<
  T extends {
    fallback?: "computer_act";
    error?: string;
    tree?: string;
    elements?: BrowserSnapshotNode[];
  },
>(base: T, chain: PageDecisionChainResult, view?: BrowserSnapshotResult) {
  const { tree: _tree, elements: _elements, ...rest } = base;
  return formatBrowserResult({
    ...rest,
    url: chain.snapshot.url,
    title: chain.snapshot.title,
    ...(view ? { tree: view.tree, elements: view.elements } : {}),
    ...(chain.acted.length > 0 ? { acted: chain.acted } : {}),
    ...(chain.goalMetConfidence !== undefined
      ? { goalMetConfidence: chain.goalMetConfidence }
      : {}),
    ...(chain.blockedConfidence !== undefined
      ? { blockedConfidence: chain.blockedConfidence }
      : {}),
    ...(chain.uncertain
      ? {
          uncertain: true,
          note: "The last click in acted may or may not have taken effect. Inspect the page before continuing; do not replay it.",
        }
      : {}),
  });
}
export function parseBrowserActions(value: unknown): BrowserActInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("browser_act requires at least one action");
  }
  if (value.length > MAX_BROWSER_ACTIONS) {
    throw new Error(`browser_act accepts at most ${MAX_BROWSER_ACTIONS} actions`);
  }
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object") {
      throw new Error(`browser_act action ${index} must be an object`);
    }
    const action = raw as Record<string, unknown>;
    const kind = String(action.kind ?? "") as BrowserActKind | "fill_secret";
    if (kind !== "click" && kind !== "fill" && kind !== "type" && kind !== "fill_secret") {
      throw new Error(`browser_act action ${index} has unsupported kind`);
    }
    const ref = String(action.ref ?? "").trim();
    if (!ref) throw new Error(`browser_act action ${index} requires ref`);
    if (kind === "fill_secret") {
      const secret = String(action.secret ?? "").trim();
      const field = action.field;
      if (!secret) throw new Error("browser_act fill_secret requires secret");
      if (field !== "username" && field !== "password") {
        throw new Error("browser_act fill_secret field must be username or password");
      }
      return { kind, ref, secret, field };
    }
    if (kind === "fill" || kind === "type") {
      if (typeof action.text !== "string") {
        throw new Error(`browser_act ${kind} requires text`);
      }
      return { kind, ref, text: String(action.text) };
    }
    return { kind, ref };
  });
}

function formatBrowserResult<T extends { fallback?: "computer_act"; error?: string }>(result: T) {
  if (result.fallback === "computer_act") {
    return {
      ...result,
      note: "Page browser could not complete this step. Inspect the current state before continuing with computer_act if available, otherwise request_takeover. Do not replay completed or uncertain actions.",
    };
  }
  return result;
}
