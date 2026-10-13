import { describe, expect, it } from "vitest";
import type {
  PageActionKind,
  PageDecisionAttemptLike,
  PageDecisionBudget,
  PageDecisionLike,
} from "./page-decision-policy.js";
import { DEFAULT_PAGE_DECISION_THRESHOLDS, decidePageAction } from "./page-decision-policy.js";

const fresh: PageDecisionBudget = { steps: 0, elapsedMs: 0 };

function decision(over: Partial<PageDecisionLike> = {}): PageDecisionLike {
  return {
    candidates: [{ target: "e1", kind: "click", confidence: 0.95 }],
    goalMet: 0,
    stuck: 0,
    blocked: 0,
    ...over,
  };
}

function run(
  over: Partial<PageDecisionLike> = {},
  budget: PageDecisionBudget = fresh,
  history: readonly PageDecisionAttemptLike[] = [],
  elements: readonly string[] = ["e1", "e2"],
  dispatchableKinds: readonly PageActionKind[] = ["click", "fill", "type"],
) {
  return decidePageAction({
    decision: decision(over),
    budget,
    history,
    knownTargets: elements,
    dispatchableKinds,
    thresholds: DEFAULT_PAGE_DECISION_THRESHOLDS,
  });
}

describe("decidePageAction", () => {
  it("acts on a confident candidate", () => {
    expect(run()).toEqual({ action: "act", target: "e1", kind: "click" });
  });

  it("refuses when the step budget is spent", () => {
    expect(run({}, { steps: 24, elapsedMs: 0 })).toEqual({
      action: "refuse",
      reason: "step_budget",
    });
  });

  it("refuses when the time budget is spent", () => {
    expect(run({}, { steps: 0, elapsedMs: 180_000 })).toEqual({
      action: "refuse",
      reason: "time_budget",
    });
  });

  // Ordering is the policy: a bot-wall is a specific kind of stuck, and the
  // human handoff is the useful response to it.
  it("prefers takeover over escalate when blocked and stuck both fire", () => {
    expect(run({ blocked: 0.9, stuck: 0.99 })).toEqual({
      action: "takeover",
      reason: "interstitial",
    });
  });

  it("reports done when the goal is met", () => {
    expect(run({ goalMet: 0.9 })).toEqual({ action: "done" });
  });

  it("checks the budget before any score", () => {
    expect(run({ goalMet: 0.99 }, { steps: 24, elapsedMs: 0 })).toEqual({
      action: "refuse",
      reason: "step_budget",
    });
  });

  it("escalates when stuck", () => {
    expect(run({ stuck: 0.9 })).toEqual({ action: "escalate", reason: "stuck" });
  });

  it("escalates on an adapter error", () => {
    expect(run({ error: "timeout" })).toEqual({ action: "escalate", reason: "error" });
  });

  it("escalates when the best candidate is below the confidence threshold", () => {
    expect(run({ candidates: [{ target: "e1", kind: "click", confidence: 0.5 }] })).toEqual({
      action: "escalate",
      reason: "low_confidence",
    });
  });

  // Review Focus 3: a page drawn in canvas or a cross-origin frame yields no
  // elements. That is an escalation, not a crash and not a silent "done".
  it("escalates when there are no candidates at all", () => {
    expect(run({ candidates: [] })).toEqual({ action: "escalate", reason: "no_candidates" });
  });

  // Review Focus 2: a stale snapshot or an invented ref must never dispatch.
  it("escalates when every candidate names an unknown ref", () => {
    expect(
      run({ candidates: [{ target: "e99", kind: "click", confidence: 0.99 }] }, fresh, [], ["e1"]),
    ).toEqual({ action: "escalate", reason: "no_candidates" });
  });

  it("skips an unknown ref in favour of a known one", () => {
    expect(
      run(
        {
          candidates: [
            { target: "e99", kind: "click", confidence: 0.99 },
            { target: "e2", kind: "click", confidence: 0.9 },
          ],
        },
        fresh,
        [],
        ["e1", "e2"],
      ),
    ).toEqual({ action: "act", target: "e2", kind: "click" });
  });

  // Review Focus 1: scores from a third party are untrusted input. An
  // out-of-range or NaN score means "unknown", never "maximally confident".
  it.each([
    ["above one", 1.4],
    ["below zero", -0.2],
    ["not a number", Number.NaN],
  ])("treats a %s goalMet score as unknown", (_label, value) => {
    expect(run({ goalMet: value })).toEqual({ action: "act", target: "e1", kind: "click" });
  });

  it.each([
    ["above one", 1.4],
    ["below zero", -0.2],
    ["not a number", Number.NaN],
  ])("escalates rather than acting on a %s candidate confidence", (_label, value) => {
    expect(run({ candidates: [{ target: "e1", kind: "click", confidence: value }] })).toEqual({
      action: "escalate",
      reason: "low_confidence",
    });
  });

  it("does not take over on an out-of-range blocked score", () => {
    expect(run({ blocked: 2 })).toEqual({ action: "act", target: "e1", kind: "click" });
  });

  it("drops a candidate that already failed to change the page", () => {
    const history: PageDecisionAttemptLike[] = [{ target: "e1", kind: "click", changed: false }];
    expect(
      run(
        {
          candidates: [
            { target: "e1", kind: "click", confidence: 0.99 },
            { target: "e2", kind: "click", confidence: 0.8 },
          ],
        },
        fresh,
        history,
      ),
    ).toEqual({ action: "act", target: "e2", kind: "click" });
  });

  it("keeps a candidate that previously did change the page", () => {
    const history: PageDecisionAttemptLike[] = [{ target: "e1", kind: "click", changed: true }];
    expect(run({}, fresh, history)).toEqual({ action: "act", target: "e1", kind: "click" });
  });

  it("escalates when repeat-filtering empties the ranking", () => {
    const history: PageDecisionAttemptLike[] = [{ target: "e1", kind: "click", changed: false }];
    expect(run({}, fresh, history)).toEqual({ action: "escalate", reason: "no_candidates" });
  });

  // The chain can only click. A fill at the top must not hide a clickable
  // candidate ranked below it — that would defeat the ranked fallback.
  it("skips a candidate the caller cannot dispatch in favour of one it can", () => {
    expect(
      run(
        {
          candidates: [
            { target: "e1", kind: "fill", confidence: 0.99 },
            { target: "e2", kind: "click", confidence: 0.9 },
          ],
        },
        fresh,
        [],
        ["e1", "e2"],
        ["click"],
      ),
    ).toEqual({ action: "act", target: "e2", kind: "click" });
  });

  it("reports needs_text when the only addressable candidate needs typing", () => {
    expect(
      run(
        { candidates: [{ target: "e1", kind: "fill", confidence: 0.99 }] },
        fresh,
        [],
        ["e1", "e2"],
        ["click"],
      ),
    ).toEqual({ action: "escalate", reason: "needs_text" });
  });

  // needs_text and no_candidates mean different things, so they stay distinct.
  it("reports no_candidates when nothing was addressable at all", () => {
    expect(
      run(
        { candidates: [{ target: "e9", kind: "fill", confidence: 0.99 }] },
        fresh,
        [],
        ["e1"],
        ["click"],
      ),
    ).toEqual({ action: "escalate", reason: "no_candidates" });
  });

  // The threshold applies to whichever candidate is selected, never to one
  // the policy has already discarded.
  it("applies the confidence threshold after repeat-filtering", () => {
    const history: PageDecisionAttemptLike[] = [{ target: "e1", kind: "click", changed: false }];
    expect(
      run(
        {
          candidates: [
            { target: "e1", kind: "click", confidence: 0.99 },
            { target: "e2", kind: "click", confidence: 0.4 },
          ],
        },
        fresh,
        history,
      ),
    ).toEqual({ action: "escalate", reason: "low_confidence" });
  });
});
