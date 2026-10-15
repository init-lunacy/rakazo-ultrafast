import type {
  AdapterContext,
  BrowserActResult,
  BrowserProvider,
  BrowserSnapshotNode,
  BrowserSnapshotResult,
  ComputerRef,
  PageDecider,
  PageDecision,
  PageDecisionAttempt,
  PageDecisionRequest,
} from "@rakazo/adapter-kit";
import { PAGE_DECISION_MAX_EXCERPT_CHARS } from "@rakazo/adapter-kit";
import { DEFAULT_PAGE_DECISION_THRESHOLDS, decidePageAction } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { redactConnectorPayload } from "./connector-safety.js";

const MAX_GOAL_CHARS = 400;
const EMPTY: PageDecision = { candidates: [], goalMet: 0, stuck: 0, blocked: 0 };

/** A trimmed string cut to `max` characters, or undefined for anything unusable. */
export function normalizeText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/** Unusable goal means no goal: the decider never runs. */
export function normalizeGoal(value: unknown): string | undefined {
  return normalizeText(value, MAX_GOAL_CHARS);
}

/** A page URL's origin, or "" when it has none. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

export interface PageDecisionChainResult {
  outcome: "done" | "escalate" | "takeover" | "refuse";
  reason?: string;
  /** Names of the elements clicked, in order — what changed, for the model to check. */
  acted: string[];
  /** The decider's own estimates: claims for the model to verify, never verdicts. */
  goalMetConfidence?: number;
  blockedConfidence?: number;
  /** An action may have taken effect before its result was lost. */
  uncertain?: boolean;
  /** The last extended snapshot. Never handed to the model as-is: it carries rects. */
  snapshot: BrowserSnapshotResult;
  /** Tabs a chain click opened (computer target ids). */
  opened?: string[];
}

/** What a stop may record: scores and origin, never page content. */
export function decisionLogEvent(
  result: Pick<PageDecisionChainResult, "outcome" | "reason" | "acted" | "snapshot">,
  decision: PageDecision,
) {
  return {
    event: "page_decider.decision",
    outcome: result.outcome,
    reason: result.reason,
    steps: result.acted.length,
    origin: originOf(result.snapshot.url),
    goalMet: decision.goalMet,
    stuck: decision.stuck,
    blocked: decision.blocked,
    topConfidence: decision.candidates[0]?.confidence ?? null,
  };
}

/** The ` value="…"` an element line in a snapshot tree ends with, or "". */
function valueSuffix(element: BrowserSnapshotNode): string {
  return element.value !== undefined && element.value !== ""
    ? ` value=${JSON.stringify(element.value)}`
    : "";
}

/**
 * The tree with every element's ref, and optionally its value, cut out. Cut by
 * exact text built from the snapshot's own elements, never by pattern: names are
 * page-controlled, and a name ending in ` value=` would steer a pattern.
 */
function treeWithout(snapshot: BrowserSnapshotResult, keepValues: boolean): string {
  let tree = snapshot.tree;
  for (const element of snapshot.elements) {
    const value = valueSuffix(element);
    tree = tree.split(`[${element.ref}]${value}`).join(keepValues ? value : "");
  }
  return tree;
}

/**
 * What an element is, independent of its ref. Refs are renumbered on every
 * snapshot, so attempts are remembered by this and mapped back to current refs.
 */
function identityOf(element: BrowserSnapshotNode): string {
  return JSON.stringify([element.role, element.name, element.tag ?? ""]);
}

/**
 * What the decider is shown of a page: no more than the model gets. Element
 * values never leave, since one can hold a typed secret and the decider has no
 * use for it, and the run's secrets are scrubbed as they are from the model's copy.
 */
function pageForDecider(
  snapshot: BrowserSnapshotResult,
  secrets: string[],
): Pick<PageDecisionRequest, "elements" | "excerpt" | "url" | "title"> {
  const page = redactConnectorPayload(
    {
      elements: snapshot.elements.map(({ value: _value, ...element }) => element),
      excerpt: treeWithout(snapshot, false),
      url: snapshot.url,
      title: snapshot.title,
    },
    secrets,
  ) as Pick<PageDecisionRequest, "elements" | "excerpt" | "url" | "title">;
  // Cut only after scrubbing: a secret split by the cut would no longer match.
  return { ...page, excerpt: page.excerpt.slice(0, PAGE_DECISION_MAX_EXCERPT_CHARS) };
}

/** One viewport capture for a seeing decider, or nothing. Never throws. */
async function capture(
  browser: BrowserProvider,
  computer: ComputerRef,
  context: AdapterContext,
  target?: string,
): Promise<PageDecisionRequest["screenshot"]> {
  if (!browser.screenshot) return undefined;
  try {
    const shot = await browser.screenshot(computer, { target, signal: context.signal }, context);
    return shot.fallback || !shot.data
      ? undefined
      : { data: shot.data, mimeType: "image/png", scale: shot.scale };
  } catch {
    return undefined;
  }
}

/**
 * A snapshot, or nothing when the page browser cannot take one. Never throws.
 * `extended` is the decider's view, with rects; the default is the model's.
 */
export async function readPage(
  browser: BrowserProvider,
  computer: ComputerRef,
  context: AdapterContext,
  extended: boolean,
  target?: string,
): Promise<BrowserSnapshotResult | undefined> {
  try {
    const snapshot = await browser.snapshot(
      computer,
      { extended, target, signal: context.signal },
      context,
    );
    return snapshot.fallback || snapshot.error ? undefined : snapshot;
  } catch {
    return undefined;
  }
}

