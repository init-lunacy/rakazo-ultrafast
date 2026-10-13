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

export async function browserNavigateFromTool(
  browser: BrowserProvider,
  computer: ComputerRef,
  context: AdapterContext,
  args: Record<string, unknown>,
  options: { decider?: PageDecider; redactions?: () => string[] } = {},
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
    const result = await browser.navigate(computer, { url, signal: context.signal }, context);
    const chain = await chainForGoal(browser, computer, context, args, options, result);
    return chain ? withChain(result, chain) : formatBrowserResult(result);
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
) {
  void args;
  try {
    const result = await browser.snapshot(computer, { signal: context.signal }, context);
    return formatBrowserResult(result);
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
  } = {},
) {
  try {
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
    const result = await browser.act(computer, { actions, signal: context.signal }, context);
    const chain = await chainForGoal(browser, computer, context, args, options, result);
    // Once the chain has clicked, the act's own tree is of a page it has left.
    // A default snapshot is exactly what the model would see from browser_snapshot.
    const view =
      chain && chain.acted.length > 0
        ? await readPage(browser, computer, context, false)
        : undefined;
    return redactConnectorPayload(
      chain ? withChain(result, chain, view) : formatBrowserResult(result),
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
  step: { ok?: boolean; uncertain?: boolean; fallback?: "computer_act"; error?: string },
): Promise<PageDecisionChainResult | undefined> {
  const goal = normalizeGoal(args.goal);
  if (!goal || !decider) return undefined;
  if (step.ok === false || step.uncertain || step.fallback || step.error) return undefined;
  const snapshot = await readPage(browser, computer, context, true);
  if (!snapshot) return undefined;
  return await runPageDecisionChain({
    browser,
    decider,
    computer,
    context,
    goal,
    snapshot,
    redactions,
  });
}

/**
 * The calling tool's own result, moved to where the chain landed, with the
 * decider's claims and an account of what it clicked. Once the chain has
 * clicked, the tool's own tree is of a page it left: `view` replaces it, and
 * without one it is dropped rather than mislabelled. browser_navigate's result
 * carries no tree and keeps its shape.
 */
function withChain<
  T extends {
    fallback?: "computer_act";
    error?: string;
    tree?: string;
    elements?: BrowserSnapshotNode[];
  },
>(base: T, chain: PageDecisionChainResult, view?: BrowserSnapshotResult) {
  const { tree, elements, ...rest } = base;
  const page = chain.acted.length > 0 ? view : { tree, elements };
  return formatBrowserResult({
    ...rest,
    url: chain.snapshot.url,
    title: chain.snapshot.title,
    ...(page?.tree !== undefined ? { tree: page.tree } : {}),
    ...(page?.elements !== undefined ? { elements: page.elements } : {}),
    ...(chain.acted.length > 0 ? { acted: chain.acted } : {}),
    ...(chain.goalMetConfidence !== undefined
      ? { goalMetConfidence: chain.goalMetConfidence }
      : {}),
    ...(chain.blockedConfidence !== undefined
      ? { blockedConfidence: chain.blockedConfidence }
      : {}),
    ...(chain.uncertain ? { uncertain: true } : {}),
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
