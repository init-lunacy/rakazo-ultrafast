# Page Decider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a fast decider answer the browser loop's per-step questions — which element, done yet, stuck, blocked — so confident steps run without a frontier-model screenshot round trip, while every unsure step falls through to today's behavior.

**Architecture:** A `PageDecider` adapter beside `BrowserProvider`, a pure policy function in `@rakazo/core`, and a chain inside the browser tools that runs confident clicks back to back. Two real deciders: `model`, which runs any connected model through the agent runtime exactly as Auto Review runs its checker, and `systemone`, which calls hosted Jev through the code the Auto Review Jev client already uses. A decider is chosen per bot and is off by default.

**Tech Stack:** TypeScript (ES modules, top-level `import type` only), pnpm workspaces, Turbo, Vitest, Prisma/Postgres, Zod 4, Biome, React with `@rakazo/ui-web`. The in-computer helper is Python with embedded JavaScript, driving Chrome over CDP.

**Spec:** `docs/superpowers/specs/2026-10-12-page-decider-design.md`. Read it before Task 1.

## Global Constraints

Every task's requirements implicitly include these.

- Top-level `import type` only, never inline type imports.
- No new provider- or model-specific environment variable. Jev uses the existing `TYPESAFE_API_KEY`; models use existing connections.
- Tests are deterministic and offline. No test reaches the network.
- The decider never produces text to type and never dispatches a coordinate. It names a ref; the browser path acts on it.
- Policy thresholds are configuration with these defaults: `goalMet` 0.85, `stuck` 0.85, `blocked` 0.85, candidate confidence 0.70, 24 steps, 180000 ms.
- Snapshot element cap is 240, under the System One protocol's 255-option ceiling. Element rects are CSS pixels relative to the viewport; the screenshot is a CDP viewport capture, never the desktop observe frame.
- Logs carry outcome, reason, scores and URL origin only — never page text, element names, or a full URL.
- Public repository: no secrets, real hostnames or personal data. Seeded pages use `example.test`.
- No CAPTCHA solving. An interstitial routes to `request_takeover`.
- The only new user-facing words are the select's label `Page decider` and its default option `Off`.
- Run `pnpm lint` before each commit. Do not run `pnpm --filter @rakazo/desktop test:e2e` locally; CI runs it.

## Review Focus

Inputs the spec implies that a task-by-task reading would leave untested, most likely first. Each is pinned by a test in the task named.

1. **A probability outside 0..1, or `NaN`, from a third party.** Treated as unknown, never as maximal confidence. Task 2.
2. **A ref that is not in the snapshot** (stale page, invented ref). Escalate; never dispatch it. Task 2.
3. **An empty element list** (canvas page, cross-origin frame). Escalate, no crash, no false "done". Task 2.
4. **The decider times out or fails mid-chain.** Escalate, and never replay an action whose result was uncertain. Tasks 5, 6 and 8.
5. **`goal` arrives empty, whitespace, or absurdly long.** Treated as absent: the decider never runs and output is byte-identical to today. Task 8.
6. **A mixed fleet** — a computer image without rects or without the capture. The model decider falls back to the element list; nothing breaks. Tasks 3 and 6.

## Existing code this plan builds on

Each row replaces something an earlier draft would have built from scratch.

| Fixture | Where | Used for |
|---|---|---|
| Auto Review's LLM checker | `packages/adapters/src/auto-review.ts` | the `model` decider: `runtime.run` with `tools: []`, `history: []`, JSON-only instructions, `done` text, usage forwarding |
| `AgentRunRequest.images` | `packages/adapter-kit/src/types.ts:462` | sending the viewport capture to a model that can see |
| `resolveConnectedModel` | `packages/adapters/src/executor.ts:2955` | resolving the decider's model exactly as backup and helper models are resolved |
| `recordUsage` | `executor.ts`, as in the Auto Review wiring at `:4389` | billing decider calls |
| `modelAcceptsImageInput` | `packages/adapters/src/model-vision.ts:87` | deciding whether to capture a screenshot at all |
| Jev HTTP client | `packages/adapters/src/jev-auto-review.ts` | the `systemone` request, response cap and validation, extracted and shared |
| `JEV_AUTO_REVIEW_PROVIDER`, `typesafeApiKey` | `packages/adapters/src/auto-review.ts` | the provider id `"jev"` and the existing key reader |
| `aiConsentStatus` recipients | `apps/api/src/ai-consent.ts` | consent for the decider as one more `"model"` recipient |
| `visible()` rect, `eval_json`, CDP session | `infra/sandboxes/computer/rakazo-page-browser` | element rects and the viewport capture |
| live snapshot passthrough | `packages/adapters/src/computer-browser.ts:112` | `rect` reaches callers with no change to `snapshot()` |
| `buildSnapshot` | `packages/adapters/src/page-browser-session.ts:196` | deterministic rects for offline tests |
| `formatBrowserResult`, `redactConnectorPayload` | `packages/adapters/src/browser-tools.ts` | keeping tool results and redaction exactly as they are |
| `unchangedVisualStreakAfterPageBrowser` | `packages/adapters/src/computer-tools.ts` | the cross-path loop guard the chain must not break |
| `getLogger` | `@rakazo/logging` | decision logging |
| Bot model fields end to end | `schema.prisma:422`, `contracts/src/domain.ts`, `db/src/repos.ts:102`, `api/src/router.ts:1761` | the decider columns follow the same path |
| `ticketBoardEnabled` | `contracts/src/domain.ts` `MeSchema`, `api/src/env.ts:176` | the precedent for telling the web Jev is available |
| Model `NativeSelect` and the Advanced `<details>` | `apps/web/src/pages/shell/bot-panel.tsx:570`, `:546` | the picker, and its progressive disclosure |
| Conformance layout | `packages/adapters/src/browser-conformance.test.ts` | the decider conformance suite |

## File Structure

**Create:**

| File | Responsibility |
|---|---|
| `packages/adapter-kit/src/page-decider.ts` | `PageDecider` and its request and result types |
| `packages/core/src/page-decision-policy.ts` | Pure policy: decision + budget + thresholds → one outcome |
| `packages/adapters/src/fake-page-decider.ts` | Seeded decider for offline tests |
| `packages/adapters/src/page-decider-conformance.test.ts` | Every decider satisfies the contract |
| `packages/adapters/src/systemone-client.ts` | System One HTTP, shared with Auto Review |
| `packages/adapters/src/systemone-page-decider.ts` | `systemone` decider |
| `packages/adapters/src/model-page-decider.ts` | `model` decider and point-to-ref mapping |
| `packages/adapters/src/page-decider-for-run.ts` | Builds the bot's decider for one run |
| `packages/adapters/src/page-decision-chain.ts` | decide → policy → act loop |

**Modify:** `packages/adapter-kit/src/{registry,index,types,interfaces}.ts`, `packages/core/src/index.ts`, `infra/sandboxes/computer/rakazo-page-browser`, `packages/adapters/src/{computer-browser,fake-browser,page-browser-session,jev-auto-review,browser-tools,builtin-tools,executor,index}.ts`, `packages/db/prisma/schema.prisma`, `packages/db/src/repos.ts`, `packages/contracts/src/domain.ts`, `apps/api/src/{router,env,ai-consent}.ts`, `apps/web/src/pages/shell/bot-panel.tsx`.

Not modified: `BrowserCapabilities`, `browser-emulator.ts` (it extends `FakeBrowserProvider` and inherits everything), and the `Run` table.

---

### Task 1: Contract and slot

**Files:**
- Create: `packages/adapter-kit/src/page-decider.ts`
- Modify: `packages/adapter-kit/src/registry.ts`, `packages/adapter-kit/src/index.ts`
- Test: `packages/adapter-kit/src/registry.test.ts`

**Interfaces:**
- Produces: `PageDecider`, `PageDeciderCapabilities`, `PageDecisionRequest`, `PageDecisionAttempt`, `PageDecision`, `PageDecisionCandidate`, `slots.pageDecider`. Every later task uses these names.

The capabilities object carries only `vision`, because it is the only one anything branches on: the chain captures a screenshot only for a decider that uses one. An earlier draft also declared `pick`, `scores` and `keyless`, which were always true or never read.

- [ ] **Step 1: Write the failing test**

Append inside the `describe` in `packages/adapter-kit/src/registry.test.ts`:

```typescript
  it("exposes a page-decider slot", () => {
    expect(slots.pageDecider).toBe("page-decider");
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/adapter-kit/src/registry.test.ts`
Expected: FAIL — `expected undefined to be "page-decider"`.

- [ ] **Step 3: Write the contract**

Create `packages/adapter-kit/src/page-decider.ts`:

```typescript
import type {
  AdapterContext,
  AdapterDescriptor,
  BrowserActKind,
  BrowserSnapshotNode,
  ComputerRef,
} from "./types.js";

export interface PageDeciderCapabilities {
  /** True when the decider uses a screenshot. The chain captures one only then. */
  vision: boolean;
}

export interface PageDecisionAttempt {
  ref: string;
  kind: BrowserActKind;
  /** Whether the page changed after this attempt. */
  changed: boolean;
}

export interface PageDecisionRequest {
  /** The current browser leg's goal, written by the bot's model. */
  goal: string;
  /** Candidates, verbatim from BrowserSnapshotResult.elements. */
  elements: readonly BrowserSnapshotNode[];
  /** Bounded visible page text. */
  excerpt: string;
  url: string;
  title: string;
  history: readonly PageDecisionAttempt[];
  /**
   * Base64 CDP viewport capture. `scale` is image pixels per CSS pixel, so a
   * point in the image divides by it to land in element-rect space.
   */
  screenshot?: { data: string; mimeType: "image/png"; scale: number };
  signal?: AbortSignal;
}

export interface PageDecisionCandidate {
  ref: string;
  kind: BrowserActKind;
  confidence: number;
  /** How the candidate was found. Diagnostic only; the policy ignores it. */
  source?: "list" | "point";
}

export interface PageDecision {
  /** Ranked best first. Empty when the decider declines to pick. */
  candidates: readonly PageDecisionCandidate[];
  goalMet: number;
  stuck: number;
  blocked: number;
  error?: string;
}

/**
 * A fast decision for one browser step. Names a ref and a kind, never text to
 * type and never a coordinate; the caller's policy decides whether to trust it.
 */
export interface PageDecider {
  describe(): AdapterDescriptor<PageDeciderCapabilities>;
  decide(
    computer: ComputerRef,
    request: PageDecisionRequest,
    context: AdapterContext,
  ): Promise<PageDecision>;
}
```

- [ ] **Step 4: Add the slot and export**

In `packages/adapter-kit/src/registry.ts`, in `slots`, after `browser: "browser",`:

```typescript
  pageDecider: "page-decider",
```

In `packages/adapter-kit/src/index.ts`, in alphabetical position:

```typescript
export * from "./page-decider.js";
```

- [ ] **Step 5: Verify**

Run: `pnpm vitest run packages/adapter-kit/src/registry.test.ts && pnpm --filter @rakazo/adapter-kit check`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/adapter-kit/src/page-decider.ts packages/adapter-kit/src/registry.ts packages/adapter-kit/src/index.ts packages/adapter-kit/src/registry.test.ts
git commit -m "feat(adapter-kit): add the page decider contract"
```

---

### Task 2: The policy function

The heart of the design. Pure, no I/O, and it owns three of the six Review Focus items. Write every test before any implementation.

**Files:**
- Create: `packages/core/src/page-decision-policy.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/page-decision-policy.test.ts`

**Interfaces:**
- Consumes: nothing. The policy declares its own structural types, because `@rakazo/core` depends only on `@rakazo/contracts` and no file in it imports adapter-kit.
- Produces: `decidePageAction(input: PageDecisionPolicyInput): PageDecisionOutcome`, `DEFAULT_PAGE_DECISION_THRESHOLDS`, and the types `PageActionKind`, `PageDecisionLike`, `PageDecisionCandidateLike`, `PageDecisionAttemptLike`, `PageDecisionBudget`, `PageDecisionThresholds`, `PageDecisionPolicyInput`, `PageDecisionOutcome`. Identifiers are `target`, not `ref`: nothing here interprets them, so a desktop chain could reuse this unchanged. Task 8 calls it.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/page-decision-policy.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAGE_DECISION_THRESHOLDS,
  decidePageAction,
  type PageActionKind,
  type PageDecisionAttemptLike,
  type PageDecisionBudget,
  type PageDecisionLike,
} from "./page-decision-policy.js";

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/src/page-decision-policy.test.ts`
Expected: FAIL — cannot resolve `./page-decision-policy.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/page-decision-policy.ts`:

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/src/page-decision-policy.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Export and typecheck**