/**
 * Run confident clicks back to back, stopping the moment the policy is unsure.
 * Every stop lands in behavior that existed before, so the worst case is the
 * previous loop plus one decision. Nothing in here throws: a failing decider or
 * click becomes an escalation, never a failed tool call.
 */
export async function runPageDecisionChain(input: {
  browser: BrowserProvider;
  decider: PageDecider;
  computer: ComputerRef;
  context: AdapterContext;
  goal: string;
  /** An extended snapshot of the page the chain starts on. */
  snapshot: BrowserSnapshotResult;
  /** The run's secrets, scrubbed from everything the decider is shown. */
  redactions?: () => string[];
  /** The tab the chain runs in; it never acts elsewhere. */
  target?: string;
  now?: () => number;
}): Promise<PageDecisionChainResult> {
  const { browser, decider, computer, context, goal } = input;
  const clock = input.now ?? Date.now;
  const started = clock();
  const origin = originOf(input.snapshot.url);
  const sees = decider.describe().capabilities.vision;
  const history: Array<{ identity: string; kind: "click"; changed: boolean }> = [];
  const acted: string[] = [];
  let snapshot = input.snapshot;

  for (;;) {
    // Past attempts on this page's current refs; an element that is gone drops out.
    const attempts: PageDecisionAttempt[] = history.flatMap((attempt) =>
      snapshot.elements
        .filter((element) => identityOf(element) === attempt.identity)
        .map((element) => ({ ref: element.ref, kind: attempt.kind, changed: attempt.changed })),
    );
    let decision: PageDecision;
    try {
      decision = await decider.decide(
        computer,
        {
          goal,
          ...pageForDecider(snapshot, input.redactions?.() ?? []),
          history: attempts,
          screenshot: sees ? await capture(browser, computer, context, input.target) : undefined,
          signal: context.signal,
        },
        context,
      );
    } catch {
      decision = { ...EMPTY, error: "The page decider failed." };
    }

    // The decider speaks refs; the policy speaks opaque targets, which is what
    // lets a desktop chain reuse it later. The adaptation is these maps.
    const outcome = decidePageAction({
      decision: {
        ...decision,
        candidates: decision.candidates.map((c) => ({
          target: c.ref,
          kind: c.kind,
          confidence: c.confidence,
        })),
      },
      budget: { steps: acted.length, elapsedMs: clock() - started },
      history: attempts.map((a) => ({ target: a.ref, kind: a.kind, changed: a.changed })),
      knownTargets: snapshot.elements.map((element) => element.ref),
      dispatchableKinds: ["click"],
      thresholds: DEFAULT_PAGE_DECISION_THRESHOLDS,
    });

    const stop = (result: Omit<PageDecisionChainResult, "acted" | "snapshot">) => {
      const full = { ...result, acted, snapshot };
      getLogger().info("page decider stopped", decisionLogEvent(full, decision));
      return full;
    };

    if (outcome.action === "done") {
      return stop({ outcome: "done", goalMetConfidence: decision.goalMet });
    }
    if (outcome.action === "takeover") {
      // A claim, like goalMet: the bot's model looks at the page and decides
      // whether to request_takeover. A false takeover interrupts a person.
      return stop({
        outcome: "takeover",
        reason: outcome.reason,
        blockedConfidence: decision.blocked,
      });
    }
    if (outcome.action !== "act") return stop({ outcome: outcome.action, reason: outcome.reason });

    const target = snapshot.elements.find((element) => element.ref === outcome.target);
    const name = target?.name || outcome.target;
    // Ref-free, so a re-read of an unchanged page compares equal.
    const before = snapshot.url + treeWithout(snapshot, true);
    let result: BrowserActResult;
    try {
      result = await browser.act(
        computer,
        {
          actions: [{ kind: "click", ref: outcome.target }],
          target: input.target,
          signal: context.signal,
        },
        context,
      );
    } catch {
      result = {
        ok: false,
        completed: 0,
        uncertain: true,
        url: snapshot.url,
        title: snapshot.title,
      };
    }
    if (result.uncertain) {
      acted.push(name);
      return stop({ outcome: "escalate", reason: "uncertain", uncertain: true });
    }
    if (!result.ok || result.fallback) return stop({ outcome: "escalate", reason: "act_failed" });
    acted.push(name);
    // A tab the click opened is a new page the decider has not seen: hand it to the model.
    if (result.opened?.length) {
      return { ...stop({ outcome: "escalate", reason: "opened_tab" }), opened: result.opened };
    }

    // Re-read with rects rather than reuse the act's own snapshot, which is the
    // default, model-facing one.
    const next = await readPage(browser, computer, context, true, input.target);
    if (!next) return stop({ outcome: "escalate", reason: "snapshot_failed" });
    if (target) {
      history.push({
        identity: identityOf(target),
        kind: "click",
        changed: before !== next.url + treeWithout(next, true),
      });
    }
    snapshot = next;

    // Leaving the origin is a trust boundary. The decider reads text the page
    // controls, so a page could steer it elsewhere; the bot's model takes over.
    if (originOf(next.url) !== origin) return stop({ outcome: "escalate", reason: "left_origin" });
  }
}
