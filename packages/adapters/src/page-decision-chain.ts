import type {
  AdapterContext,
  BrowserActResult,
  BrowserProvider,
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
/** The JSON-quoted ` value="…"` an element line in a snapshot tree ends with. */
const TREE_VALUE = / value="(?:[^"\\]|\\.)*"/g;

/** Unusable goal means no goal: the decider never runs. */
export function normalizeGoal(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_GOAL_CHARS) : undefined;
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
      excerpt: snapshot.tree.replace(TREE_VALUE, ""),
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
): Promise<PageDecisionRequest["screenshot"]> {
  if (!browser.screenshot) return undefined;
  try {
    const shot = await browser.screenshot(computer, { signal: context.signal }, context);
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
): Promise<BrowserSnapshotResult | undefined> {
  try {
    const snapshot = await browser.snapshot(
      computer,
      { extended, signal: context.signal },
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
  now?: () => number;
}): Promise<PageDecisionChainResult> {
  const { browser, decider, computer, context, goal } = input;
  const clock = input.now ?? Date.now;
  const started = clock();
  const origin = originOf(input.snapshot.url);
  const sees = decider.describe().capabilities.vision;
  const history: PageDecisionAttempt[] = [];
  const acted: string[] = [];
  let snapshot = input.snapshot;

  for (;;) {
    let decision: PageDecision;
    try {
      decision = await decider.decide(
        computer,
        {
          goal,
          ...pageForDecider(snapshot, input.redactions?.() ?? []),
          history,
          screenshot: sees ? await capture(browser, computer, context) : undefined,
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
      history: history.map((a) => ({ target: a.ref, kind: a.kind, changed: a.changed })),
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

    const name =
      snapshot.elements.find((element) => element.ref === outcome.target)?.name || outcome.target;
    const before = snapshot.url + snapshot.tree;
    let result: BrowserActResult;
    try {
      result = await browser.act(
        computer,
        { actions: [{ kind: "click", ref: outcome.target }], signal: context.signal },
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

    // Re-read with rects rather than reuse the act's own snapshot, which is the
    // default, model-facing one.
    const next = await readPage(browser, computer, context, true);
    if (!next) return stop({ outcome: "escalate", reason: "snapshot_failed" });
    history.push({ ref: outcome.target, kind: "click", changed: before !== next.url + next.tree });
    snapshot = next;

    // Leaving the origin is a trust boundary. The decider reads text the page
    // controls, so a page could steer it elsewhere; the bot's model takes over.
    if (originOf(next.url) !== origin) return stop({ outcome: "escalate", reason: "left_origin" });
  }
}