In `packages/core/src/index.ts`, add in alphabetical position:

```typescript
export * from "./page-decision-policy.js";
```

Run: `pnpm --filter @rakazo/core check && pnpm lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/page-decision-policy.ts packages/core/src/page-decision-policy.test.ts packages/core/src/index.ts
git commit -m "feat(core): add the page decision policy"
```

---

---


### Task 3: Element rects and a viewport capture

The page browser reports where each element is and can capture the viewport in the same coordinate space. Both are optional, so a provider on an older computer image loses the vision path and nothing else.

**Files:**
- Modify: `packages/adapter-kit/src/types.ts`, `packages/adapter-kit/src/interfaces.ts`, `infra/sandboxes/computer/rakazo-page-browser`, `packages/adapters/src/computer-browser.ts`, `packages/adapters/src/page-browser-session.ts`, `packages/adapters/src/fake-browser.ts`
- Test: `packages/adapters/src/browser-conformance.test.ts`

**Interfaces:**
- Produces: `BrowserSnapshotNode.rect?`, `BrowserScreenshotRequest`, `BrowserScreenshotResult`, optional `BrowserProvider.screenshot`, the `{ command: "screenshot" }` page-browser command, and `FakeBrowserProvider.noScreenshot`.

`BrowserCapabilities` gains nothing. An earlier draft added a required `geometry` flag, which would have forced an edit to every browser provider; consumers can simply check whether an element has a `rect`.

The capture comes from CDP rather than the desktop frame because a desktop frame is the whole screen in device pixels while rects are viewport CSS pixels; reconciling them needs a window offset and a device pixel ratio that X11 reports unreliably, and every error there is a click in the wrong place. A viewport capture shares the rects' space, leaving one known scale factor.

- [ ] **Step 1: Write the failing conformance assertions**

In `packages/adapters/src/browser-conformance.test.ts`, at the end of `assertBrowserConformance`:

```typescript
  // Rects are optional — older computer images report none — but a rect that
  // is present must be usable.
  for (const element of snap.elements) {
    if (!element.rect) continue;
    expect(element.rect.width).toBeGreaterThan(0);
    expect(element.rect.height).toBeGreaterThan(0);
  }

  if (provider.screenshot) {
    const shot = await provider.screenshot(computer, {}, context);
    if (!shot.fallback) {
      expect(shot.data.length).toBeGreaterThan(0);
      expect(shot.mimeType).toBe("image/png");
      expect(shot.scale).toBeGreaterThan(0);
    }
  }
```

And a case in the `describe`:

```typescript
  it("reports rects and a capture offline", async () => {
    const provider = new FakeBrowserProvider({ pages: seededPages });
    await provider.navigate(computer, { url: "https://example.test/form" }, context);
    const snap = await provider.snapshot(computer, {}, context);
    expect(snap.elements.every((element) => element.rect)).toBe(true);
    expect((await provider.screenshot(computer, {}, context)).fallback).toBeUndefined();
  });

  it("reports no capture when the computer image predates it", async () => {
    const provider = new FakeBrowserProvider({ pages: seededPages });
    provider.noScreenshot = true;
    expect((await provider.screenshot(computer, {}, context)).fallback).toBe("computer_act");
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/adapters/src/browser-conformance.test.ts`
Expected: FAIL — `provider.screenshot` is not a function, and `rect` is undefined.

- [ ] **Step 3: Add the types**

In `packages/adapter-kit/src/types.ts`, add to `BrowserSnapshotNode`:

```typescript
  /** Viewport CSS pixels, matching a viewport capture. Absent on older computer images. */
  rect?: { x: number; y: number; width: number; height: number };
```

Next to the other browser types:

```typescript
export interface BrowserScreenshotRequest {
  signal?: AbortSignal;
}

export interface BrowserScreenshotResult {
  /** Base64 PNG, no data: prefix. Empty when `fallback` is set. */
  data: string;
  mimeType: "image/png";
  /** Image pixels per CSS pixel — the device pixel ratio. */
  scale: number;
  fallback?: "computer_act";
  error?: string;
}
```

Extend the command union and result:

```typescript
export type PageBrowserCommand =
  | { command: "navigate"; url: string }
  | { command: "snapshot" }
  | { command: "screenshot" }
  | { command: "act"; actions: BrowserActStep[] };

export type PageBrowserResult = Partial<
  BrowserSnapshotResult & BrowserActResult & Omit<BrowserScreenshotResult, "mimeType">
> & { ok: boolean };
```

In `packages/adapter-kit/src/interfaces.ts`, add to `BrowserProvider` (and its type import):

```typescript
  /** A viewport capture in the same space as snapshot rects. Optional: older images lack it. */
  screenshot?(
    computer: ComputerRef,
    request: BrowserScreenshotRequest,
    context: AdapterContext,
  ): Promise<BrowserScreenshotResult>;
```

- [ ] **Step 4: Rects and the capture in the in-computer helper**

In `infra/sandboxes/computer/rakazo-page-browser`, beside `visible()`:

```javascript
  function rectOf(el) {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  }
```

In `snapshot()`'s element loop, add `rect: rectOf(el),` to the pushed object, and raise the cap:

```javascript
        if (elements.length >= 240) break;
```

Beside the Python `snapshot` function:

```python
def screenshot(client: CdpClient, session_id: str) -> dict[str, Any]:
    # The viewport capture shares getBoundingClientRect's space. It is in device
    # pixels, so report devicePixelRatio — not visualViewport.scale, which is
    # pinch-zoom — as the one conversion a consumer needs.
    ensure_helpers(client, session_id)
    ratio = eval_json(client, session_id, "window.devicePixelRatio")
    shot = client.call(
        "Page.captureScreenshot",
        {"format": "png", "captureBeyondViewport": False},
        session_id=session_id,
        timeout_s=15.0,
    )
    return {
        "ok": True,
        "data": shot.get("data") or "",
        "scale": ratio if isinstance(ratio, (int, float)) and ratio > 0 else 1,
    }
```

In `run()`'s dispatch, beside `snapshot`:

```python
            elif command == "screenshot":
                result = screenshot(client, session_id)
```

- [ ] **Step 5: The computer provider**

`ComputerBrowserProvider.snapshot` already passes `live.elements` through untouched (`computer-browser.ts:112`), so rects need no change there. Add the capture after `snapshot`:

```typescript
  async screenshot(
    computer: ComputerRef,
    request: BrowserScreenshotRequest,
    context: AdapterContext,
  ): Promise<BrowserScreenshotResult> {
    if (this.canUseInProcess(computer)) {
      return this.fake.screenshot(computer, request, context);
    }
    const live = await this.runLive(computer, { command: "screenshot" }, context);
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
```

- [ ] **Step 6: Offline rects and capture**

jsdom has no layout, so `page-browser-session.ts`'s `buildSnapshot` assigns stacked boxes by position. In its loop, directly before `elements.push(entry);`:

```typescript
      // Deterministic geometry: offline point mapping needs real boxes.
      entry.rect = { x: 0, y: elements.length * 24, width: 320, height: 24 };
```

In `packages/adapters/src/fake-browser.ts`, beside the existing `forceFallback` flag:

```typescript
  /** Models a computer image that predates the viewport capture. */
  noScreenshot?: boolean;

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
      return { data: "", mimeType: "image/png", scale: 1, fallback: "computer_act", error: unavailable };
    }
    return {
      // 1x1 transparent PNG.
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==",
      mimeType: "image/png",
      scale: 1,
    };
  }
```

Add `BrowserScreenshotRequest` and `BrowserScreenshotResult` to `fake-browser.ts`'s existing `import type` from `@rakazo/adapter-kit`, and the same two to `computer-browser.ts`'s.

`EmulatorBrowserProvider` extends `FakeBrowserProvider` and overrides only `id`, so it inherits both.

- [ ] **Step 7: Verify**

Run: `pnpm vitest run packages/adapters/src/browser-conformance.test.ts packages/adapters/src/computer-browser.test.ts packages/adapters/src/browser-tools.test.ts packages/adapters/src/page-browser-login-fill.test.ts`
Expected: PASS, with no edits to the existing assertions.

Run: `python3 -c "import ast; ast.parse(open('infra/sandboxes/computer/rakazo-page-browser').read()); print('helper parses')"`
Expected: `helper parses`

Run: `pnpm sandbox:build`
Expected: the computer image builds.

E2B, Daytona and Box ship their own images. Until those carry this helper they report no rects and no capture, and Task 6's decider falls back to the element list. Say so in the PR description.

- [ ] **Step 8: Commit**

```bash
git add packages/adapter-kit/src/types.ts packages/adapter-kit/src/interfaces.ts infra/sandboxes/computer/rakazo-page-browser packages/adapters/src/computer-browser.ts packages/adapters/src/page-browser-session.ts packages/adapters/src/fake-browser.ts packages/adapters/src/browser-conformance.test.ts
git commit -m "feat(browser): report element rects and a viewport capture"
```

---

### Task 4: Fake decider and the conformance suite

**Files:**
- Create: `packages/adapters/src/fake-page-decider.ts`, `packages/adapters/src/page-decider-conformance.test.ts`
- Modify: `packages/adapters/src/index.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces: `FakePageDecider` (options `decisions`, `error`, `vision`; public `requests`). Tasks 5 and 6 add cases to the conformance file.

The `vision` option lets chain tests model a decider that wants pixels without a wrapper object.

- [ ] **Step 1: Write the failing suite**

Create `packages/adapters/src/page-decider-conformance.test.ts`:

```typescript
import type { AdapterContext, ComputerRef, PageDecider } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { FakePageDecider } from "./fake-page-decider.js";

const context: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

const computer: ComputerRef = { id: "c1", botId: "b1", kind: "fake", providerRef: "c1" };

const request = {
  goal: "Press continue",
  elements: [
    { ref: "e1", role: "textbox", name: "Email" },
    { ref: "e2", role: "button", name: "Continue" },
  ],
  excerpt: "Signup",
  url: "https://example.test/form",
  title: "Signup",
  history: [],
};

/** Every decider: in-range scores, only offered refs, cancellation honored. */
async function assertConformance(decider: PageDecider) {
  expect(decider.describe().contractVersion).toBe("1");
  expect(typeof decider.describe().capabilities.vision).toBe("boolean");

  const decision = await decider.decide(computer, request, context);
  for (const value of [decision.goalMet, decision.stuck, decision.blocked]) {
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(1);
  }
  const offered = new Set(request.elements.map((element) => element.ref));
  for (const candidate of decision.candidates) {
    expect(offered.has(candidate.ref)).toBe(true);
    expect(["click", "fill", "type"]).toContain(candidate.kind);
  }

  const aborted = new AbortController();
  aborted.abort();
  const cancelled = await decider.decide(
    computer,
    { ...request, signal: aborted.signal },
    { ...context, signal: aborted.signal },
  );
  expect(cancelled.error).toBeTruthy();
  expect(cancelled.candidates).toEqual([]);
}

