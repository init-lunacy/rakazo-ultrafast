/**
 * These shapes are declared here rather than imported from `@rakazo/adapter-kit`.
 *
 * `@rakazo/core` depends on `@rakazo/contracts` and nothing else in the
 * workspace — no file under `packages/core/src` imports adapter-kit, and adding
 * that edge for three string literals would be a new layering dependency in
 * exchange for nothing. TypeScript is structural, so the adapter-kit types
 * satisfy these at every call site without a conversion.
 */
export type PageActionKind = "click" | "fill" | "type";

export interface PageDecisionCandidateLike {
  /**
   * Opaque identifier for the thing to act on.
   *
   * A browser element ref today. Named `target` rather than `ref` because this
   * module has no browser dependency and nothing here interprets the string —
   * a desktop chain could pass a coordinate key and reuse this function as-is.
   * That is a naming choice, not an abstraction: no code is added for it.
   */
  target: string;
  kind: PageActionKind;
  confidence: number;
}

export interface PageDecisionLike {
  candidates: readonly PageDecisionCandidateLike[];
  goalMet: number;
  stuck: number;
  blocked: number;
  error?: string;
}

export interface PageDecisionAttemptLike {
  target: string;
  kind: PageActionKind;
  changed: boolean;
}

export interface PageDecisionThresholds {
  goalMet: number;
  stuck: number;
  blocked: number;
  confidence: number;
  maxSteps: number;
  maxElapsedMs: number;
}

/**
 * Starting points, not constants to trust. Published values measured on other
 * people's traffic; calibrate with the harness before relying on them. See the
 * spec's "Do not copy the thresholds".
 */
export const DEFAULT_PAGE_DECISION_THRESHOLDS: PageDecisionThresholds = {
  goalMet: 0.85,
  stuck: 0.85,
  blocked: 0.85,
  confidence: 0.7,
  maxSteps: 24,
  maxElapsedMs: 180_000,
};

export interface PageDecisionBudget {
  steps: number;
  /** Measured from the start of this browser leg, not the start of the run. */
  elapsedMs: number;
}

export interface PageDecisionPolicyInput {
  decision: PageDecisionLike;
  budget: PageDecisionBudget;
  history: readonly PageDecisionAttemptLike[];
  /** Targets that existed when this decision was made. */
  knownTargets: readonly string[];
  /**
   * Kinds the caller can actually dispatch.
   *
   * The chain can only click, because the decider never supplies text to type.
   * Without this the policy would hand back a `fill` candidate the caller must
   * then reject, skipping a clickable candidate ranked just below it — which
   * defeats the ranked fallback this function exists to provide.
   */
  dispatchableKinds: readonly PageActionKind[];
  thresholds: PageDecisionThresholds;
}

export type PageDecisionOutcome =
  | { action: "act"; target: string; kind: PageActionKind }
  | { action: "done" }
  | {
      action: "escalate";
      reason: "low_confidence" | "stuck" | "no_candidates" | "needs_text" | "error";
    }
  | { action: "takeover"; reason: string }
  | { action: "refuse"; reason: "step_budget" | "time_budget" };

/**
 * A probability from a third-party endpoint is untrusted input. Anything
 * outside 0..1, or not a number at all, means "unknown" — never "certain".
 */
function score(value: number): number {
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0;
}

/**
 * Candidates naming a real ref that has not already failed to change the page.
 * Kind is deliberately not considered here, so the caller can tell "nothing to
 * act on" apart from "something to act on, but not by me".
 */
function addressable(
  candidates: readonly PageDecisionCandidateLike[],
  history: readonly PageDecisionAttemptLike[],
  knownTargets: readonly string[],
): PageDecisionCandidateLike[] {
  const known = new Set(knownTargets);
  const inert = new Set(
    history
      .filter((attempt) => !attempt.changed)
      .map((attempt) => `${attempt.kind}:${attempt.target}`),
  );
  return candidates.filter(
    (candidate) =>
      known.has(candidate.target) && !inert.has(`${candidate.kind}:${candidate.target}`),
  );
}

/**
 * Turn one decision into one outcome. Pure: the order of these checks is the
 * policy, and every branch other than `act` and `done` lands in behavior that
 * existed before the decider, which is what makes the accuracy floor structural.
 */
export function decidePageAction(input: PageDecisionPolicyInput): PageDecisionOutcome {
  const { decision, budget, history, knownTargets, thresholds } = input;

  if (budget.steps >= thresholds.maxSteps) return { action: "refuse", reason: "step_budget" };
  if (budget.elapsedMs >= thresholds.maxElapsedMs) {
    return { action: "refuse", reason: "time_budget" };
  }

  if (score(decision.blocked) >= thresholds.blocked) {
    return { action: "takeover", reason: "interstitial" };
  }
  if (score(decision.goalMet) >= thresholds.goalMet) return { action: "done" };
  if (score(decision.stuck) >= thresholds.stuck) return { action: "escalate", reason: "stuck" };
  if (decision.error) return { action: "escalate", reason: "error" };

  const reachable = addressable(decision.candidates, history, knownTargets);
  const candidates = reachable.filter((candidate) =>
    input.dispatchableKinds.includes(candidate.kind),
  );
  if (candidates.length === 0) {
    // Distinguish "nothing usable on this page" from "the only thing worth
    // doing needs text", because the second is a normal hand-back to the model
    // and the first often means the page is not what we think it is.
    return {
      action: "escalate",
      reason: reachable.length > 0 ? "needs_text" : "no_candidates",
    };
  }

  const best = candidates.reduce((a, b) => (score(b.confidence) > score(a.confidence) ? b : a));
  if (score(best.confidence) < thresholds.confidence) {
    return { action: "escalate", reason: "low_confidence" };
  }
  return { action: "act", target: best.target, kind: best.kind };
}