describe("page decider conformance", () => {
  it("holds for fake", async () => {
    await assertConformance(
      new FakePageDecider({
        decisions: [{ candidates: [{ ref: "e2", kind: "click", confidence: 0.9 }] }],
      }),
    );
  });

  it("reports a seeded error without throwing", async () => {
    const decision = await new FakePageDecider({ error: "seeded" }).decide(
      computer,
      request,
      context,
    );
    expect(decision).toMatchObject({ error: "seeded", candidates: [] });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/adapters/src/page-decider-conformance.test.ts`
Expected: FAIL — cannot resolve `./fake-page-decider.js`.

- [ ] **Step 3: Write the fake**

Create `packages/adapters/src/fake-page-decider.ts`:

```typescript
import type {
  AdapterContext,
  AdapterDescriptor,
  ComputerRef,
  PageDecider,
  PageDeciderCapabilities,
  PageDecision,
  PageDecisionRequest,
} from "@rakazo/adapter-kit";

export interface FakePageDeciderOptions {
  /** Returned in order; the last repeats once drained. */
  decisions?: ReadonlyArray<Partial<PageDecision>>;
  /** Reported on every call, with no candidates. */
  error?: string;
  /** Declare that this decider wants a screenshot. */
  vision?: boolean;
}

const EMPTY: PageDecision = { candidates: [], goalMet: 0, stuck: 0, blocked: 0 };

/** Replays seeded decisions so the policy and chain test offline. */
export class FakePageDecider implements PageDecider {
  readonly requests: PageDecisionRequest[] = [];
  private cursor = 0;

  constructor(private readonly options: FakePageDeciderOptions = {}) {}

  describe(): AdapterDescriptor<PageDeciderCapabilities> {
    return {
      id: "fake",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { vision: this.options.vision ?? false },
    };
  }

  async decide(
    _computer: ComputerRef,
    request: PageDecisionRequest,
    context: AdapterContext,
  ): Promise<PageDecision> {
    this.requests.push(request);
    if ((request.signal ?? context.signal).aborted) return { ...EMPTY, error: "cancelled" };
    if (this.options.error) return { ...EMPTY, error: this.options.error };
    const decisions = this.options.decisions ?? [];
    if (decisions.length === 0) return EMPTY;
    const next = decisions[Math.min(this.cursor++, decisions.length - 1)];
    return { ...EMPTY, ...next };
  }
}
```

- [ ] **Step 4: Verify, export, commit**

Run: `pnpm vitest run packages/adapters/src/page-decider-conformance.test.ts`
Expected: PASS.

Add `export * from "./fake-page-decider.js";` to `packages/adapters/src/index.ts`, then `pnpm --filter @rakazo/adapters check && pnpm lint`.

```bash
git add packages/adapters/src/fake-page-decider.ts packages/adapters/src/page-decider-conformance.test.ts packages/adapters/src/index.ts
git commit -m "feat(adapters): add a fake page decider and its conformance suite"
```

---

### Task 5: The `systemone` decider

Hosted Jev through the code the Auto Review Jev client already uses. The URL is fixed, as it is today: configurability only existed for a self-hosted Jev replacement, and the self-hosted path is now a model on the `local` provider, which owns its own URL. A fixed public endpoint needs no SSRF policy.

**Files:**
- Create: `packages/adapters/src/systemone-client.ts`, `packages/adapters/src/systemone-page-decider.ts`
- Modify: `packages/adapters/src/jev-auto-review.ts`, `packages/adapters/src/index.ts`, `packages/adapters/src/page-decider-conformance.test.ts`
- Test: `packages/adapters/src/systemone-page-decider.test.ts`

**Interfaces:**
- Produces: `postSystemOne(options): Promise<SystemOneResult>`, `systemOneRanking`, `systemOneNoul`, `SystemOnePageDecider({ apiKey, model?, timeoutMs?, fetch? })`.

`postSystemOne` returns a failure *kind*, not a message, so each caller keeps its own wording — which is what lets Auto Review's behavior stay byte-identical after the refactor. It passes `state` through untouched: the protocol takes a string, object or array, and converting would silently change what Auto Review sends.

- [ ] **Step 1: Write the failing tests**

Create `packages/adapters/src/systemone-page-decider.test.ts`:

```typescript
import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { SystemOnePageDecider } from "./systemone-page-decider.js";

const context: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};
const computer: ComputerRef = { id: "c1", botId: "b1", kind: "fake", providerRef: "c1" };
const request = {
  goal: "Press continue",
  elements: [
    { ref: "e1", role: "textbox", name: "Email", tag: "input" },
    { ref: "e2", role: "button", name: "Continue", tag: "button" },
  ],
  excerpt: "Signup",
  url: "https://example.test/form",
  title: "Signup",
  history: [],
};

const answers = (element: Record<string, unknown>) => ({
  model: "jev-latest",
  answers: {
    element: { type: "choice", ...element },
    goalMet: { type: "noul", noul: 0.05 },
    stuck: { type: "noul", noul: 0.02 },
    blocked: { type: "noul", noul: 0.01 },
  },
});

function decider(body: unknown, status = 200, capture?: (body: string) => void) {
  return new SystemOnePageDecider({
    apiKey: "test-key",
    fetch: async (_url, init) => {
      capture?.(String(init?.body ?? ""));
      return new Response(JSON.stringify(body), { status });
    },
  });
}

describe("SystemOnePageDecider", () => {
  // The whole ranking, not just the winner: the policy falls through to the
  // next candidate when the top one already failed to change the page.
  it("returns every option ranked by probability", async () => {
    const decision = await decider(
      answers({ choice: "e2", confidence: 0.7, probabilities: { e1: 0.3, e2: 0.7 } }),
    ).decide(computer, request, context);
    expect(decision.candidates).toEqual([
      { ref: "e2", kind: "click", confidence: 0.7, source: "list" },
      { ref: "e1", kind: "fill", confidence: 0.3, source: "list" },
    ]);
    expect(decision.goalMet).toBe(0.05);
  });

  it("drops an option naming an element it was not given", async () => {
    const decision = await decider(
      answers({ choice: "e9", confidence: 0.99, probabilities: { e9: 0.99 } }),
    ).decide(computer, request, context);
    expect(decision.candidates).toEqual([]);
  });

  it("reports an error on a non-OK status", async () => {
    const decision = await decider({}, 401).decide(computer, request, context);
    expect(decision.error).toBeTruthy();
    expect(decision.candidates).toEqual([]);
  });

  // Review Focus 4: a hung endpoint becomes an escalation, not a stuck run.
  it("reports an error when the request times out", async () => {
    const hung = new SystemOnePageDecider({
      apiKey: "test-key",
      timeoutMs: 5,
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    expect((await hung.decide(computer, request, context)).error).toBeTruthy();
  });

  it("never sends an element value", async () => {
    let sent = "";
    await decider(answers({ choice: "e1" }), 200, (body) => {
      sent = body;
    }).decide(
      computer,
      { ...request, elements: [{ ref: "e1", role: "textbox", name: "Password", value: "hunter2" }] },
      context,
    );
    expect(sent).not.toContain("hunter2");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/adapters/src/systemone-page-decider.test.ts`
Expected: FAIL — cannot resolve `./systemone-page-decider.js`.

- [ ] **Step 3: Extract the shared client**

Create `packages/adapters/src/systemone-client.ts`:

```typescript
import { z } from "zod";
import { readBodyCapped } from "./web-ssrf.js";

const SYSTEMONE_URL = "https://api.typesafe.ai/v1/systemone";
const MAX_RESPONSE_BYTES = 64_000;

/** Answer shapes from the published contract, discriminated on `type`. */
const answerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities: z.record(z.string(), z.number()).optional(),
    confidence: z.number().optional(),
  }),
  z.object({ type: z.literal("noul"), noul: z.number() }),
  z.object({
    type: z.literal("score"),
    score: z.number(),
    legend: z.record(z.string(), z.string()).optional(),
    confidence: z.number().optional(),
  }),
]);

const responseSchema = z.object({
  model: z.string().optional(),
  answers: z.record(z.string(), answerSchema),
});

export type SystemOneAnswers = z.infer<typeof responseSchema>["answers"];

/** A failure kind, not a message: each caller keeps its own wording. */
export type SystemOneResult =
  | { ok: true; answers: SystemOneAnswers; model?: string }
  | { ok: false; failure: "transport" | "invalid" }
  | { ok: false; failure: "status"; status: number };

export async function postSystemOne(options: {
  apiKey: string;
  model: string;
  /** Passed through untouched: the protocol accepts a string, object or array. */
  state: unknown;
  questions: Record<string, unknown>;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
}): Promise<SystemOneResult> {
  let response: Response;
  try {
    response = await options.fetchImpl(SYSTEMONE_URL, {
      method: "POST",
      redirect: "error",
      signal: options.signal,
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: options.model,
        state: options.state,
        questions: options.questions,
      }),
    });
  } catch {
    return { ok: false, failure: "transport" };
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    return { ok: false, failure: "status", status: response.status };
  }
  try {
    const bytes = await readBodyCapped(response, MAX_RESPONSE_BYTES, options.signal);
    const parsed = responseSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    if (!parsed.success) return { ok: false, failure: "invalid" };
    return { ok: true, answers: parsed.data.answers, model: parsed.data.model };
  } catch {
    return { ok: false, failure: "invalid" };
  }
}

/** Every scored option, best first, falling back to the winner alone. */
export function systemOneRanking(
  answers: SystemOneAnswers,
  key: string,
): Array<{ option: string; confidence: number }> {
  const answer = answers[key];
  if (answer?.type !== "choice") return [];
  const entries = Object.entries(answer.probabilities ?? {});
  if (entries.length === 0) return [{ option: answer.choice, confidence: answer.confidence ?? 0 }];
  return entries
    .map(([option, confidence]) => ({ option, confidence }))
    .sort((a, b) => b.confidence - a.confidence);
}

export function systemOneNoul(answers: SystemOneAnswers, key: string): number {
  const answer = answers[key];
  return answer?.type === "noul" ? answer.noul : 0;
}
```

- [ ] **Step 4: Move Auto Review onto it, behavior unchanged**

In `packages/adapters/src/jev-auto-review.ts`, delete `JEV_URL`, `MAX_JSON_BYTES`, `choiceAnswerSchema`, `jevResponseSchema` and the `readBodyCapped` import. Replace everything in `review()` from `let response: Response;` through `const model = body.data.model ? `jev/${body.data.model}` : modelLabel;` — the original `answer` and `model` lines included, since the replacement declares both — with:

```typescript
    const result = await postSystemOne({
      apiKey: this.apiKey,
      model: this.model,
      signal: boundedSignal,
      fetchImpl: this.fetchImpl,
      state: {
        toolName: request.toolName,
        connectorKind: request.connectorKind,
        args: boundArgs(request.args),
        userTask: truncate(request.userTask, MAX_TASK_CHARS),
        botDescription: truncate(request.botDescription, MAX_BOT_CHARS),
        matchingRules: request.matchingRules.map((rule) => ({
          effect: rule.effect,
          matchKind: rule.matchKind,
          matchValue: rule.matchValue,
        })),
      },
      questions: {
        decision: {
          type: "choice",
          instructions: "Should this bot tool call auto-pass or ask the user to approve?",
          criteria: {
            pass: "Clearly fits the user task and looks low risk",
            ask: "Unexpected, high risk, or outside the task. Ask the user",
          },
        },
      },
    });
    if (!result.ok) {
      if (result.failure === "status") {
        return errorResult(modelLabel, reasonForStatus(result.status));
      }
      return errorResult(
        modelLabel,
        result.failure === "transport" ? "Checker timed out or failed." : "Checker returned no decision.",
      );
    }
    const answer = result.answers.decision;
    if (answer?.type !== "choice") return errorResult(modelLabel, "Checker returned no decision.");
    const model = result.model ? `jev/${result.model}` : modelLabel;
```

The `ask` / `pass` / confidence branches after that stay exactly as they are.

Run: `pnpm vitest run packages/adapters/src/jev-auto-review.test.ts packages/adapters/src/auto-review.test.ts packages/adapters/src/auto-review-factory.test.ts`
Expected: PASS with no edits to those tests. Needing one means behavior changed — revert and redo.

- [ ] **Step 5: Write the decider**

Create `packages/adapters/src/systemone-page-decider.ts`:

```typescript
import type {
  AdapterContext,
  AdapterDescriptor,
  BrowserActKind,
  BrowserSnapshotNode,
  ComputerRef,
  PageDecider,
  PageDeciderCapabilities,
  PageDecision,
  PageDecisionRequest,
} from "@rakazo/adapter-kit";
import { DEFAULT_JEV_MODEL } from "./auto-review.js";
import { postSystemOne, systemOneNoul, systemOneRanking } from "./systemone-client.js";

const MAX_ELEMENTS = 240;
const MAX_EXCERPT_CHARS = 4_000;
const MAX_LABEL_CHARS = 120;

const EMPTY: PageDecision = { candidates: [], goalMet: 0, stuck: 0, blocked: 0 };

/**
 * The one description of an element that leaves the process. `value` is never
 * part of it — it can hold a typed secret and the decider has no use for it.
 */
function labelFor(element: BrowserSnapshotNode): string {
  const tag = element.tag ? ` <${element.tag}>` : "";
  return `${element.role}${tag}: ${element.name}`.slice(0, MAX_LABEL_CHARS);
}

/** Jev names an element; what to do with it follows from what it is. */
function kindFor(element: BrowserSnapshotNode): BrowserActKind {
  const role = element.role.toLowerCase();
  return role === "textbox" || role === "searchbox" || element.tag === "textarea" ? "fill" : "click";
}

/** Hosted Jev: one parallel pass answering which element, done, stuck, blocked. */
export class SystemOnePageDecider implements PageDecider {
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly options: {
      apiKey: string;
      model?: string;
      timeoutMs?: number;
      fetch?: typeof fetch;
    },
  ) {
    this.model = options.model?.trim() || DEFAULT_JEV_MODEL;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  describe(): AdapterDescriptor<PageDeciderCapabilities> {
    return { id: "systemone", contractVersion: "1", adapterVersion: "0.1.0", capabilities: { vision: false } };
  }

  async decide(
    _computer: ComputerRef,
    request: PageDecisionRequest,
    context: AdapterContext,
  ): Promise<PageDecision> {
    const caller = request.signal ?? context.signal;
    if (caller.aborted) return { ...EMPTY, error: "cancelled" };
    const elements = request.elements.slice(0, MAX_ELEMENTS);

    const result = await postSystemOne({
      apiKey: this.options.apiKey,
      model: this.model,
      signal: AbortSignal.any([caller, AbortSignal.timeout(this.timeoutMs)]),
      fetchImpl: this.fetchImpl,
      // The criteria already name every element, so the state does not repeat
      // them — sending both would double the payload on the hot path.
      state: {
        goal: request.goal,
        origin: new URL(request.url).origin,
        title: request.title,
        excerpt: request.excerpt.slice(0, MAX_EXCERPT_CHARS),
        history: request.history,
      },
      questions: {
        element: {
          type: "choice",
          instructions: "Which element should be acted on next to advance the goal?",
          criteria: Object.fromEntries(elements.map((element) => [element.ref, labelFor(element)])),
        },
        goalMet: { type: "noul", instructions: "Is the goal already satisfied on this page?" },
        stuck: { type: "noul", instructions: "Is there no listed element that can make progress?" },
        blocked: {
          type: "noul",
          instructions:
            "Is this page an interstitial needing a human, such as a bot check, two-factor prompt or payment confirmation?",
        },
      },
    });
    if (!result.ok) return { ...EMPTY, error: "The page decider did not answer." };

    const byRef = new Map(elements.map((element) => [element.ref, element]));
    return {
      candidates: systemOneRanking(result.answers, "element").flatMap(({ option, confidence }) => {
        const element = byRef.get(option);
        return element
          ? [{ ref: element.ref, kind: kindFor(element), confidence, source: "list" as const }]
          : [];
      }),
      goalMet: systemOneNoul(result.answers, "goalMet"),
      stuck: systemOneNoul(result.answers, "stuck"),
      blocked: systemOneNoul(result.answers, "blocked"),
    };
  }
}
```

- [ ] **Step 6: Conformance, verify, commit**

Add to the conformance file:

```typescript
import { SystemOnePageDecider } from "./systemone-page-decider.js";
```

```typescript
  it("holds for systemone", async () => {
    await assertConformance(
      new SystemOnePageDecider({
        apiKey: "test-key",
        fetch: async () =>
          new Response(
            JSON.stringify({
              answers: {
                element: { type: "choice", choice: "e2", confidence: 0.9, probabilities: { e2: 0.9 } },
                goalMet: { type: "noul", noul: 0 },
                stuck: { type: "noul", noul: 0 },
                blocked: { type: "noul", noul: 0 },
              },
            }),
            { status: 200 },
          ),
      }),
    );
  });
```

Run: `pnpm vitest run packages/adapters/src/systemone-page-decider.test.ts packages/adapters/src/page-decider-conformance.test.ts`
Expected: PASS.

Add `export * from "./systemone-client.js";` and `export * from "./systemone-page-decider.js";` to `packages/adapters/src/index.ts`; run `pnpm --filter @rakazo/adapters check && pnpm lint`.

```bash
git add packages/adapters/src/systemone-client.ts packages/adapters/src/systemone-page-decider.ts packages/adapters/src/systemone-page-decider.test.ts packages/adapters/src/jev-auto-review.ts packages/adapters/src/page-decider-conformance.test.ts packages/adapters/src/index.ts
git commit -m "feat(adapters): add the systemone page decider on shared Jev plumbing"
```

---

### Task 6: The `model` decider

Any connected model, run through the agent runtime exactly as Auto Review runs its checker. That reaches every model rakazo supports — Holo1.5-7B on the `local` provider, Haiku through Anthropic, anything through OpenRouter or the Cloudflare gateway — with credentials, OAuth and usage already handled. Whether it sees the page is a property of the chosen model, not a separate backend.

**Files:**
- Create: `packages/adapters/src/model-page-decider.ts`
- Modify: `packages/adapters/src/index.ts`, `packages/adapters/src/page-decider-conformance.test.ts`
- Test: `packages/adapters/src/model-page-decider.test.ts`

**Interfaces:**
- Consumes: `AgentRuntime`, `AgentRunRequest`, `AgentRuntimeEvent`.
- Produces: `ModelPageDecider({ runtime, model, sees, run, onUsage?, timeoutMs? })`, `elementAtPoint(elements, x, y)`.

Three choices, each the cheaper of two options:

- **Rects stay on our side.** The model is never shown them; it names a ref or points at an image pixel, and only our code maps the point back. Sending rects would enlarge every prompt and invite confusion between image pixels and CSS pixels.
- **No capture means list-only, not failure.** On a computer image without the capture, the model still has the element list, so it decides from that and simply cannot point.
- **Tests use a ten-line inline runtime.** `ScriptedAgentRuntime` picks its script from the prompt text, which the decider writes itself, so a test could not choose the answer.

- [ ] **Step 1: Write the failing tests**

Create `packages/adapters/src/model-page-decider.test.ts`:

```typescript
import type { AdapterContext, AgentRunRequest, AgentRuntime, ComputerRef } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { elementAtPoint, ModelPageDecider } from "./model-page-decider.js";

const context: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};
const computer: ComputerRef = { id: "c1", botId: "b1", kind: "fake", providerRef: "c1" };
const elements = [
  { ref: "e1", role: "group", name: "Card", rect: { x: 0, y: 0, width: 300, height: 200 } },
  { ref: "e2", role: "button", name: "Continue", rect: { x: 20, y: 150, width: 100, height: 30 } },
  { ref: "e3", role: "textbox", name: "Email", rect: { x: 20, y: 60, width: 200, height: 24 } },
];
const request = {
  goal: "Press continue",
  elements,
  excerpt: "Signup",
  url: "https://example.test/form",
  title: "Signup",
  history: [],
  screenshot: { data: "aGk=", mimeType: "image/png" as const, scale: 2 },
};

/** Answers every run with `text`, recording what it was asked. */
function runtime(text: string, seen: AgentRunRequest[] = []): AgentRuntime {
  return {
    describe: () => ({
      id: "test",
      contractVersion: "1",
      adapterVersion: "0",
      capabilities: { streaming: true, compaction: false, tools: false, scripted: true },
    }),
    async *run(runRequest) {
      seen.push(runRequest);
      yield { type: "done", text };
    },
    abort: async () => {},
  };
}

function decider(answer: unknown, sees = true, seen: AgentRunRequest[] = []) {
  return new ModelPageDecider({
    runtime: runtime(typeof answer === "string" ? answer : JSON.stringify(answer), seen),
    model: { provider: "local", id: "Hcompany/Holo1.5-7B" },
    sees,
    run: { runId: "r1", botId: "b1", threadId: "t1" },
  });
}

const empty = { candidates: [], goalMet: 0, stuck: 0, blocked: 0 };

describe("ModelPageDecider", () => {
  it("maps a list pick onto a decision", async () => {
    const decision = await decider({
      ...empty,
      candidates: [{ ref: "e2", kind: "click", confidence: 0.9 }],
    }).decide(computer, request, context);
    expect(decision.candidates).toEqual([{ ref: "e2", kind: "click", confidence: 0.9, source: "list" }]);
  });

  it("tolerates a fenced JSON answer", async () => {
    const decision = await decider(
      "```json\n" + JSON.stringify({ ...empty, goalMet: 0.9 }) + "\n```",
    ).decide(computer, request, context);
    expect(decision.goalMet).toBe(0.9);
  });

  // The point is in image pixels; scale 2 means it divides down to CSS pixels.
  it("maps a point through the capture's scale onto a ref", async () => {
    const decision = await decider({
      ...empty,
      point: { x: 120, y: 320, kind: "click", confidence: 0.8 },
    }).decide(computer, request, context);
    expect(decision.candidates).toEqual([{ ref: "e2", kind: "click", confidence: 0.8, source: "point" }]);
  });

  it("never lets a point override a named element", async () => {
    const decision = await decider({
      ...empty,
      candidates: [{ ref: "e3", kind: "fill", confidence: 0.9 }],
      point: { x: 120, y: 320, kind: "click", confidence: 0.99 },
    }).decide(computer, request, context);
    expect(decision.candidates).toEqual([{ ref: "e3", kind: "fill", confidence: 0.9, source: "list" }]);
  });

  it("sends the capture only to a model that can see", async () => {
    const seen: AgentRunRequest[] = [];
    await decider(empty, true, seen).decide(computer, request, context);
    await decider(empty, false, seen).decide(computer, request, context);
    expect(seen[0]?.images).toHaveLength(1);
    expect(seen[1]?.images).toBeUndefined();
  });

  // Review Focus 6: no capture means the list still works; a point is ignored.
  it("decides from the list when there is no capture", async () => {
    const { screenshot: _omit, ...noCapture } = request;
    const decision = await decider({
      ...empty,
      point: { x: 120, y: 320, kind: "click", confidence: 0.99 },
    }).decide(computer, noCapture, context);
    expect(decision.candidates).toEqual([]);
    expect(decision.error).toBeUndefined();
  });

  it("never shows the model a rect or an element value", async () => {
    const seen: AgentRunRequest[] = [];
    await decider(empty, true, seen).decide(
      computer,
      { ...request, elements: [{ ...elements[2]!, value: "hunter2" }] },
      context,
    );
    expect(seen[0]?.prompt).not.toContain("hunter2");
    expect(seen[0]?.prompt).not.toContain("rect");
  });

  it("reports an error on an unparseable answer", async () => {
    const decision = await decider("not json").decide(computer, request, context);
    expect(decision).toMatchObject({ candidates: [], error: expect.any(String) });
  });

  // Review Focus 4: a failing runtime is an escalation, not an exception.
  it("reports an error when the runtime throws", async () => {
    const failing = new ModelPageDecider({
      runtime: {
        ...runtime(""),
        async *run() {
          throw new Error("model unavailable");
        },
      },
      model: { provider: "local", id: "m" },
      sees: false,
      run: { runId: "r1", botId: "b1", threadId: "t1" },
    });
    expect((await failing.decide(computer, request, context)).error).toBeTruthy();
  });
});

describe("elementAtPoint", () => {
  // Elements nest; a point inside a button inside a card means the button.
  it("prefers the smallest containing element", () => {
    expect(elementAtPoint(elements, 60, 160)?.ref).toBe("e2");
  });

  // A point inside the card is contained by it, so snapping is tested on an
  // element nothing else surrounds.
  it("snaps to an element just outside the point", () => {
    const lone = [{ ref: "e3", role: "textbox", name: "Email", rect: { x: 20, y: 60, width: 200, height: 24 } }];
    expect(elementAtPoint(lone, 20, 55)?.ref).toBe("e3");
  });

  it("returns nothing far from every element", () => {
    expect(elementAtPoint(elements, 900, 900)).toBeUndefined();
  });

  // Review Focus 6: an older computer image reports no rects.
  it("returns nothing when no element has a rect", () => {
    expect(elementAtPoint([{ ref: "e1", role: "button", name: "Go" }], 10, 10)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/adapters/src/model-page-decider.test.ts`
Expected: FAIL — cannot resolve `./model-page-decider.js`.

- [ ] **Step 3: Write the decider**

Create `packages/adapters/src/model-page-decider.ts`:

```typescript
import type {
  AdapterContext,
  AdapterDescriptor,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  BrowserSnapshotNode,
  ComputerRef,
  PageDecider,
  PageDeciderCapabilities,
  PageDecision,
  PageDecisionCandidate,
  PageDecisionRequest,
} from "@rakazo/adapter-kit";
import { z } from "zod";

const MAX_ELEMENTS = 240;
const MAX_EXCERPT_CHARS = 4_000;
const POINT_TOLERANCE_PX = 12;
const EMPTY: PageDecision = { candidates: [], goalMet: 0, stuck: 0, blocked: 0 };

const kind = z.enum(["click", "fill", "type"]);
const answerSchema = z.object({
  candidates: z
    .array(z.object({ ref: z.string(), kind, confidence: z.number() }))
    .default([]),
  point: z.object({ x: z.number(), y: z.number(), kind, confidence: z.number() }).optional(),
  goalMet: z.number().default(0),
  stuck: z.number().default(0),
  blocked: z.number().default(0),
});

const INSTRUCTIONS = [
  "You choose the next action on a web page from a numbered list of elements.",
  "Output strict JSON only, no markdown: {candidates:[{ref,kind,confidence}],goalMet,stuck,blocked}.",
  "kind is click, fill or type. Never invent a ref and never write text to type.",
  "goalMet: probability the goal is already satisfied. stuck: probability no element can progress.",
  "blocked: probability this is an interstitial needing a human, such as a bot check,",
  "two-factor prompt or payment confirmation.",
].join(" ");

const POINT_INSTRUCTION =
  "If no listed element fits, you may instead set point:{x,y,kind,confidence} to the screenshot pixel you would click.";

const FAILURE = /^(?:I hit a problem:|Unknown model )/i;

/**
 * The smallest element containing the point, else the nearest within a few
 * pixels. Smallest first because elements nest: a point inside a button inside
 * a card means the button.
 */
export function elementAtPoint(
  elements: readonly BrowserSnapshotNode[],
  x: number,
  y: number,
): BrowserSnapshotNode | undefined {
  let best: { element: BrowserSnapshotNode; area: number; distance: number } | undefined;
  for (const element of elements) {
    const r = element.rect;
    if (!r) continue;
    const dx = Math.max(r.x - x, 0, x - (r.x + r.width));
    const dy = Math.max(r.y - y, 0, y - (r.y + r.height));
    const distance = Math.hypot(dx, dy);
    if (distance > POINT_TOLERANCE_PX) continue;
    const area = r.width * r.height;
    const better =
      !best || distance < best.distance || (distance === best.distance && area < best.area);
    if (better) best = { element, area, distance };
  }
  return best?.element;
}

/**
 * Any connected model, run like Auto Review's checker: no tools, no history,
 * JSON only. Coordinates never leave this class — a point is mapped to a ref
 * before the policy sees it.
 */
export class ModelPageDecider implements PageDecider {
  constructor(
    private readonly options: {
      runtime: AgentRuntime;
      model: AgentRunRequest["model"];
      /** Whether the model accepts images; decides if it gets the capture. */
      sees: boolean;
      run: { runId: string; botId: string; threadId: string };
      onUsage?: (event: Extract<AgentRuntimeEvent, { type: "usage" }>) => Promise<unknown>;
      timeoutMs?: number;
    },
  ) {}

  describe(): AdapterDescriptor<PageDeciderCapabilities> {
    return {
      id: "model",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { vision: this.options.sees },
    };
  }

  async decide(
    _computer: ComputerRef,
    request: PageDecisionRequest,
    context: AdapterContext,
  ): Promise<PageDecision> {
    const caller = request.signal ?? context.signal;
    if (caller.aborted) return { ...EMPTY, error: "cancelled" };
    const signal = AbortSignal.any([caller, AbortSignal.timeout(this.options.timeoutMs ?? 20_000)]);
    const elements = request.elements.slice(0, MAX_ELEMENTS);
    const capture = this.options.sees ? request.screenshot : undefined;
    const { runId, botId, threadId } = this.options.run;

    let text = "";
    try {
      for await (const event of this.options.runtime.run(
        {
          botId,
          threadId,
          runId: `${runId}:page-decider`,
          usageOperationKind: "setup",
          onUsage: async (usage) => {
            await this.options.onUsage?.(usage);
          },
          // Rects and values stay here: the model needs neither, and a value can
          // hold a typed secret.
          prompt: JSON.stringify({
            goal: request.goal,
            origin: new URL(request.url).origin,
            title: request.title,
            excerpt: request.excerpt.slice(0, MAX_EXCERPT_CHARS),
            elements: elements.map(({ ref, role, name, tag }) => ({ ref, role, name, tag })),
            history: request.history,
          }),
          instructions: capture ? `${INSTRUCTIONS} ${POINT_INSTRUCTION}` : INSTRUCTIONS,
          images: capture
            ? [{ name: "page.png", mimeType: "image/png", data: Buffer.from(capture.data, "base64") }]
            : undefined,
          history: [],
          tools: [],
          model: this.options.model,
        },
        { ...context, operationId: `page-decider:${runId}`, signal },
      )) {
        if (event.type === "usage" && !event.accounted) await this.options.onUsage?.(event);
        if (event.type === "done" && event.text && !FAILURE.test(event.text.trim())) {
          text = event.text.trim();
        }
      }
    } catch {
      return { ...EMPTY, error: "The page decider did not answer." };
    }

    let parsed: z.infer<typeof answerSchema>;
    try {
      const json = text.replace(/^```(?:json)?\s*|\s*```$/g, "");
      const result = answerSchema.safeParse(JSON.parse(json));
      if (!result.success) throw new Error("invalid");
      parsed = result.data;
    } catch {
      return { ...EMPTY, error: "The page decider returned no decision." };
    }

    const offered = new Set(elements.map((element) => element.ref));
    const candidates: PageDecisionCandidate[] = parsed.candidates
      .filter((candidate) => offered.has(candidate.ref))
      .map((candidate) => ({ ...candidate, source: "list" as const }));

    // A point only counts when the list gave nothing and the model saw the
    // page; it maps through the capture's scale onto a ref, or yields nothing.
    if (candidates.length === 0 && parsed.point && capture) {
      const hit = elementAtPoint(
        elements,
        parsed.point.x / capture.scale,
        parsed.point.y / capture.scale,
      );
      if (hit) {
        candidates.push({
          ref: hit.ref,
          kind: parsed.point.kind,
          confidence: parsed.point.confidence,
          source: "point",
        });
      }
    }

    return {
      candidates,
      goalMet: parsed.goalMet,
      stuck: parsed.stuck,
      blocked: parsed.blocked,
    };
  }
}
```

- [ ] **Step 4: Conformance, verify, commit**

Add to the conformance file:

```typescript
import { ModelPageDecider } from "./model-page-decider.js";
```

```typescript
  it("holds for model", async () => {
    await assertConformance(
      new ModelPageDecider({
        runtime: {
          describe: () => ({
            id: "test",
            contractVersion: "1",
            adapterVersion: "0",
            capabilities: { streaming: true, compaction: false, tools: false, scripted: true },
          }),
          async *run() {
            yield {
              type: "done",
              text: JSON.stringify({
                candidates: [{ ref: "e2", kind: "click", confidence: 0.9 }],
                goalMet: 0,
                stuck: 0,
                blocked: 0,
              }),
            };
          },
          abort: async () => {},
        },
        model: { provider: "local", id: "m" },
        sees: false,
        run: { runId: "r1", botId: "b1", threadId: "t1" },
      }),
    );
  });
```

Run: `pnpm vitest run packages/adapters/src/model-page-decider.test.ts packages/adapters/src/page-decider-conformance.test.ts`
Expected: PASS.

Add `export * from "./model-page-decider.js";` to `packages/adapters/src/index.ts`; run `pnpm --filter @rakazo/adapters check && pnpm lint`.

```bash
git add packages/adapters/src/model-page-decider.ts packages/adapters/src/model-page-decider.test.ts packages/adapters/src/page-decider-conformance.test.ts packages/adapters/src/index.ts
git commit -m "feat(adapters): add the model page decider"
```

---

### Task 7: A decider per bot

The bot gets two nullable columns that travel the same path as its model columns, consent treats the decider as one more `"model"` recipient, and one function builds the decider for a run.

**Files:**
- Create: `packages/adapters/src/page-decider-for-run.ts`
- Modify: `packages/db/prisma/schema.prisma`, `packages/db/src/repos.ts`, `packages/contracts/src/domain.ts`, `apps/api/src/router.ts`, `apps/api/src/ai-consent.ts`, `packages/adapters/src/index.ts`
- Test: `packages/adapters/src/page-decider-for-run.test.ts`

**Interfaces:**
- Consumes: `SystemOnePageDecider` (Task 5), `ModelPageDecider` (Task 6), `JEV_AUTO_REVIEW_PROVIDER`, `modelAcceptsImageInput`.
- Produces: `Bot.pageDeciderProvider`, `Bot.pageDeciderModel`, and `pageDeciderForRun(input): Promise<PageDecider | undefined>`. Task 8 calls it; Task 9 writes the columns.

Why each piece is the cheap one:

- **Bot only, no `Run` columns.** Nothing would write a per-run decider. Per-run model choice already exists through `modelPin`; carrying a decider on it is separate work.
- **Consent reuses `aiConsentStatus`.** It already collects every bot model, routine model, voice and cloud agent as recipients and prompts for any not yet allowed. The decider sends page content to a model, so it is the existing `"model"` use — the same one Auto Review's checker falls under — and needs no new disclosure copy. A private bot is never silently re-routed: the existing flow blocks rather than substitutes.
- **The model resolves through the run's own `resolveModel`**, the same path backup and helper models take, so the decider accepts exactly the models the picker can list.
- **A broken decider is not a broken run.** If its model can no longer be resolved, the run proceeds without it and logs why; this is an accelerator.

- [ ] **Step 1: Write the failing tests**

Create `packages/adapters/src/page-decider-for-run.test.ts`:

```typescript
import type { AgentRuntime } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { pageDeciderForRun } from "./page-decider-for-run.js";

const runtime = {} as AgentRuntime;
const run = { runId: "r1", botId: "b1", threadId: "t1" };
const resolveModel = async (provider: string, id: string) => ({ provider, id });

describe("pageDeciderForRun", () => {
  it("is off when the bot has no decider", async () => {
    expect(
      await pageDeciderForRun({ provider: null, modelId: null, resolveModel, runtime, run }),
    ).toBeUndefined();
  });

  it("builds the systemone decider for jev", async () => {
    const decider = await pageDeciderForRun({
      provider: "jev",
      modelId: "jev-latest",
      typesafeKey: "k",
      resolveModel,
      runtime,
      run,
    });
    expect(decider?.describe().id).toBe("systemone");
  });

  it("is off for jev when the deployment has no key", async () => {
    expect(
      await pageDeciderForRun({ provider: "jev", modelId: "jev-latest", resolveModel, runtime, run }),
    ).toBeUndefined();
  });

  it("builds a model decider through the run's resolver", async () => {
    const decider = await pageDeciderForRun({
      provider: "local",
      modelId: "Hcompany/Holo1.5-7B",
      resolveModel,
      runtime,
      run,
    });
    expect(decider?.describe().id).toBe("model");
  });

  it("gives a model the capture only when it accepts images", async () => {
    const seeing = await pageDeciderForRun({
      provider: "openai-compatible",
      modelId: "vision-model",
      resolveModel: async (provider, id) => ({ provider, id, acceptsImages: true }),
      runtime,
      run,
    });
    expect(seeing?.describe().capabilities.vision).toBe(true);
  });

  // An accelerator: a decider whose model went away must not fail the run.
  it("is off when the model can no longer be resolved", async () => {
    expect(
      await pageDeciderForRun({
        provider: "local",
        modelId: "gone",
        resolveModel: async () => {
          throw new Error("Connect that model provider first");
        },
        runtime,
        run,
      }),
    ).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/adapters/src/page-decider-for-run.test.ts`
Expected: FAIL — cannot resolve `./page-decider-for-run.js`.

- [ ] **Step 3: Write it**

Create `packages/adapters/src/page-decider-for-run.ts`:

```typescript
import type {
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  PageDecider,
} from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import { JEV_AUTO_REVIEW_PROVIDER } from "./auto-review.js";
import { ModelPageDecider } from "./model-page-decider.js";
import { modelAcceptsImageInput } from "./model-vision.js";
import { SystemOnePageDecider } from "./systemone-page-decider.js";

/**
 * The bot's decider for one run, or undefined to behave exactly as before.
 * Never throws: a decider that cannot be built is an accelerator lost, not a
 * run failed.
 */
export async function pageDeciderForRun(input: {
  provider: string | null;
  modelId: string | null;
  /** The run's own resolver, as used for backup and helper models. */
  resolveModel: (provider: string, modelId: string) => Promise<AgentRunRequest["model"]>;
  runtime: AgentRuntime;
  run: { runId: string; botId: string; threadId: string };
  typesafeKey?: string;
  onUsage?: (event: Extract<AgentRuntimeEvent, { type: "usage" }>) => Promise<unknown>;
}): Promise<PageDecider | undefined> {
  const { provider, modelId } = input;
  if (!provider || !modelId) return undefined;

  if (provider === JEV_AUTO_REVIEW_PROVIDER) {
    return input.typesafeKey
      ? new SystemOnePageDecider({ apiKey: input.typesafeKey, model: modelId })
      : undefined;
  }

  try {
    const model = await input.resolveModel(provider, modelId);
    return new ModelPageDecider({
      runtime: input.runtime,
      model,
      sees: modelAcceptsImageInput(model.provider, model.id, model.acceptsImages),
      run: input.run,
      onUsage: input.onUsage,
    });
  } catch (error) {
    // The repo logger takes the message first, then bindings.
    getLogger().warn("page decider unavailable for this run", {
      event: "page_decider.unavailable",
      provider,
      reason: (error as Error).message,
    });
    return undefined;
  }
}
```

- [ ] **Step 4: Verify**

Run: `pnpm vitest run packages/adapters/src/page-decider-for-run.test.ts`
Expected: PASS, six cases.

- [ ] **Step 5: Columns, end to end**

In `packages/db/prisma/schema.prisma`, in `model Bot`, after `modelId String?`:

```prisma
  pageDeciderProvider String?
  pageDeciderModel    String?
```

Run: `pnpm db:generate && pnpm db:migrate` and name the migration `page_decider`. Both columns are nullable with no default, so the migration is additive.

In `packages/contracts/src/domain.ts`, `BotSchema` (after `modelId`):

```typescript
  pageDeciderProvider: z.string().nullable(),
  pageDeciderModel: z.string().nullable(),
```

In the bot update schema (after `modelId`):

```typescript
    pageDeciderProvider: z.string().trim().min(1).max(80).nullable().optional(),
    pageDeciderModel: z.string().trim().min(1).max(200).nullable().optional(),
```

And in its `.superRefine`, after the existing model check:

```typescript
    const deciderProvider = value.pageDeciderProvider !== undefined && value.pageDeciderProvider !== null;
    const deciderModel = value.pageDeciderModel !== undefined && value.pageDeciderModel !== null;
    if (deciderProvider !== deciderModel) {
      ctx.addIssue({
        code: "custom",
        message: "Page decider provider and model must both be set or both cleared",
        path: ["pageDeciderModel"],
      });
    }
```

In `packages/db/src/repos.ts`, in the bot mapper beside `modelId: bot.modelId ?? null,`:

```typescript
    pageDeciderProvider: bot.pageDeciderProvider ?? null,
    pageDeciderModel: bot.pageDeciderModel ?? null,
```

`pnpm check` will name any other place that builds a `Bot` without these; add the same two lines at each.

In `apps/api/src/router.ts`, in the bot update data beside the model spread at line ~1761:

```typescript
            ...(input.pageDeciderProvider !== undefined
              ? {
                  pageDeciderProvider: input.pageDeciderProvider,
                  pageDeciderModel: input.pageDeciderModel ?? null,
                }
              : {}),
```

- [ ] **Step 6: Consent**

`aiConsentStatus` already pushes secondary models onto `selected` — backups, and the team-chat judge model — after which it de-duplicates them, resolves each connection's base URL, and adds one `"model"` recipient per model. The decider rides that same path, so its recipient gets the same base-URL binding as any other use of that connection.

In `apps/api/src/ai-consent.ts`, add `pageDeciderProvider: true, pageDeciderModel: true` to the bot `findMany` `select` (line ~66). Then, directly after the `teamChatJudgeProvider` block:

```typescript
    // A bot's page decider sees page content, so it is one more model recipient.
    for (const bot of bots) {
      if (!bot.pageDeciderProvider || !bot.pageDeciderModel) continue;
      selected.push({
        provider: bot.pageDeciderProvider,
        id: bot.pageDeciderModel,
        credential: await findModelCredential(
          deps.prisma,
          actor,
          bot.pageDeciderProvider,
          bot.pageDeciderModel,
        ),
        thinkingLevel: null,
      });
    }
```

In `apps/api/src/ai-consent.test.ts`, beside the backup-model case it mirrors:

```typescript
  it("discloses a bot's page decider as a model recipient until it is allowed", async () => {
    const { deps, actor } = setup();
    deps.env.agentRuntime = "pi";
    vi.mocked(deps.prisma.bot.findMany).mockResolvedValue([
      {
        modelProvider: null,
        modelId: null,
        thinkingLevel: null,
        pageDeciderProvider: "anthropic",
        pageDeciderModel: "claude-haiku-4-5",
      },
    ] as never);
    vi.mocked(deps.prisma.userModelCredential.findMany).mockResolvedValue([
      {
        id: "decider-credential",
        userId: actor.userId,
        provider: "anthropic",
        label: "fixture",
        secretId: "decider-secret",
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    ] as never);

    const status = await aiConsentStatus(deps, actor, { uses: ["model"] });

    expect(status.recipients).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Anthropic",
          detail: "claude-haiku-4-5",
          use: "model",
          allowed: false,
        }),
      ]),
    );
    expect(deps.prisma.bot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ pageDeciderProvider: true, pageDeciderModel: true }),
      }),
    );
  });
```

- [ ] **Step 7: Verify and commit**

Run: `pnpm --filter @rakazo/contracts check && pnpm --filter @rakazo/db check && pnpm --filter @rakazo/api check && pnpm vitest run apps/api/src packages/adapters/src/page-decider-for-run.test.ts && pnpm lint`
Expected: clean.

Add `export * from "./page-decider-for-run.js";` to `packages/adapters/src/index.ts`.

```bash
git add packages/adapters/src/page-decider-for-run.ts packages/adapters/src/page-decider-for-run.test.ts packages/adapters/src/index.ts packages/db/prisma packages/db/src/repos.ts packages/contracts/src/domain.ts apps/api/src/router.ts apps/api/src/ai-consent.ts apps/api/src/ai-consent.test.ts
git commit -m "feat: choose a page decider per bot"
```

---

### Task 8: The chain, the browser tools and the executor

**Files:**
- Create: `packages/adapters/src/page-decision-chain.ts`
- Modify: `packages/adapters/src/browser-tools.ts`, `packages/adapters/src/builtin-tools.ts`, `packages/adapters/src/executor.ts`, `packages/adapters/src/index.ts`
- Test: `packages/adapters/src/page-decision-chain.test.ts`

**Interfaces:**
- Consumes: `decidePageAction`, `DEFAULT_PAGE_DECISION_THRESHOLDS` (Task 2); `pageDeciderForRun` (Task 7).
- Produces: `runPageDecisionChain`, `normalizeGoal`, `decisionLogEvent`, and `decider` on the browser tools' options.

What the chain keeps from every review pass, and why:

- **The decider rides in an options object**, never a new positional argument, so no existing call site breaks.
- **Results keep their shape.** `browser_navigate` still answers `{ url, title }`; the chain only updates where it landed and adds fields.
- **Redaction stays outside the branch**, so a chain result cannot route around `redactConnectorPayload`.
- **`goalMetConfidence`, never `goalMet: true`.** The decider that scored it also chose the actions; the bot's model does the verifying.
- **`steps` and `acted` say what happened**, so the planner can see the path it just took. Both are absent when nothing was done.
- **Only clicks dispatch**, because the decider never supplies text; the policy filters for that so a `fill` at the top cannot hide a click below it.
- **The decider is built lazily**, once per run and only on the first call that carries a goal, so a run that never sends one pays nothing.

- [ ] **Step 1: Write the failing tests**

Create `packages/adapters/src/page-decision-chain.test.ts`:

```typescript
import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { browserActFromTool, browserNavigateFromTool } from "./browser-tools.js";
import { unchangedVisualStreakAfterPageBrowser } from "./computer-tools.js";
import { FakeBrowserProvider } from "./fake-browser.js";
import { FakePageDecider } from "./fake-page-decider.js";
import { decisionLogEvent, normalizeGoal, runPageDecisionChain } from "./page-decision-chain.js";

const context: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};
const computer: ComputerRef = { id: "c1", botId: "b1", kind: "fake", providerRef: "c1" };
const pages = {
  "https://example.test/form": {
    title: "Signup",
    html: `<!doctype html><html><head><title>Signup</title></head><body>
      <label>Email <input id="email" name="email" /></label>
      <button type="submit">Continue</button>
    </body></html>`,
  },
};

async function onForm() {
  const browser = new FakeBrowserProvider({ pages });
  await browser.navigate(computer, { url: "https://example.test/form" }, context);
  const snapshot = await browser.snapshot(computer, {}, context);
  const button = snapshot.elements.find((el) => /continue/i.test(el.name))!;
  return { browser, snapshot, button };
}

// Review Focus 5: anything unusable means "no goal", so nothing changes.
describe("normalizeGoal", () => {
  it.each([
    ["undefined", undefined],
    ["a number", 42],
    ["empty", ""],
    ["whitespace", "  \n\t "],
  ])("treats %s as absent", (_label, value) => {
    expect(normalizeGoal(value)).toBeUndefined();
  });

  it("trims and caps a usable goal", () => {
    expect(normalizeGoal("  go  ")).toBe("go");
    expect(normalizeGoal("x".repeat(10_000))).toHaveLength(400);
  });
});

describe("runPageDecisionChain", () => {
  it("clicks while confident and reports what it did", async () => {
    const { browser, snapshot, button } = await onForm();
    const result = await runPageDecisionChain({
      browser,
      decider: new FakePageDecider({
        decisions: [{ candidates: [{ ref: button.ref, kind: "click", confidence: 0.95 }] }, { goalMet: 0.99 }],
      }),
      computer,
      context,
      goal: "press continue",
      snapshot,
    });
    expect(result).toMatchObject({ outcome: "done", steps: 1, acted: ["Continue"], goalMetConfidence: 0.99 });
  });

  it("escalates without acting when unsure", async () => {
    const { browser, snapshot, button } = await onForm();
    const result = await runPageDecisionChain({
      browser,
      decider: new FakePageDecider({
        decisions: [{ candidates: [{ ref: button.ref, kind: "click", confidence: 0.1 }] }],
      }),
      computer,
      context,
      goal: "press continue",
      snapshot,
    });
    expect(result).toMatchObject({ outcome: "escalate", steps: 0 });
  });

  it("hands an interstitial to takeover", async () => {
    const { browser, snapshot } = await onForm();
    const result = await runPageDecisionChain({
      browser,
      decider: new FakePageDecider({ decisions: [{ blocked: 0.95 }] }),
      computer,
      context,
      goal: "read it",
      snapshot,
    });
    expect(result.outcome).toBe("takeover");
  });

  // Review Focus 4: an uncertain action may already have happened. Stop.
  it("stops instead of replaying an uncertain action", async () => {
    const { browser, snapshot, button } = await onForm();
    const act = browser.act.bind(browser);
    browser.act = async (...args) => ({ ...(await act(...args)), uncertain: true });
    const decider = new FakePageDecider({
      decisions: [{ candidates: [{ ref: button.ref, kind: "click", confidence: 0.99 }] }],
    });
    const result = await runPageDecisionChain({
      browser,
      decider,
      computer,
      context,
      goal: "press continue",
      snapshot,
    });
    expect(result).toMatchObject({ outcome: "escalate", uncertain: true });
    expect(decider.requests).toHaveLength(1);
  });

  it("captures the viewport only for a decider that sees", async () => {
    const { browser, snapshot } = await onForm();
    const text = new FakePageDecider({ decisions: [{ goalMet: 0.99 }] });
    const vision = new FakePageDecider({ decisions: [{ goalMet: 0.99 }], vision: true });
    for (const decider of [text, vision]) {
      await runPageDecisionChain({ browser, decider, computer, context, goal: "go", snapshot });
    }
    expect(text.requests[0]?.screenshot).toBeUndefined();
    expect(vision.requests[0]?.screenshot).toMatchObject({ mimeType: "image/png", scale: 1 });
  });

  // Review Focus 6: no capture means no pixels, not a failure.
  it("runs a seeing decider without pixels on an older computer image", async () => {
    const { browser, snapshot } = await onForm();
    browser.noScreenshot = true;
    const vision = new FakePageDecider({ decisions: [{ goalMet: 0.99 }], vision: true });
    const result = await runPageDecisionChain({ browser, decider: vision, computer, context, goal: "go", snapshot });
    expect(result.outcome).toBe("done");
    expect(vision.requests[0]?.screenshot).toBeUndefined();
  });
});

describe("decisionLogEvent", () => {
  it("records scores and origin, never page content", () => {
    const event = decisionLogEvent(
      { outcome: "done", steps: 1, acted: ["Continue"], snapshot: { url: "https://example.test/form?q=secret", title: "Signup", tree: "Email", elements: [] } },
      { candidates: [{ ref: "e2", kind: "click", confidence: 0.9 }], goalMet: 0.99, stuck: 0, blocked: 0 },
    );
    const serialized = JSON.stringify(event);
    expect(serialized).toContain("https://example.test");
    expect(serialized).toContain("0.99");
    for (const leak of ["/form", "secret", "Continue", "Signup", "Email"]) {
      expect(serialized).not.toContain(leak);
    }
  });
});

describe("browser tool integration", () => {
  it("returns exactly the old result when no goal is given", async () => {
    const decider = new FakePageDecider({ decisions: [{ goalMet: 0.99 }] });
    const browser = new FakeBrowserProvider({ pages });
    const url = { url: "https://example.test/form" };
    expect(await browserNavigateFromTool(browser, computer, context, url, { decider })).toEqual(
      await browserNavigateFromTool(browser, computer, context, url),
    );
    expect(decider.requests).toHaveLength(0);
  });

  it("keeps browser_navigate's shape and reports a claim, not a verdict", async () => {
    const result = await browserNavigateFromTool(
      new FakeBrowserProvider({ pages }),
      computer,
      context,
      { url: "https://example.test/form", goal: "sign up" },
      { decider: new FakePageDecider({ decisions: [{ goalMet: 0.99 }] }) },
    );
    expect(result).toMatchObject({ goalMetConfidence: 0.99 });
    for (const key of ["tree", "elements", "goalMet", "steps", "acted"]) {
      expect(result).not.toHaveProperty(key);
    }
  });

  it("still redacts when a chain runs", async () => {
    const { browser, button } = await onForm();
    const result = await browserActFromTool(
      browser,
      computer,
      context,
      { actions: [{ kind: "click", ref: button.ref }], goal: "press continue" },
      { decider: new FakePageDecider({ decisions: [{ goalMet: 0.99 }] }), redactions: () => ["Signup"] },
    );
    expect(JSON.stringify(result)).not.toContain("Signup");
  });

  // A successful browser mutation clears the desktop visual-loop streak, and
  // that reset reads `error`, `fallback` and `ok`. A chain must not disturb them.
  it("keeps the desktop loop guard's reset on success and failure", async () => {
    const { browser, button } = await onForm();
    const decider = () =>
      new FakePageDecider({
        decisions: [{ candidates: [{ ref: button.ref, kind: "click", confidence: 0.95 }] }, { goalMet: 0.99 }],
      });
    const streak = { frameId: "f", actionKey: "k", count: 3 };
    const ok = await browserActFromTool(
      browser,
      computer,
      context,
      { actions: [{ kind: "click", ref: button.ref }], goal: "go" },
      { decider: decider() },
    );
    expect(unchangedVisualStreakAfterPageBrowser(streak, "browser_act", ok).count).toBe(0);

    browser.actError = new Error("click failed");
    const failed = await browserActFromTool(
      browser,
      computer,
      context,
      { actions: [{ kind: "click", ref: button.ref }], goal: "go" },
      { decider: decider() },
    );
    expect(unchangedVisualStreakAfterPageBrowser(streak, "browser_act", failed).count).toBe(3);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/adapters/src/page-decision-chain.test.ts`
Expected: FAIL — cannot resolve `./page-decision-chain.js`.

- [ ] **Step 3: Write the chain**

Create `packages/adapters/src/page-decision-chain.ts`:

```typescript
import type {
  AdapterContext,
  BrowserProvider,
  BrowserSnapshotResult,
  ComputerRef,
  PageDecider,
  PageDecision,
  PageDecisionAttempt,
  PageDecisionRequest,
} from "@rakazo/adapter-kit";
import { DEFAULT_PAGE_DECISION_THRESHOLDS, decidePageAction } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";

const MAX_GOAL_CHARS = 400;
const MAX_EXCERPT_CHARS = 4_000;

/** Unusable goal means no goal: the decider never runs. */
export function normalizeGoal(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_GOAL_CHARS) : undefined;
}

export interface PageDecisionChainResult {
  outcome: "done" | "escalate" | "takeover" | "refuse";
  reason?: string;
  steps: number;
  /** Names of the elements clicked, in order — what changed, for the model to check. */
  acted: string[];
  /** The decider's own estimate. A claim for the model to verify, never a verdict. */
  goalMetConfidence?: number;
  /** An action may have taken effect before its result was lost. */
  uncertain?: boolean;
  snapshot: BrowserSnapshotResult;
}

/** What a decision may record: scores and origin, never page content. */
export function decisionLogEvent(
  result: Omit<PageDecisionChainResult, "acted"> & { acted?: string[] },
  decision: PageDecision,
) {
  return {
    event: "page_decider.decision",
    outcome: result.outcome,
    reason: result.reason,
    steps: result.steps,
    origin: result.snapshot.url ? new URL(result.snapshot.url).origin : undefined,
    goalMet: decision.goalMet,
    stuck: decision.stuck,
    blocked: decision.blocked,
    topConfidence: decision.candidates[0]?.confidence ?? null,
  };
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
    return shot.fallback || !shot.data ? undefined : { data: shot.data, mimeType: "image/png", scale: shot.scale };
  } catch {
    return undefined;
  }
}

/**
 * Run confident clicks back to back, stopping the moment the policy is unsure.
 * Every stop lands in behavior that existed before, so the worst case is the
 * previous loop plus one decision.
 */
export async function runPageDecisionChain(input: {
  browser: BrowserProvider;
  decider: PageDecider;
  computer: ComputerRef;
  context: AdapterContext;
  goal: string;
  snapshot: BrowserSnapshotResult;
  now?: () => number;
}): Promise<PageDecisionChainResult> {
  const { browser, decider, computer, context, goal } = input;
  const clock = input.now ?? Date.now;
  const started = clock();
  const sees = decider.describe().capabilities.vision;
  const history: PageDecisionAttempt[] = [];
  const acted: string[] = [];
  let snapshot = input.snapshot;

  for (;;) {
    const decision = await decider.decide(
      computer,
      {
        goal,
        elements: snapshot.elements,
        excerpt: snapshot.tree.slice(0, MAX_EXCERPT_CHARS),
        url: snapshot.url,
        title: snapshot.title,
        history,
        screenshot: sees ? await capture(browser, computer, context) : undefined,
        signal: context.signal,
      },
      context,
    );

    // The decider speaks refs; the policy speaks opaque targets, which is what
    // lets a desktop chain reuse it later. The adaptation is these maps.
    const outcome = decidePageAction({
      decision: {
        ...decision,
        candidates: decision.candidates.map((c) => ({ target: c.ref, kind: c.kind, confidence: c.confidence })),
      },
      budget: { steps: acted.length, elapsedMs: clock() - started },
      history: history.map((a) => ({ target: a.ref, kind: a.kind, changed: a.changed })),
      knownTargets: snapshot.elements.map((element) => element.ref),
      dispatchableKinds: ["click"],
      thresholds: DEFAULT_PAGE_DECISION_THRESHOLDS,
    });

    const stop = (result: Omit<PageDecisionChainResult, "steps" | "acted" | "snapshot">) => {
      const full = { ...result, steps: acted.length, acted, snapshot };
      getLogger().info("page decider stopped", decisionLogEvent(full, decision));
      return full;
    };

    if (outcome.action === "done") return stop({ outcome: "done", goalMetConfidence: decision.goalMet });
    if (outcome.action !== "act") return stop({ outcome: outcome.action, reason: outcome.reason });

    const name = snapshot.elements.find((element) => element.ref === outcome.target)?.name ?? "";
    const before = snapshot.url + snapshot.tree;
    const result = await browser.act(
      computer,
      { actions: [{ kind: "click", ref: outcome.target }], signal: context.signal },
      context,
    );
    if (result.uncertain) {
      acted.push(name || outcome.target);
      return stop({ outcome: "escalate", reason: "uncertain", uncertain: true });
    }
    if (!result.ok || result.fallback) return stop({ outcome: "escalate", reason: "act_failed" });

    acted.push(name || outcome.target);
    snapshot = {
      url: result.url,
      title: result.title,
      tree: result.tree ?? snapshot.tree,
      elements: result.elements ?? snapshot.elements,
    };
    history.push({ ref: outcome.target, kind: "click", changed: before !== snapshot.url + snapshot.tree });
  }
}
```

- [ ] **Step 4: Wire the tools**

In `packages/adapters/src/browser-tools.ts`, add the imports:

```typescript
import type { PageDecider } from "@rakazo/adapter-kit";
import type { PageDecisionChainResult } from "./page-decision-chain.js";
import { normalizeGoal, runPageDecisionChain } from "./page-decision-chain.js";
```

Append an options parameter to `browserNavigateFromTool` — appended, never inserted:

```typescript
  options: { decider?: PageDecider } = {},
```

and add `decider?: PageDecider;` to `browserActFromTool`'s existing options type. Add two helpers:

```typescript
/** Runs the chain when a goal and a decider are both present; otherwise undefined. */
async function chainForGoal(
  browser: BrowserProvider,
  computer: ComputerRef,
  context: AdapterContext,
  args: Record<string, unknown>,
  decider: PageDecider | undefined,
): Promise<PageDecisionChainResult | undefined> {
  const goal = normalizeGoal(args.goal);
  if (!goal || !decider) return undefined;
  const snapshot = await browser.snapshot(computer, { signal: context.signal }, context);
  if (snapshot.fallback || snapshot.error) return undefined;
  return await runPageDecisionChain({ browser, decider, computer, context, goal, snapshot });
}

/**
 * The calling tool's own result, moved to where the chain landed, plus at most
 * a claim and an account. Never the snapshot: that would widen a tool contract
 * the model already relies on.
 */
function withChain<T extends { fallback?: "computer_act"; error?: string }>(
  base: T,
  chain: PageDecisionChainResult,
) {
  const account = chain.acted.length > 0 ? { steps: chain.steps, acted: chain.acted } : {};
  return formatBrowserResult({
    ...base,
    url: chain.snapshot.url,
    title: chain.snapshot.title,
    ...account,
    ...(chain.outcome === "takeover" ? { takeover: true, reason: chain.reason } : {}),
    ...(chain.outcome === "done" ? { goalMetConfidence: chain.goalMetConfidence } : {}),
    ...(chain.uncertain ? { uncertain: true } : {}),
  });
}
```

In `browserNavigateFromTool`, replace `return formatBrowserResult(result);` with:

```typescript
    const chain = await chainForGoal(browser, computer, context, args, options.decider);
    return chain ? withChain(result, chain) : formatBrowserResult(result);
```

In `browserActFromTool`, replace `return redactConnectorPayload(formatBrowserResult(result), options.redactions?.() ?? []);` with:

```typescript
    const chain = await chainForGoal(browser, computer, context, args, options.decider);
    return redactConnectorPayload(
      chain ? withChain(result, chain) : formatBrowserResult(result),
      options.redactions?.() ?? [],
    );
```

In `packages/adapters/src/builtin-tools.ts`, add to both `browser_navigate`'s and `browser_act`'s `inputSchema.properties`:

```typescript
        goal: {
          type: "string",
          description:
            "Optional. What to accomplish on this page, so simple steps run without a screenshot. The result reports the steps taken and a goalMetConfidence to check against the page.",
        },
```

`required` stays unchanged.

- [ ] **Step 5: Wire the executor**

In `packages/adapters/src/executor.ts`, directly after the `Promise.all` that loads `bot` and `thread` (~line 3379), build the decider lazily:

```typescript
        // Built on the first browser call that carries a goal, at most once per
        // run, so a run that never sends one resolves nothing.
        let pageDecider: Promise<PageDecider | undefined> | undefined;
        const pageDeciderOnce = () =>
          (pageDecider ??= pageDeciderForRun({
            provider: bot.pageDeciderProvider,
            modelId: bot.pageDeciderModel,
            resolveModel: (provider, modelId) =>
              resolveConnectedModel(run, provider, modelId, (values) => runSecrets.push(...values)),
            runtime: deps.runtime,
            run: { runId, botId: bot.id, threadId: thread.id },
            typesafeKey: typesafeApiKey(),
            onUsage: (event) =>
              recordUsage(deps.prisma, event, {
                spaceId: run.spaceId,
                userId: run.userId,
                botId: bot.id,
                parentRunId: runId,
                runId,
                operationId: `page-decider:${runId}`,
                operationKind: "setup",
              }),
          }));
```

At the browser dispatch (~line 5206), three small edits. First, directly before `return computerScreenToolResult(async () => {`:

```typescript
            // Resolved only when this call carries a goal.
            const decider = normalizeGoal(args.goal) ? await pageDeciderOnce() : undefined;
```

Second, replace

```typescript
                ? redactConnectorPayload(await tool(browser, computer, context, args), redactions())
```

with — `tool` is navigate or snapshot here, and only navigate takes the decider:

```typescript
                ? redactConnectorPayload(
                    await (name === "browser_navigate"
                      ? browserNavigateFromTool(browser, computer, context, args, { decider })
                      : tool(browser, computer, context, args)),
                    redactions(),
                  )
```

Third, in the `browserActFromTool(browser, computer, context, args, {` options that follow, add `decider,` on the line after `redactions,`. Nothing else in that call changes. Add the imports: `import type { PageDecider } from "@rakazo/adapter-kit";`, `pageDeciderForRun` from `./page-decider-for-run.js`, `normalizeGoal` from `./page-decision-chain.js`, and `typesafeApiKey` from `./auto-review.js` if not already imported.

- [ ] **Step 6: Verify**

Run: `pnpm vitest run packages/adapters/src/page-decision-chain.test.ts`
Expected: PASS.

Run: `pnpm vitest run packages/adapters/src/browser-tools.test.ts packages/adapters/src/browser-conformance.test.ts packages/adapters/src/page-browser-login-fill.test.ts packages/adapters/src/executor.test.ts packages/adapters/src/computer-tools.test.ts`
Expected: PASS with no edits. No existing call passes a goal, so every existing path is unchanged.

- [ ] **Step 7: Commit**

Add `export * from "./page-decision-chain.js";` to `packages/adapters/src/index.ts`; run `pnpm --filter @rakazo/adapters check && pnpm lint`.

```bash
git add packages/adapters/src/page-decision-chain.ts packages/adapters/src/page-decision-chain.test.ts packages/adapters/src/browser-tools.ts packages/adapters/src/builtin-tools.ts packages/adapters/src/executor.ts packages/adapters/src/index.ts
git commit -m "feat(adapters): run confident browser steps through the page decider"
```

---

### Task 9: The picker

One select directly under the bot's existing model select. That select already lives inside the bot panel's **Advanced** `<details>` (`bot-panel.tsx:542–721`), so the decider inherits native progressive disclosure with no new state: most people never open Advanced and never see it. Its options are the same `connectedOptions` the model select lists, plus Jev when the deployment can run it.

**Files:**
- Modify: `apps/web/src/pages/shell/bot-panel.tsx`, `packages/contracts/src/domain.ts`, `apps/api/src/env.ts`, `apps/api/src/router.ts`
- Test: `apps/web/src/pages/shell/bot-settings.test.tsx`

**Interfaces:**
- Consumes: `Bot.pageDeciderProvider` / `pageDeciderModel` (Task 7).
- Produces: `Me.jevAvailable`.

The web cannot know whether `TYPESAFE_API_KEY` is set, and listing Jev where it cannot run would be an option that silently does nothing. `jevAvailable` follows the existing `ticketBoardEnabled` flag exactly and reads the existing key, so no environment variable is added.

- [ ] **Step 1: Tell the web whether Jev is available**

In `packages/contracts/src/domain.ts`, `MeSchema`, after `ticketBoardEnabled`:

```typescript
  /** Whether this deployment can run the Jev page decider. */
  jevAvailable: z.boolean(),
```

In `apps/api/src/env.ts`, beside `ticketBoardEnabled` in the type and in the builder:

```typescript
  jevAvailable: boolean;
```

```typescript
    jevAvailable: Boolean(typesafeApiKey(source)),
```

importing `typesafeApiKey` from `@rakazo/adapters`. In `apps/api/src/router.ts`'s `me` builder, beside `ticketBoardEnabled`:

```typescript
    jevAvailable: deps.env.jevAvailable === true,
```

`pnpm check` names any other place that builds a `Me`; add `jevAvailable: false` there.

- [ ] **Step 2: Write the failing tests**

In `apps/web/src/pages/shell/bot-settings.test.tsx`, import the mocked client and widen the local patch type:

```typescript
import { rpc } from "../../lib/rpc";
```

```typescript
type SavePatch = {
  disabledBuiltinTools?: string[];
  pageDeciderProvider?: string | null;
  pageDeciderModel?: string | null;
};
```

Then add, using the file's own `renderSettings`, `container` and `flush`:

```typescript
describe("BotSettings page decider", () => {
  const decider = () => container.querySelector<HTMLSelectElement>('[id$="-page-decider"]');
  const option = (label: string) =>
    [...(decider()?.options ?? [])].find((candidate) => candidate.textContent === label);

  async function save() {
    const button = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Save",
    );
    if (!button) throw new Error("Missing save button");
    await act(async () => {
      button.click();
    });
    await flush();
  }

  it("sits inside Advanced and is off by default", async () => {
    await renderSettings(vi.fn(async () => undefined));
    expect(decider()?.closest("details")).not.toBeNull();
    expect(decider()?.value).toBe("");
  });

  it("offers Jev only when the deployment can run it", async () => {
    await renderSettings(vi.fn(async () => undefined));
    expect(option("Jev")).toBeUndefined();

    vi.mocked(rpc.me).mockResolvedValueOnce({ jevAvailable: true } as never);
    await renderSettings(vi.fn(async () => undefined));
    expect(option("Jev")).toBeDefined();
  });

  it("saves the chosen decider, and clears it when turned off", async () => {
    vi.mocked(rpc.me).mockResolvedValueOnce({ jevAvailable: true } as never);
    const onSave = vi.fn<(patch: SavePatch) => Promise<void>>(async () => undefined);
    await renderSettings(onSave);

    await act(async () => {
      decider()!.value = option("Jev")!.value;
      decider()!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await save();
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      pageDeciderProvider: "jev",
      pageDeciderModel: "jev-latest",
    });

    await act(async () => {
      decider()!.value = "";
      decider()!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await save();
    expect(onSave.mock.calls[1]?.[0]).toMatchObject({
      pageDeciderProvider: null,
      pageDeciderModel: null,
    });
  });

  // A decider chosen earlier stays visible even if it is no longer offered.
  it("keeps showing a saved decider that is no longer offered", async () => {
    await renderSettings(vi.fn(async () => undefined), {
      ...bot,
      pageDeciderProvider: "jev",
      pageDeciderModel: "jev-latest",
    });
    expect(decider()?.selectedOptions[0]?.textContent).toBe("Jev");
  });
});
```

Run: `pnpm vitest run apps/web/src/pages/shell/bot-settings.test.tsx`
Expected: FAIL — no element with an id ending `-page-decider`.

- [ ] **Step 3: Add the select**

In `apps/web/src/pages/shell/bot-panel.tsx`, beside the `modelKey` state:

```typescript
  const jevKey = modelOptionKey("jev", "jev-latest");
  const [deciderKey, setDeciderKey] = useState(
    bot.pageDeciderProvider && bot.pageDeciderModel
      ? modelOptionKey(bot.pageDeciderProvider, bot.pageDeciderModel)
      : "",
  );
```

Directly after the thinking-level select that follows the model select, mirroring the model select's markup — including its "current value no longer offered" fallback:

```tsx
        <label htmlFor={`${ids}-page-decider`} className={fieldLabelClass}>
          <Trans>Page decider</Trans>
          <NativeSelect
            id={`${ids}-page-decider`}
            className="mt-2 w-full"
            value={deciderKey}
            onChange={(event) => setDeciderKey(event.target.value)}
          >
            <NativeSelectOption value="">{t`Off`}</NativeSelectOption>
            {me?.jevAvailable || deciderKey === jevKey ? (
              <NativeSelectOption value={jevKey}>Jev</NativeSelectOption>
            ) : null}
            {deciderKey &&
            deciderKey !== jevKey &&
            !connectedOptions.some((option) => option.key === deciderKey) ? (
              <NativeSelectOption value={deciderKey}>
                {bot.pageDeciderModel ?? deciderKey}
              </NativeSelectOption>
            ) : null}
            {connectedOptions.map((option) => (
              <NativeSelectOption key={option.key} value={option.key}>
                {option.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
```

In the save patch, beside `modelProvider` / `modelId`. A saved decider that is no longer offered resolves to no change rather than being cleared:

```typescript
        ...(deciderKey === ""
          ? { pageDeciderProvider: null, pageDeciderModel: null }
          : deciderKey === jevKey
            ? { pageDeciderProvider: "jev", pageDeciderModel: "jev-latest" }
            : (() => {
                const option = connectedOptions.find((candidate) => candidate.key === deciderKey);
                return option
                  ? { pageDeciderProvider: option.provider, pageDeciderModel: option.modelId }
                  : {};
              })()),
```

`Jev` is a product name and is not translated. The two translated strings are `Page decider` and `Off`.

- [ ] **Step 4: Verify**

Run: `pnpm vitest run apps/web/src/pages/shell/bot-settings.test.tsx && pnpm --filter @rakazo/web check && pnpm lint`
Expected: PASS, clean.

Make sure a web E2E test opens the bot panel's Advanced section, so CI's screenshot shows the select and can be linked on the PR as `AGENTS.md` requires. If none does, add one that opens it.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/shell/bot-panel.tsx apps/web/src/pages/shell/bot-settings.test.tsx packages/contracts/src/domain.ts apps/api/src/env.ts apps/api/src/router.ts
git commit -m "feat(web): choose a bot's page decider under Advanced"
```

---

## Final verification

- [ ] `pnpm lint && pnpm check && pnpm test` — clean.
- [ ] `pnpm vitest run packages/adapters/src/page-decider-conformance.test.ts` — fake, systemone and model all conform.
- [ ] A goal-less `browser_navigate` and `browser_act` return byte-identical results with and without a decider (Task 8's first integration test).
- [ ] `git log` — one commit per task; no secrets, local paths or personal data.
- [ ] PR description: why, what, how tested. Quote the new copy — `Page decider` and `Off` — and say why each is needed: the label names the control and `Off` is the honest default; neither could be removed without leaving an unlabeled select. Link the CI screenshot of the Advanced section. Note that E2E-hosted providers on older computer images run the decider on the element list only until their images carry the updated helper, and that the spec's call-reduction and latency targets are measured on real traffic, not in this change.
