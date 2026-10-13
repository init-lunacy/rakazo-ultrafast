# Page Decider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a provider-neutral `page-decider` adapter slot that answers the browser loop's per-step questions (which element, done yet, stuck yet) with a fast model, escalating to today's screenshot-and-frontier-model path whenever it is not confident.

**Architecture:** A new adapter interface beside `BrowserProvider`, three adapters (`model`, `systemone`, `fake`), and a pure policy function in `@rakazo/core` that turns a decision plus a budget into one of five outcomes. The decider is selected per bot and per run through the same columns and credential scoping as the main model. Every outcome except a confident pick lands in behavior that exists today, so the accuracy floor is structural.

**Tech Stack:** TypeScript (ES modules, `import type` top-level only), pnpm workspaces, Turbo, Vitest, Prisma/Postgres, Zod, Biome. React with shadcn/ui on Base UI from `packages/ui-web` for the one settings control.

**Spec:** `docs/superpowers/specs/2026-10-12-page-decider-design.md` — read it before Task 1. The plan argues from the spec; where this plan says "per the spec", the spec is the authority.

## Global Constraints

Exact values, copied from the spec and `AGENTS.md`. Every task's requirements implicitly include this section.

- Use top-level `import type`, never inline type imports. Reserve dynamic `import()` for necessary deferred loading.
- Never add a provider- or model-specific environment variable when the generic connection can express the behavior. Hosted and self-hosted `systemone` differ only by `baseUrl` and key.
- Tests are deterministic and offline by default. No test may reach the network.
- The snapshot element cap is 240, set by the System One protocol's 255-option ceiling so any element can always be offered as a choice. Element rects are CSS pixels relative to the viewport, matching a CDP viewport capture; never the desktop screenshot's device-pixel space.
- The decider never produces or receives text to type, and never receives a screenshot. It returns a ref and a kind only.
- Confidence thresholds live in code as configuration with documented defaults, never as magic numbers inline at a call site: `goalMet` 0.85, `stuck` 0.85, `blocked` 0.85, candidate confidence 0.70, step budget 24, time budget 180000ms.
- `systemone` request `state` is capped at 20000 characters; total JSON body capped at 64000 bytes, matching `MAX_JSON_BYTES` in `jev-auto-review.ts`.
- Logs record outcome, reason and scores. Logs never record page text, element names, or a URL beyond its origin.
- This is a public repository. No secrets, no real hostnames, no personal data in code, fixtures, commit messages or PR text. Use `example.test` for seeded pages, matching `browser-conformance.test.ts`.
- No CAPTCHA solving and no bot-detection evasion. Detection routes to `request_takeover` only.
- UI: semantic tokens from `@rakazo/ui-tokens` only — no product hex, no `[var(--…)]` arbitrary values. Reuse `packages/ui-web` components before writing chrome by hand.
- Run `pnpm lint` (Biome) before each commit. Do not run `pnpm --filter @rakazo/desktop test:e2e` locally; CI covers it.

## Review Focus

Five input classes the spec implies, that a naive task-by-task reading would leave untested, most likely to bite first. Each has a test assigned to the task that owns the code.

1. **A third-party endpoint returns a probability outside 0..1, or `NaN`.** A reasonable person expects an out-of-range score to be treated as "unknown" and escalate, never as maximal confidence. Pinned in Task 2.
2. **The decider names a ref that is not in the elements list** (stale snapshot, invented ref). Expected: escalate; never dispatch an action on an unknown ref. Pinned in Task 2.
3. **The elements list is empty** — a page drawn entirely in canvas or a cross-origin frame. Expected: escalate to the screenshot path, not a crash and not a zero-candidate "done". Pinned in Task 2.
4. **The decider times out or the connection drops mid-chain.** Expected: escalate, and never replay an action whose result was uncertain. Pinned in Task 5 (adapter-side timeout) and Task 9 (chain-side `uncertain` handling).
5. **`goal` arrives empty, whitespace, or absurdly long.** Expected: treated as absent so the decider is skipped and behavior is exactly today's, rather than sending a junk goal to a third party. Pinned in Task 9.
6. **A point arrives but no element carries a rect** — a bot on a computer image that predates geometry, which will be common in a mixed fleet while images roll out. Expected: no candidate, escalate, no crash; and a provider with no `screenshot()` at all must simply lose the accelerator. Pinned in Task 5b.

---

## File Structure

**Create:**

| File | Responsibility |
|---|---|
| `packages/adapter-kit/src/page-decider.ts` | `PageDecider` interface and its request/result types |
| `packages/core/src/page-decision-policy.ts` | Pure policy: decision + budget + thresholds → outcome |
| `packages/core/src/page-decision-policy.test.ts` | Policy tests, including all five Review Focus items it owns |
| `packages/adapters/src/fake-page-decider.ts` | In-process seeded decider for offline tests |
| `packages/adapters/src/model-page-decider.ts` | `model` backend: asks the bot's own model a structured question |
| `packages/adapters/src/systemone-page-decider.ts` | `systemone` backend over `/v1/systemone` |
| `packages/adapters/src/vision-page-decider.ts` | `vision` backend: OpenAI-compatible VLM (Holo1.5-7B) |
| `packages/adapters/src/vision-page-decider.test.ts` | vision backend tests |
| `packages/adapters/src/systemone-client.ts` | Shared HTTP plumbing, extracted from `jev-auto-review.ts` |
| `packages/adapters/src/page-decider-factory.ts` | Kind resolution and construction |
| `packages/adapters/src/page-decider-conformance.test.ts` | Every adapter satisfies the contract, offline |
| `packages/adapters/src/page-decider-selection.ts` | Run → bot → deployment → `model` precedence, with consent gate |
| `packages/adapters/src/page-decider-selection.test.ts` | Precedence and consent tests |
| `packages/adapters/src/page-decision-chain.ts` | The decide→policy→act loop used by the browser tools |
| `packages/adapters/src/page-decision-chain.test.ts` | Chain tests, including `uncertain` and empty-goal handling |
| `packages/testkit/src/page-decider-replay.ts` | Replay suite: recorded states, same assertions on both configs |
| `packages/testkit/src/cli/page-decider-calibrate.ts` | Calibration harness (a script, not a test) |

**Modify:**

| File | Edit |
|---|---|
| `packages/adapter-kit/src/registry.ts` | one `slots` entry: `pageDecider: "page-decider"` |
| `packages/adapter-kit/src/types.ts` | `rect?` on `BrowserSnapshotNode`, `geometry` capability, screenshot shapes, `PageBrowserCommand` variant |
| `packages/adapter-kit/src/interfaces.ts` | one optional `BrowserProvider.screenshot?` |
| `infra/sandboxes/computer/rakazo-page-browser` | report rects, cap 240, `screenshot` command |
| `packages/adapters/src/computer-browser.ts` | `screenshot()` via the page-browser contract |
| `packages/adapters/src/fake-browser.ts` | deterministic rects and a fixed capture (the emulator extends it) |
| `packages/adapter-kit/src/index.ts` | export `./page-decider.js` |
| `packages/core/src/index.ts` | export `./page-decision-policy.js` |
| `packages/adapters/src/index.ts` | export the six new adapter modules |
| `packages/adapters/src/jev-auto-review.ts` | use the extracted client; behavior unchanged |
| `packages/adapters/src/builtin-tools.ts` | one optional `goal` field on `browser_navigate` and `browser_act` |
| `packages/adapters/src/browser-tools.ts` | consult the chain when a goal is present |
| `packages/adapters/src/executor.ts:2953` | one `deps.pageDecider` default beside `deps.browser` |
| `packages/db/prisma/schema.prisma` | two nullable columns on `Bot`, two on `Run` |
| bot settings UI (located in Task 11) | one progressively-disclosed connection picker |

---

### Task 1: Contract and slot

**Files:**
- Create: `packages/adapter-kit/src/page-decider.ts`
- Modify: `packages/adapter-kit/src/registry.ts`, `packages/adapter-kit/src/index.ts`
- Test: `packages/adapter-kit/src/registry.test.ts` (exists — add a case)

**Interfaces:**
- Consumes: `AdapterContext`, `AdapterDescriptor`, `BrowserActKind`, `BrowserSnapshotNode`, `ComputerRef` from `./types.js`.
- Produces: `PageDecider`, `PageDeciderCapabilities`, `PageDecisionRequest`, `PageDecisionAttempt`, `PageDecision`, `PageDecisionCandidate`, and `slots.pageDecider === "page-decider"`. Every later task imports these names exactly.

- [ ] **Step 1: Write the failing test**

Append to `packages/adapter-kit/src/registry.test.ts`:

```typescript
it("exposes a page-decider slot", () => {
  expect(slots.pageDecider).toBe("page-decider");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/adapter-kit/src/registry.test.ts -t "page-decider slot"`
Expected: FAIL — `slots.pageDecider` is `undefined`, so `expect(undefined).toBe("page-decider")`.

- [ ] **Step 3: Create the contract file**

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
  /** True when the adapter ranks candidate actions over enumerated elements. */
  pick: boolean;
  /** True when the adapter returns probabilities rather than a bare label. */
  scores: boolean;
  /** True when the adapter needs a screenshot to decide. */
  vision: boolean;
  /**
   * True when the adapter adds no vendor beyond the bot's configured model.
   * The `model` backend is keyless in this sense even when the bot's own model
   * is hosted; a `systemone` adapter pointed at a self-hosted endpoint is too.
   */
  keyless?: boolean;
}

export interface PageDecisionAttempt {
  ref: string;
  kind: BrowserActKind;
  /** Whether the page changed after this attempt. Drives the stuck signal. */
  changed: boolean;
}

export interface PageDecisionRequest {
  /** The current browser leg's goal, as planned by the bot's model. */
  goal: string;
  /** Candidates, taken verbatim from BrowserSnapshotResult.elements. */
  elements: readonly BrowserSnapshotNode[];
  /** Bounded visible page text, for goal and interstitial judgment. */
  excerpt: string;
  url: string;
  title: string;
  history: readonly PageDecisionAttempt[];
  /**
   * Supplied only when the adapter declares `vision`. A text-only decider is
   * never handed pixels, so the cheap path stays cheap.
   */
  screenshot?: { data: string; mimeType: string };
  signal?: AbortSignal;
}

export interface PageDecisionCandidate {
  ref: string;
  kind: BrowserActKind;
  confidence: number;
}

export interface PageDecision {
  /** Ranked best first. Empty when the adapter declines to pick. */
  candidates: readonly PageDecisionCandidate[];
  /** Probability the goal is already met. */
  goalMet: number;
  /** Probability no further progress is possible. */
  stuck: number;
  /** Probability this page is an interstitial needing a human. */
  blocked: number;
  error?: string;
}

/**
 * Provider-neutral fast decision for one browser step. Never produces text to
 * type and never receives a screenshot: it returns a ref and a kind, and the
 * caller's policy decides whether to trust it.
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

- [ ] **Step 4: Add the slot and the export**

In `packages/adapter-kit/src/registry.ts`, add one entry to the `slots` object, after `browser`:

```typescript
  pageDecider: "page-decider",
```

In `packages/adapter-kit/src/index.ts`, add the export line in the existing alphabetical position:

```typescript
export * from "./page-decider.js";
```

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm vitest run packages/adapter-kit/src/registry.test.ts -t "page-decider slot"`
Expected: PASS

Run: `pnpm --filter @rakazo/adapter-kit check`
Expected: no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/adapter-kit/src/page-decider.ts packages/adapter-kit/src/registry.ts packages/adapter-kit/src/index.ts packages/adapter-kit/src/registry.test.ts
git commit -m "feat(adapter-kit): add the page-decider contract and slot"
```

---

### Task 1b: Element geometry and a viewport screenshot

The page browser gains two optional capabilities the vision backend needs: where each element is, and a screenshot in the same coordinate space. Both are additive, and a provider without them loses the accelerator rather than the browser.

**Files:**
- Modify: `packages/adapter-kit/src/types.ts`, `packages/adapter-kit/src/interfaces.ts`, `infra/sandboxes/computer/rakazo-page-browser`, `packages/adapters/src/computer-browser.ts`, `packages/adapters/src/fake-browser.ts`, `packages/adapters/src/browser-emulator.ts`
- Test: `packages/adapters/src/browser-conformance.test.ts`

**Interfaces:**
- Produces: `BrowserSnapshotNode.rect?`, `BrowserScreenshotRequest`, `BrowserScreenshotResult`, `BrowserProvider.screenshot?`, `PageBrowserCommand` variant `{ command: "screenshot" }`, and `BrowserCapabilities.geometry`. Tasks 5b and 9 consume all of these.

- [ ] **Step 1: Write the failing conformance assertions**

In `packages/adapters/src/browser-conformance.test.ts`, extend `assertBrowserConformance` after the existing snapshot assertions:

```typescript
  // Geometry is optional: a provider on an older computer image reports none.
  // When it does report a rect, the rect must be usable.
  if (desc.capabilities.geometry) {
    const withRect = snap.elements.find((element) => element.rect);
    expect(withRect).toBeTruthy();
    expect(withRect!.rect!.width).toBeGreaterThan(0);
    expect(withRect!.rect!.height).toBeGreaterThan(0);
    expect(withRect!.rect!.x).toBeGreaterThanOrEqual(0);
    expect(withRect!.rect!.y).toBeGreaterThanOrEqual(0);
  }

  // Likewise the capture: present or absent, never malformed.
  if (provider.screenshot) {
    const shot = await provider.screenshot(computer, {}, context);
    if (!shot.fallback && !shot.error) {
      expect(shot.data.length).toBeGreaterThan(0);
      expect(shot.mimeType).toMatch(/^image\//);
      expect(shot.scale).toBeGreaterThan(0);
    }
  }
```

Add `expect(desc.capabilities.geometry).toBeTypeOf("boolean");` beside the existing `page`/`refs` assertions.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/adapters/src/browser-conformance.test.ts`
Expected: FAIL — `capabilities.geometry` is `undefined`, not a boolean.

- [ ] **Step 3: Add the contract**

In `packages/adapter-kit/src/types.ts`, add `rect` to `BrowserSnapshotNode`:

```typescript
export interface BrowserSnapshotNode {
  /** Stable element ref for browser_act (e.g. e12). */
  ref: string;
  role: string;
  name: string;
  value?: string;
  tag?: string;
  /**
   * CSS pixels relative to the viewport, matching a CDP viewport capture's
   * coordinate space. Absent when the computer image predates geometry.
   */
  rect?: { x: number; y: number; width: number; height: number };
}
```

Add `geometry` to `BrowserCapabilities`:

```typescript
  /** True when snapshot elements carry a rect. */
  geometry: boolean;
```

Add the screenshot shapes next to the other browser types:

```typescript
export interface BrowserScreenshotRequest {
  signal?: AbortSignal;
}

export interface BrowserScreenshotResult {
  /** Base64 image bytes, no data: prefix. */
  data: string;
  mimeType: string;
  /**
   * Device pixels per CSS pixel in this capture, so a consumer can convert
   * between image coordinates and element rects.
   */
  scale: number;
  fallback?: "computer_act";
  error?: string;
}
```

Extend the page-browser command union:

```typescript
export type PageBrowserCommand =
  | { command: "navigate"; url: string }
  | { command: "snapshot" }
  | { command: "screenshot" }
  | { command: "act"; actions: BrowserActStep[] };

export type PageBrowserResult = Partial<
  BrowserSnapshotResult & BrowserActResult & BrowserScreenshotResult
> & { ok: boolean };
```

In `packages/adapter-kit/src/interfaces.ts`, add one optional method to `BrowserProvider`:

```typescript
  /**
   * A viewport capture in the same coordinate space as snapshot rects.
   *
   * Optional: a provider whose computer image predates it simply omits it, and
   * a caller needing pixels escalates instead. Deliberately not the desktop
   * observe path — that is the full screen in device pixels, and converting it
   * to viewport CSS pixels needs a window offset and a device pixel ratio that
   * are unreliable under X11.
   */
  screenshot?(
    computer: ComputerRef,
    request: BrowserScreenshotRequest,
    context: AdapterContext,
  ): Promise<BrowserScreenshotResult>;
```

- [ ] **Step 4: Report rects from the in-computer helper, and raise the cap**

In `infra/sandboxes/computer/rakazo-page-browser`, `visible()` already computes the rect and discards it (line ~359). Return it from `snapshot()` instead. Inside the element loop, add to the pushed object:

```javascript
          rect: (() => {
            const r = el.getBoundingClientRect();
            return {
              x: Math.round(r.x),
              y: Math.round(r.y),
              width: Math.round(r.width),
              height: Math.round(r.height),
            };
          })(),
```

Raise the cap in the same loop:

```javascript
        if (elements.length >= 240) break;
```

240 matches the reference implementation and stays under the System One protocol's 255-option ceiling, so an element can always be offered as a choice option.

- [ ] **Step 5: Add the screenshot command to the helper**

Add a `screenshot` function beside the existing `snapshot`, using the CDP session the helper already holds:

```python
def screenshot(client: CdpClient, session_id: str) -> dict[str, Any]:
    # Page.captureScreenshot returns the viewport, in the same coordinate space
    # as getBoundingClientRect, so no transform is needed. The image is in
    # device pixels, so report devicePixelRatio as the one conversion factor a
    # consumer may still need. Not visualViewport.scale, which is pinch-zoom.
    ensure_helpers(client, session_id)
    ratio = eval_json(client, session_id, "window.devicePixelRatio")
    scale = ratio if isinstance(ratio, (int, float)) and ratio > 0 else 1
    shot = client.call(
        "Page.captureScreenshot",
        {"format": "png", "captureBeyondViewport": False},
        session_id=session_id,
        timeout_s=15.0,
    )
    return {
        "ok": True,
        "data": shot.get("data") or "",
        "mimeType": "image/png",
        "scale": scale,
    }
```

Add the dispatch branch beside the others (line ~670):

```python
            elif command == "screenshot":
                result = screenshot(client, session_id)
```

- [ ] **Step 6: Thread it through the computer provider**

In `packages/adapters/src/computer-browser.ts`, add a `screenshot` method that issues `{ command: "screenshot" }` through the same `pageBrowser` contract and lease checks the existing methods use, and set `geometry: true` in its `describe()` capabilities. Follow the existing `snapshot` method exactly — same lease handling, same `fallback: "computer_act"` on a provider that does not implement `pageBrowser`.

In `packages/adapters/src/fake-browser.ts`, set `geometry: true` and have its in-process snapshot assign each element a deterministic non-overlapping rect, so offline tests can exercise point mapping.

`browser-emulator.ts` needs **no** change: `EmulatorBrowserProvider extends FakeBrowserProvider` and overrides only `id`, so it inherits both the rects and the capture. Adding them there too would duplicate the geometry logic in two places for no gain.

```typescript
/** Deterministic stacked boxes: offline point mapping needs real geometry. */
function fakeRect(index: number) {
  return { x: 0, y: index * 24, width: 320, height: 24 };
}
```

Give `FakeBrowserProvider` a `screenshot()` returning a fixed 1×1 PNG with `scale: 1`, plus a mutable `noScreenshot` flag beside the existing `navigateError` / `snapshotError` / `actError` / `forceFallback` ones, so a test can model a provider whose computer image predates the capture:

```typescript
  /** When set, this provider reports no capture at all (older image). */
  noScreenshot?: boolean;

  async screenshot(): Promise<BrowserScreenshotResult> {
    if (this.noScreenshot) {
      return {
        data: "",
        mimeType: "image/png",
        scale: 1,
        fallback: "computer_act",
        error: "This computer has no page-browser capture.",
      };
    }
    if (this.forceFallback) {
      return {
        data: "",
        mimeType: "image/png",
        scale: 1,
        fallback: "computer_act",
        error: this.forceFallback,
      };
    }
    return {
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==",
      mimeType: "image/png",
      scale: 1,
    };
  }
```

`noScreenshot` returns a `fallback` rather than removing the method, because the real mixed-fleet case is a provider whose helper does not implement the command — which surfaces as `fallback: "computer_act"`, exactly what `captureViewport` already treats as "no pixels available".

- [ ] **Step 7: Run the browser suites**

Run: `pnpm vitest run packages/adapters/src/browser-conformance.test.ts packages/adapters/src/computer-browser.test.ts packages/adapters/src/browser-tools.test.ts packages/adapters/src/page-browser-login-fill.test.ts`
Expected: PASS. Existing assertions must not need editing — `rect` and `screenshot` are additive and nothing reads them yet.

- [ ] **Step 8: Rebuild the computer image**

Run: `pnpm sandbox:build`
Expected: the image builds with the updated helper.

Then confirm the helper still parses and dispatches, which catches a Python syntax error without needing a running container:

Run: `python3 -c "import ast,sys; ast.parse(open('infra/sandboxes/computer/rakazo-page-browser').read()); print('helper parses')"`
Expected: `helper parses`

E2B, Daytona and Box ship their own images. Until those carry the updated helper they report no `rect` and no screenshot, the vision backend cannot run on them, and the policy escalates — today's behavior. Say this in the PR description rather than leaving it to be discovered.

- [ ] **Step 9: Commit**

```bash
git add packages/adapter-kit/src/types.ts packages/adapter-kit/src/interfaces.ts infra/sandboxes/computer/rakazo-page-browser packages/adapters/src/computer-browser.ts packages/adapters/src/fake-browser.ts packages/adapters/src/browser-conformance.test.ts
git commit -m "feat(browser): report element geometry and a viewport screenshot"
```

---

### Task 2: The policy function

The heart of the design. Pure, no I/O, and it owns three of the five Review Focus items. Write every test before any implementation.

**Files:**
- Create: `packages/core/src/page-decision-policy.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/page-decision-policy.test.ts`

**Interfaces:**
- Consumes: `PageDecision`, `PageDecisionAttempt`, `PageDecisionCandidate`, `BrowserActKind` from `@rakazo/adapter-kit`.
- Produces: `decidePageAction(input: PageDecisionPolicyInput): PageDecisionOutcome`, `DEFAULT_PAGE_DECISION_THRESHOLDS`, and the types `PageDecisionThresholds`, `PageDecisionBudget`, `PageDecisionPolicyInput`, `PageDecisionOutcome`. Tasks 9 and 10 call `decidePageAction` with exactly this input shape.

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

### Task 3: Fake adapter and the conformance suite

**Files:**
- Create: `packages/adapters/src/fake-page-decider.ts`, `packages/adapters/src/page-decider-conformance.test.ts`
- Modify: `packages/adapters/src/index.ts`

**Interfaces:**
- Consumes: Task 1's contract.
- Produces: `FakePageDecider`, `FakePageDeciderOptions`, and the exported helper `assertPageDeciderConformance(decider: PageDecider): Promise<void>`, which Tasks 4 and 5 call for their own adapters.

- [ ] **Step 1: Write the failing conformance test**

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

const computer: ComputerRef = {
  id: "computer-1",
  botId: "bot-1",
  kind: "fake",
  providerRef: "computer-1",
};

const request = {
  goal: "Sign up with the email field",
  elements: [
    { ref: "e1", role: "textbox", name: "Email" },
    { ref: "e2", role: "button", name: "Continue" },
  ],
  excerpt: "Signup. Email. Continue.",
  url: "https://example.test/form",
  title: "Signup",
  history: [],
};

/**
 * Offline conformance: every PageDecider advertises pick+scores, returns
 * in-range probabilities, only ever names refs it was given, and honors
 * cancellation. Seeded in process so this never touches the network.
 */
export async function assertPageDeciderConformance(decider: PageDecider): Promise<void> {
  const desc = decider.describe();
  expect(desc.capabilities.pick).toBe(true);
  expect(desc.capabilities.scores).toBe(true);
  expect(typeof desc.capabilities.vision).toBe("boolean");
  expect(desc.contractVersion).toBe("1");

  // A text-only adapter must never be handed pixels, and a vision adapter must
  // not be asked to decide without them.
  if (!desc.capabilities.vision) {
    expect(request.screenshot).toBeUndefined();
  }

  const decision = await decider.decide(computer, request, context);

  for (const value of [decision.goalMet, decision.stuck, decision.blocked]) {
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(1);
  }

  const given = new Set(request.elements.map((element) => element.ref));
  for (const candidate of decision.candidates) {
    expect(given.has(candidate.ref)).toBe(true);
    expect(["click", "fill", "type"]).toContain(candidate.kind);
    expect(candidate.confidence).toBeGreaterThanOrEqual(0);
    expect(candidate.confidence).toBeLessThanOrEqual(1);
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
  it("holds for fake (offline)", async () => {
    await assertPageDeciderConformance(
      new FakePageDecider({
        decisions: [{ candidates: [{ ref: "e2", kind: "click", confidence: 0.9 }] }],
      }),
    );
  });

  it("returns a seeded error without throwing", async () => {
    const decider = new FakePageDecider({ error: "seeded failure" });
    const decision = await decider.decide(computer, request, context);
    expect(decision.error).toBe("seeded failure");
    expect(decision.candidates).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/adapters/src/page-decider-conformance.test.ts`
Expected: FAIL — cannot resolve `./fake-page-decider.js`.

- [ ] **Step 3: Write the fake adapter**

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
  /** Returned in order; the last one repeats once the queue is drained. */
  decisions?: ReadonlyArray<Partial<PageDecision>>;
  /** When set, every call reports this error and no candidates. */
  error?: string;
}

const EMPTY: PageDecision = { candidates: [], goalMet: 0, stuck: 0, blocked: 0 };

/**
 * In-process decider for offline conformance and replay. Not a model: it
 * replays seeded decisions so the policy and chain can be tested without a
 * network or a vendor.
 */
export class FakePageDecider implements PageDecider {
  readonly requests: PageDecisionRequest[] = [];
  private readonly decisions: ReadonlyArray<Partial<PageDecision>>;
  private readonly error?: string;
  private cursor = 0;

  constructor(options: FakePageDeciderOptions = {}) {
    this.decisions = options.decisions ?? [];
    this.error = options.error;
  }

  describe(): AdapterDescriptor<PageDeciderCapabilities> {
    return {
      id: "fake",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { pick: true, scores: true, vision: false, keyless: true },
    };
  }

  async decide(
    computer: ComputerRef,
    request: PageDecisionRequest,
    context: AdapterContext,
  ): Promise<PageDecision> {
    void computer;
    this.requests.push(request);
    const signal = request.signal ?? context.signal;
    if (signal.aborted) return { ...EMPTY, error: "cancelled" };
    if (this.error) return { ...EMPTY, error: this.error };
    if (this.decisions.length === 0) return EMPTY;
    const index = Math.min(this.cursor, this.decisions.length - 1);
    this.cursor += 1;
    return { ...EMPTY, ...this.decisions[index] };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/adapters/src/page-decider-conformance.test.ts`
Expected: PASS, both cases.

- [ ] **Step 5: Export and commit**

In `packages/adapters/src/index.ts`, add in alphabetical position:

```typescript
export * from "./fake-page-decider.js";
```

Run: `pnpm --filter @rakazo/adapters check && pnpm lint`

```bash
git add packages/adapters/src/fake-page-decider.ts packages/adapters/src/page-decider-conformance.test.ts packages/adapters/src/index.ts
git commit -m "feat(adapters): add the fake page decider and its conformance suite"
```

---

### Task 4: The `model` backend

Asks the bot's own model one structured question. This is the no-vendor default. Per the spec it is **not** the fast path — it exists so core runs with nothing configured and so the whole suite is offline-testable.

The adapter owns the prompt, the parsing and the clamping. It does **not** reach into the Pi runtime: the caller injects a narrow `generate` callback, which keeps the adapter unit-testable and keeps model plumbing in the executor (Task 8).

**Files:**
- Create: `packages/adapters/src/model-page-decider.ts`
- Modify: `packages/adapters/src/index.ts`, `packages/adapters/src/page-decider-conformance.test.ts`
- Test: `packages/adapters/src/model-page-decider.test.ts`

**Interfaces:**
- Consumes: Task 1's contract; `assertPageDeciderConformance` from Task 3.
- Produces: `ModelPageDecider`, `ModelPageDeciderOptions`, and the callback type
  `StructuredGenerate = (args: { system: string; user: string; schema: Record<string, unknown>; signal: AbortSignal }) => Promise<unknown>`. Task 8 supplies that callback.

- [ ] **Step 1: Write the failing tests**

Create `packages/adapters/src/model-page-decider.test.ts`:

```typescript
import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { ModelPageDecider } from "./model-page-decider.js";

const context: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

const computer: ComputerRef = {
  id: "c1",
  botId: "b1",
  kind: "fake",
  providerRef: "c1",
};

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

describe("ModelPageDecider", () => {
  it("maps a well-formed model answer onto a decision", async () => {
    const decider = new ModelPageDecider({
      generate: async () => ({
        candidates: [{ ref: "e2", kind: "click", confidence: 0.9 }],
        goalMet: 0.1,
        stuck: 0,
        blocked: 0,
      }),
    });
    const decision = await decider.decide(computer, request, context);
    expect(decision.candidates).toEqual([{ ref: "e2", kind: "click", confidence: 0.9 }]);
    expect(decision.goalMet).toBe(0.1);
  });

  it("drops a candidate whose ref was never offered", async () => {
    const decider = new ModelPageDecider({
      generate: async () => ({
        candidates: [
          { ref: "e9", kind: "click", confidence: 0.99 },
          { ref: "e1", kind: "fill", confidence: 0.8 },
        ],
        goalMet: 0,
        stuck: 0,
        blocked: 0,
      }),
    });
    const decision = await decider.decide(computer, request, context);
    expect(decision.candidates).toEqual([{ ref: "e1", kind: "fill", confidence: 0.8 }]);
  });

  it("reports an error rather than throwing on an unparseable answer", async () => {
    const decider = new ModelPageDecider({ generate: async () => "not an object" });
    const decision = await decider.decide(computer, request, context);
    expect(decision.error).toBeTruthy();
    expect(decision.candidates).toEqual([]);
  });

  it("reports an error when the model call throws", async () => {
    const decider = new ModelPageDecider({
      generate: async () => {
        throw new Error("model unavailable");
      },
    });
    const decision = await decider.decide(computer, request, context);
    expect(decision.error).toBeTruthy();
    expect(decision.candidates).toEqual([]);
  });

  it("never puts page text in the error it surfaces", async () => {
    const decider = new ModelPageDecider({
      generate: async () => {
        throw new Error(`failed on ${request.excerpt} at ${request.url}`);
      },
    });
    const decision = await decider.decide(computer, request, context);
    expect(decision.error).not.toContain(request.excerpt);
    expect(decision.error).not.toContain("/form");
  });

  it("declares itself keyless", () => {
    const decider = new ModelPageDecider({ generate: async () => ({}) });
    expect(decider.describe().capabilities.keyless).toBe(true);
    expect(decider.describe().id).toBe("model");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/adapters/src/model-page-decider.test.ts`
Expected: FAIL — cannot resolve `./model-page-decider.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/adapters/src/model-page-decider.ts`:

```typescript
import type {
  AdapterContext,
  AdapterDescriptor,
  BrowserSnapshotNode,
  ComputerRef,
  PageDecider,
  PageDeciderCapabilities,
  PageDecision,
  PageDecisionCandidate,
  PageDecisionRequest,
} from "@rakazo/adapter-kit";
import { z } from "zod";

/** A narrow structured-output call. Task 8 wires this to the Pi runtime. */
export type StructuredGenerate = (args: {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  signal: AbortSignal;
}) => Promise<unknown>;

export interface ModelPageDeciderOptions {
  generate: StructuredGenerate;
}

const answerSchema = z.object({
  candidates: z
    .array(
      z.object({
        ref: z.string(),
        kind: z.enum(["click", "fill", "type"]),
        confidence: z.number(),
      }),
    )
    .default([]),
  point: z
    .object({
      x: z.number(),
      y: z.number(),
      kind: z.enum(["click", "fill", "type"]),
      confidence: z.number(),
    })
    .optional(),
  goalMet: z.number().default(0),
  stuck: z.number().default(0),
  blocked: z.number().default(0),
});

const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ref: { type: "string" },
          kind: { type: "string", enum: ["click", "fill", "type"] },
          confidence: { type: "number" },
        },
        required: ["ref", "kind", "confidence"],
      },
    },
    // Only a vision backend fills this in, and only when no listed element
    // fits. The text backends leave it out and nothing reads it.
    point: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        kind: { type: "string", enum: ["click", "fill", "type"] },
        confidence: { type: "number" },
      },
      required: ["x", "y", "kind", "confidence"],
    },
    goalMet: { type: "number" },
    stuck: { type: "number" },
    blocked: { type: "number" },
  },
  required: ["candidates", "goalMet", "stuck", "blocked"],
};

const SYSTEM = [
  "You choose one next action on a web page from a fixed list of elements.",
  "Answer only with the given schema. Never invent a ref that is not listed.",
  "Never produce text to type: name the element and the kind only.",
  "goalMet is the probability the goal is already satisfied.",
  "stuck is the probability no listed element can make progress.",
  "blocked is the probability this page is an interstitial that needs a human,",
  "such as a bot check, a two-factor prompt, or a payment confirmation.",
].join(" ");

const EMPTY: PageDecision = { candidates: [], goalMet: 0, stuck: 0, blocked: 0 };

/**
 * Asks the bot's own model for the step decision. Requires no vendor beyond
 * the model the bot already uses, which keeps core working unconfigured; it is
 * the correctness baseline, not the fast path.
 */
export class ModelPageDecider implements PageDecider {
  private readonly generate: StructuredGenerate;

  constructor(options: ModelPageDeciderOptions) {
    this.generate = options.generate;
  }

  describe(): AdapterDescriptor<PageDeciderCapabilities> {
    return {
      id: "model",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { pick: true, scores: true, vision: false, keyless: true },
    };
  }

  async decide(
    computer: ComputerRef,
    request: PageDecisionRequest,
    context: AdapterContext,
  ): Promise<PageDecision> {
    void computer;
    const signal = request.signal ?? context.signal;
    if (signal.aborted) return { ...EMPTY, error: "cancelled" };

    let raw: unknown;
    try {
      raw = await this.generate({
        system: SYSTEM,
        user: JSON.stringify({
          goal: request.goal,
          url: new URL(request.url).origin,
          title: request.title,
          excerpt: request.excerpt,
          elements: request.elements,
          history: request.history,
        }),
        schema: RESPONSE_SCHEMA,
        signal,
      });
    } catch {
      // The thrown message can carry page text; never surface it.
      return { ...EMPTY, error: "The decider model did not answer." };
    }

    const parsed = answerSchema.safeParse(raw);
    if (!parsed.success) return { ...EMPTY, error: "The decider model returned no decision." };

    const offered = new Set(request.elements.map((element) => element.ref));
    return {
      candidates: parsed.data.candidates.filter((candidate) => offered.has(candidate.ref)),
      goalMet: parsed.data.goalMet,
      stuck: parsed.data.stuck,
      blocked: parsed.data.blocked,
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/adapters/src/model-page-decider.test.ts`
Expected: PASS, all six.

- [ ] **Step 5: Add it to the conformance suite**

In `packages/adapters/src/page-decider-conformance.test.ts`, add the import at the top:

```typescript
import { ModelPageDecider } from "./model-page-decider.js";
```

and a case inside `describe("page decider conformance", ...)`:

```typescript
it("holds for model (offline, stubbed generate)", async () => {
  await assertPageDeciderConformance(
    new ModelPageDecider({
      generate: async () => ({
        candidates: [{ ref: "e2", kind: "click", confidence: 0.9 }],
        goalMet: 0,
        stuck: 0,
        blocked: 0,
      }),
    }),
  );
});
```

- [ ] **Step 6: Run the suite and commit**

Run: `pnpm vitest run packages/adapters/src/page-decider-conformance.test.ts packages/adapters/src/model-page-decider.test.ts`
Expected: PASS.

In `packages/adapters/src/index.ts`, add `export * from "./model-page-decider.js";`.

```bash
git add packages/adapters/src/model-page-decider.ts packages/adapters/src/model-page-decider.test.ts packages/adapters/src/page-decider-conformance.test.ts packages/adapters/src/index.ts
git commit -m "feat(adapters): add the model page decider"
```

---

### Task 5: The `systemone` backend

One adapter for both hosted and self-hosted `/v1/systemone` endpoints, differing only by base URL and key. Starts by extracting the HTTP plumbing that `jev-auto-review.ts` already has, so there is one source of truth rather than two copies.

**A verified unknown, and how to handle it.** The existing client validates a response envelope of `answers.<key>` with `{ type, choice, confidence }`, and that client is in production. Public documentation for a compatible self-hosted implementation instead describes accessors shaped `result.choices[key].choice` and `result.nouls[key].noul`, which may be an SDK convenience over the same JSON or may be a genuinely different envelope. **Do not write code for both.** Follow the shape the working client uses, keep the envelope decoding in the single function `parseSystemOneAnswers`, and record a fixture from a real endpoint in Step 6. If the fixture disagrees, that one function is the only place to change.

**Files:**
- Create: `packages/adapters/src/systemone-client.ts`, `packages/adapters/src/systemone-page-decider.ts`
- Modify: `packages/adapters/src/jev-auto-review.ts`, `packages/adapters/src/index.ts`, `packages/adapters/src/page-decider-conformance.test.ts`
- Test: `packages/adapters/src/systemone-page-decider.test.ts`

**Interfaces:**
- Consumes: Task 1's contract; `readBodyCapped` from `./web-ssrf.js`; `assertPageDeciderConformance` from Task 3.
- Produces: `postSystemOne(options)`, `parseSystemOneAnswers(body)`, `SYSTEMONE_MAX_STATE_CHARS = 20000`, `SYSTEMONE_MAX_JSON_BYTES = 64000` from `systemone-client.ts`; `SystemOnePageDecider`, `SystemOnePageDeciderOptions` from the adapter.

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
    { ref: "e1", role: "textbox", name: "Email" },
    { ref: "e2", role: "button", name: "Continue" },
  ],
  excerpt: "Signup",
  url: "https://example.test/form",
  title: "Signup",
  history: [],
};

function respond(body: unknown, status = 200) {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

const ok = {
  model: "jev-latest",
  answers: {
    element: { type: "choice", choice: "e2", confidence: 0.91 },
    goalMet: { type: "noul", noul: 0.05 },
    stuck: { type: "noul", noul: 0.02 },
    blocked: { type: "noul", noul: 0.01 },
  },
};

describe("SystemOnePageDecider", () => {
  it("maps a well-formed response onto a decision", async () => {
    const decider = new SystemOnePageDecider({
      baseUrl: "https://decider.example.test",
      apiKey: "test-key",
      fetch: respond(ok),
    });
    const decision = await decider.decide(computer, request, context);
    expect(decision.candidates).toEqual([{ ref: "e2", kind: "click", confidence: 0.91 }]);
    expect(decision.goalMet).toBe(0.05);
    expect(decision.blocked).toBe(0.01);
  });

  it("infers fill for a textbox and click for a button", async () => {
    const decider = new SystemOnePageDecider({
      baseUrl: "https://decider.example.test",
      apiKey: "test-key",
      fetch: respond({
        ...ok,
        answers: { ...ok.answers, element: { type: "choice", choice: "e1", confidence: 0.9 } },
      }),
    });
    const decision = await decider.decide(computer, request, context);
    expect(decision.candidates).toEqual([{ ref: "e1", kind: "fill", confidence: 0.9 }]);
  });

  it("drops a choice that names an element it was not given", async () => {
    const decider = new SystemOnePageDecider({
      baseUrl: "https://decider.example.test",
      apiKey: "test-key",
      fetch: respond({
        ...ok,
        answers: { ...ok.answers, element: { type: "choice", choice: "e9", confidence: 0.99 } },
      }),
    });
    const decision = await decider.decide(computer, request, context);
    expect(decision.candidates).toEqual([]);
  });

  it("reports an error on a non-OK status without throwing", async () => {
    const decider = new SystemOnePageDecider({
      baseUrl: "https://decider.example.test",
      apiKey: "test-key",
      fetch: respond({}, 401),
    });
    const decision = await decider.decide(computer, request, context);
    expect(decision.error).toBeTruthy();
    expect(decision.candidates).toEqual([]);
  });

  // Review Focus 4, adapter half: a timeout is an escalation signal, not a hang.
  it("reports an error when the request exceeds its timeout", async () => {
    const decider = new SystemOnePageDecider({
      baseUrl: "https://decider.example.test",
      apiKey: "test-key",
      timeoutMs: 5,
      fetch: async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    const decision = await decider.decide(computer, request, context);
    expect(decision.error).toBeTruthy();
    expect(decision.candidates).toEqual([]);
  });

  it("caps the state it sends", async () => {
    let sent = "";
    const decider = new SystemOnePageDecider({
      baseUrl: "https://decider.example.test",
      apiKey: "test-key",
      fetch: async (_url, init) => {
        sent = String(init?.body ?? "");
        return new Response(JSON.stringify(ok), { status: 200 });
      },
    });
    await decider.decide(
      computer,
      { ...request, excerpt: "x".repeat(50_000) },
      context,
    );
    expect(sent.length).toBeLessThanOrEqual(64_000);
  });

  it("sends no secret-looking element values", async () => {
    let sent = "";
    const decider = new SystemOnePageDecider({
      baseUrl: "https://decider.example.test",
      apiKey: "test-key",
      fetch: async (_url, init) => {
        sent = String(init?.body ?? "");
        return new Response(JSON.stringify(ok), { status: 200 });
      },
    });
    await decider.decide(
      computer,
      {
        ...request,
        elements: [
          { ref: "e1", role: "textbox", name: "Password", tag: "input", value: "hunter2" },
        ],
      },
      context,
    );
    expect(sent).not.toContain("hunter2");
  });

  it("is not keyless when pointed at an endpoint with a key", () => {
    const decider = new SystemOnePageDecider({
      baseUrl: "https://decider.example.test",
      apiKey: "test-key",
      fetch: respond(ok),
    });
    expect(decider.describe().id).toBe("systemone");
    expect(decider.describe().capabilities.keyless).toBe(false);
  });
});

// A self-hosted decider is deliberately on loopback or a LAN address, so a
// blanket private-host block would break the configuration the spec calls
// first-class. The rule is the one `private-endpoint.ts` already states:
// hostname is not authorization — a private host needs an actor permitted to
// use one.
describe("assertDeciderBaseUrl", () => {
  const publicOnly = { allowPrivate: false };
  const privateOk = { allowPrivate: true };

  it("accepts a public https endpoint", async () => {
    await expect(
      assertDeciderBaseUrl("https://decider.example.test", publicOnly, resolvePublic),
    ).resolves.toBeInstanceOf(URL);
  });

  it("rejects a non-http scheme", async () => {
    await expect(
      assertDeciderBaseUrl("file:///etc/passwd", privateOk, resolvePublic),
    ).rejects.toThrow(/http/i);
  });

  it("rejects embedded credentials", async () => {
    await expect(
      assertDeciderBaseUrl("https://user:pw@decider.example.test", privateOk, resolvePublic),
    ).rejects.toThrow(/credential/i);
  });

  it("rejects a loopback endpoint for an actor without the permission", async () => {
    await expect(
      assertDeciderBaseUrl("http://127.0.0.1:8000", publicOnly, resolvePublic),
    ).rejects.toThrow(/private/i);
  });

  it("allows a loopback endpoint for an actor with the permission", async () => {
    await expect(
      assertDeciderBaseUrl("http://127.0.0.1:8000", privateOk, resolvePublic),
    ).resolves.toBeInstanceOf(URL);
  });
});
```

Add to that file's imports:

```typescript
import type { ResolvedAddress } from "./network-address.js";
import { assertDeciderBaseUrl } from "./systemone-client.js";

/**
 * Offline hostname resolution: a public address, no DNS.
 * `ResolveHostname` returns `{ address, family }` objects, not bare strings.
 */
const resolvePublic = async (): Promise<ResolvedAddress[]> => [
  { address: "93.184.216.34", family: 4 },
];
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/adapters/src/systemone-page-decider.test.ts`
Expected: FAIL — cannot resolve `./systemone-page-decider.js`.

- [ ] **Step 3: Extract the shared client**

Create `packages/adapters/src/systemone-client.ts`:

```typescript
import { z } from "zod";
import type { ResolveHostname } from "./web-ssrf.js";
import { assertSafeWebUrl, readBodyCapped } from "./web-ssrf.js";

export const SYSTEMONE_PATH = "/v1/systemone";
export const SYSTEMONE_MAX_STATE_CHARS = 20_000;
export const SYSTEMONE_MAX_JSON_BYTES = 64_000;

/**
 * One answer per question key, keyed by the caller's question set.
 *
 * Field shapes come from the published HTTP contract: a `choice` answer carries
 * a `probabilities` map over every option, and a `score` answer carries a
 * numeric `score` with a `legend`. Discriminated on `type` rather than a plain
 * union, so a malformed answer reports which variant failed.
 */
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
    probabilities: z.record(z.string(), z.number()).optional(),
    confidence: z.number().optional(),
  }),
]);

export const systemOneResponseSchema = z.object({
  model: z.string().optional(),
  answers: z.record(z.string(), answerSchema),
});

export type SystemOneAnswers = z.infer<typeof systemOneResponseSchema>["answers"];

/**
 * Decode the response envelope. This is the one place the wire shape is known,
 * so a change to it is a change to this function and nothing else.
 */
export function parseSystemOneAnswers(body: unknown): SystemOneAnswers | undefined {
  const parsed = systemOneResponseSchema.safeParse(body);
  return parsed.success ? parsed.data.answers : undefined;
}

/**
 * Every option the endpoint scored, ranked best first.
 *
 * The winner alone is not enough: the policy drops a candidate that already
 * failed to change the page and falls through to the next one, which cannot
 * work if the adapter only ever reports one. The `probabilities` map is what
 * makes that fallback real.
 */
export function systemOneRanking(
  answers: SystemOneAnswers,
  key: string,
): Array<{ option: string; confidence: number }> {
  const answer = answers[key];
  if (!answer || answer.type !== "choice") return [];
  const probabilities = answer.probabilities;
  if (!probabilities || Object.keys(probabilities).length === 0) {
    return [{ option: answer.choice, confidence: answer.confidence ?? 0 }];
  }
  return Object.entries(probabilities)
    .map(([option, confidence]) => ({ option, confidence }))
    .sort((a, b) => b.confidence - a.confidence);
}

export function systemOneNoul(answers: SystemOneAnswers, key: string): number {
  const answer = answers[key];
  return answer && answer.type === "noul" ? answer.noul : 0;
}

export interface PostSystemOneOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  state: unknown;
  questions: Record<string, unknown>;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
}

export interface DeciderUrlPolicy {
  /** Whether this actor may target loopback, LAN and Docker-network hosts. */
  allowPrivate: boolean;
}

/**
 * Validate an operator-configured decider endpoint.
 *
 * A self-hosted decider is deliberately private, so this cannot simply refuse
 * private hosts. It follows the rule `private-endpoint.ts` already sets for
 * remote MCP and installed connectors: hostname is not authorization. Scheme
 * and credential checks always apply; a private host additionally requires an
 * actor permitted to use one, decided by `actorMayUsePrivateEndpoint`.
 */
export async function assertDeciderBaseUrl(
  value: string,
  policy: DeciderUrlPolicy,
  resolve?: ResolveHostname,
  signal?: AbortSignal,
): Promise<URL> {
  if (policy.allowPrivate) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("The decider URL is invalid");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Only http: and https: decider URLs are allowed");
    }
    if (url.username || url.password) {
      throw new Error("The decider URL must not contain credentials");
    }
    return url;
  }
  return await assertSafeWebUrl(value, resolve, signal);
}

export function statusReason(status: number): string {
  if (status === 401 || status === 403) return "The decider could not authenticate.";
  if (status === 429) return "The decider is rate limited.";
  return "The decider returned an error.";
}

/**
 * POST one System One request. Caps the serialized state and the response
 * body, refuses redirects, and never widens the caller's abort scope.
 */
export async function postSystemOne(
  options: PostSystemOneOptions,
): Promise<{ answers?: SystemOneAnswers; error?: string }> {
  // The protocol accepts a string, an object or an array for `state`, so pass
  // the caller's value through untouched: converting an object to a string here
  // would silently change the payload the Auto Review checker already sends.
  // Only a string is truncated, and the whole body is size-checked separately.
  const state =
    typeof options.state === "string" && options.state.length > SYSTEMONE_MAX_STATE_CHARS
      ? options.state.slice(0, SYSTEMONE_MAX_STATE_CHARS)
      : options.state;

  const body = JSON.stringify({
    model: options.model,
    state,
    questions: options.questions,
  });
  if (body.length > SYSTEMONE_MAX_JSON_BYTES) {
    return { error: "The decider request was too large to send." };
  }

  const url = new URL(SYSTEMONE_PATH, options.baseUrl).toString();
  let response: Response;
  try {
    response = await options.fetchImpl(url, {
      method: "POST",
      redirect: "error",
      signal: options.signal,
      headers: {
        ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body,
    });
  } catch {
    return { error: "The decider timed out or failed." };
  }

  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    return { error: statusReason(response.status) };
  }

  try {
    const bytes = await readBodyCapped(response, SYSTEMONE_MAX_JSON_BYTES, options.signal);
    const answers = parseSystemOneAnswers(JSON.parse(new TextDecoder().decode(bytes)));
    return answers ? { answers } : { error: "The decider returned no decision." };
  } catch {
    return { error: "The decider returned no decision." };
  }
}
```

- [ ] **Step 4: Write the adapter**

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
import { postSystemOne, systemOneNoul, systemOneRanking } from "./systemone-client.js";

export const DEFAULT_SYSTEMONE_MODEL = "jev-latest";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ELEMENTS = 240;
const MAX_EXCERPT_CHARS = 4_000;

export interface SystemOnePageDeciderOptions {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const EMPTY: PageDecision = { candidates: [], goalMet: 0, stuck: 0, blocked: 0 };

/**
 * The one description of an element that leaves the process.
 *
 * `value` is deliberately never included: it can carry a typed secret, and the
 * decider has no use for it. Keeping the projection in one function is what
 * makes that guarantee checkable.
 */
function labelFor(element: BrowserSnapshotNode): string {
  const tag = element.tag ? ` <${element.tag}>` : "";
  return `${element.role}${tag}: ${element.name}`.slice(0, 200);
}

/** The decider names an element; the kind follows from what that element is. */
function kindFor(element: BrowserSnapshotNode): BrowserActKind {
  const role = element.role.toLowerCase();
  const tag = element.tag?.toLowerCase() ?? "";
  if (role === "textbox" || role === "searchbox" || tag === "input" || tag === "textarea") {
    return "fill";
  }
  return "click";
}

/**
 * Any `/v1/systemone` endpoint: the hosted service or a self-hosted drop-in.
 * One adapter, because the wire protocol is the same and only the base URL and
 * key differ.
 */
export class SystemOnePageDecider implements PageDecider {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SystemOnePageDeciderOptions) {
    this.baseUrl = options.baseUrl.trim();
    if (!this.baseUrl) throw new Error("A page decider base URL is required");
    this.apiKey = options.apiKey?.trim() || undefined;
    this.model = options.model?.trim() || DEFAULT_SYSTEMONE_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? fetch;
  }

  describe(): AdapterDescriptor<PageDeciderCapabilities> {
    return {
      id: "systemone",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { pick: true, scores: true, vision: false, keyless: !this.apiKey },
    };
  }

  async decide(
    computer: ComputerRef,
    request: PageDecisionRequest,
    context: AdapterContext,
  ): Promise<PageDecision> {
    void computer;
    const caller = request.signal ?? context.signal;
    if (caller.aborted) return { ...EMPTY, error: "cancelled" };

    const elements = request.elements.slice(0, MAX_ELEMENTS);
    const signal = AbortSignal.any([caller, AbortSignal.timeout(this.timeoutMs)]);

    const { answers, error } = await postSystemOne({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      model: this.model,
      signal,
      fetchImpl: this.fetchImpl,
      // The criteria map already names every element, so the state deliberately
      // does not repeat them: sending both would roughly double the bytes on
      // the hot path for no added signal.
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
        stuck: { type: "noul", instructions: "Is there no listed element that can progress?" },
        blocked: {
          type: "noul",
          instructions:
            "Is this page an interstitial needing a human, such as a bot check, two-factor prompt, or payment confirmation?",
        },
      },
    });

    if (!answers) return { ...EMPTY, error: error ?? "The decider returned no decision." };

    // Keep the whole ranking, not just the winner, so the policy's next-best
    // fallback has somewhere to fall. Options naming an element we did not
    // offer are dropped rather than trusted.
    const byRef = new Map(elements.map((element) => [element.ref, element]));
    const candidates = systemOneRanking(answers, "element").flatMap((entry) => {
      const element = byRef.get(entry.option);
      return element
        ? [{ ref: element.ref, kind: kindFor(element), confidence: entry.confidence }]
        : [];
    });

    return {
      candidates,
      goalMet: systemOneNoul(answers, "goalMet"),
      stuck: systemOneNoul(answers, "stuck"),
      blocked: systemOneNoul(answers, "blocked"),
    };
  }
}
```

- [ ] **Step 5: Point the Auto Review client at the shared plumbing**

In `packages/adapters/src/jev-auto-review.ts`, replace the local `JEV_URL`, `MAX_JSON_BYTES` and the inline `fetch`/`readBodyCapped`/`JSON.parse` block with `postSystemOne` from `./systemone-client.js`, keeping its question set, its `choiceAnswerSchema` semantics and every returned `AutoReviewResult` string exactly as they are. The behavior must not change.

Run: `pnpm vitest run packages/adapters/src/jev-auto-review.test.ts packages/adapters/src/auto-review.test.ts packages/adapters/src/auto-review-factory.test.ts`
Expected: PASS with no edits to those test files. If any assertion needs changing, the refactor changed behavior — revert and redo it.

- [ ] **Step 6: Record a real-endpoint fixture**

The response envelope above matches the client already in this repository, but it has not been verified for this question set. Verify it once, offline-capable:

```bash
# Self-hosted, no account needed. Run the open drop-in locally, then:
curl -s -X POST http://127.0.0.1:8000/v1/systemone \
  -H 'Content-Type: application/json' \
  -d '{"model":"jev-latest","state":"A signup page with an Email box and a Continue button.","questions":{"element":{"type":"choice","instructions":"Which element advances signup?","criteria":{"e1":"textbox: Email","e2":"button: Continue"}},"goalMet":{"type":"noul","instructions":"Is signup complete?"}}}' \
  | tee packages/adapters/src/__fixtures__/systemone-response.json
```

Compare against `systemOneResponseSchema`. If the envelope differs, change `parseSystemOneAnswers` in `systemone-client.ts` only, then re-run Step 2's tests. Commit the fixture — it contains no secret and no personal data.

- [ ] **Step 7: Run everything and add to conformance**

In `packages/adapters/src/page-decider-conformance.test.ts`, add the import and a case:

```typescript
import { SystemOnePageDecider } from "./systemone-page-decider.js";
```

```typescript
it("holds for systemone (offline, stubbed fetch)", async () => {
  await assertPageDeciderConformance(
    new SystemOnePageDecider({
      baseUrl: "https://decider.example.test",
      apiKey: "test-key",
      fetch: async () =>
        new Response(
          JSON.stringify({
            answers: {
              element: { type: "choice", choice: "e2", confidence: 0.9 },
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

- [ ] **Step 8: Export and commit**

Add to `packages/adapters/src/index.ts`:

```typescript
export * from "./systemone-client.js";
export * from "./systemone-page-decider.js";
```

Run: `pnpm --filter @rakazo/adapters check && pnpm lint`

```bash
git add packages/adapters/src/systemone-client.ts packages/adapters/src/systemone-page-decider.ts packages/adapters/src/systemone-page-decider.test.ts packages/adapters/src/jev-auto-review.ts packages/adapters/src/page-decider-conformance.test.ts packages/adapters/src/index.ts packages/adapters/src/__fixtures__/systemone-response.json
git commit -m "feat(adapters): add the systemone page decider over shared client plumbing"
```

---

### Task 5b: The `vision` backend

The self-hosted path. Any OpenAI-compatible vision endpoint; the reference target is Holo1.5-7B (Apache 2.0, open weights, Docker-served). Used in UI-VQA mode — screenshot plus numbered element list, pick one — because `BrowserSnapshotNode` carries no geometry to map a coordinate back to an element.

Reuses the prompt, response schema and parsing from Task 4 rather than restating them, so there is one definition of what a decision answer looks like regardless of which transport fetched it.

**Files:**
- Create: `packages/adapters/src/vision-page-decider.ts`
- Modify: `packages/adapters/src/model-page-decider.ts` (export the shared pieces), `packages/adapters/src/index.ts`, `packages/adapters/src/page-decider-conformance.test.ts`
- Test: `packages/adapters/src/vision-page-decider.test.ts`

**Interfaces:**
- Consumes: `PAGE_DECISION_SYSTEM`, `PAGE_DECISION_RESPONSE_SCHEMA`, `parsePageDecision` from Task 4; `assertDeciderBaseUrl` from Task 5.
- Produces: `VisionPageDecider`, `VisionPageDeciderOptions`. Task 6's factory constructs it.

- [ ] **Step 1: Export the shared pieces from Task 4**

In `packages/adapters/src/model-page-decider.ts`, rename and export the three constants so both backends share one definition:

```typescript
export const PAGE_DECISION_SYSTEM = SYSTEM;
export const PAGE_DECISION_RESPONSE_SCHEMA = RESPONSE_SCHEMA;

/**
 * Validate a decision answer, drop any ref that was not offered, and map a
 * point onto a ref when the model pointed instead of choosing.
 *
 * Mapping here rather than in the chain is what keeps coordinates out of the
 * `PageDecider` contract: the policy only ever sees refs, so geometry stays an
 * implementation detail of the backends that have it.
 */
export function parsePageDecision(
  raw: unknown,
  elements: readonly BrowserSnapshotNode[],
): PageDecision {
  const parsed = answerSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      candidates: [],
      goalMet: 0,
      stuck: 0,
      blocked: 0,
      error: "The decider model returned no decision.",
    };
  }

  const offered = new Set(elements.map((element) => element.ref));
  const candidates: PageDecisionCandidate[] = parsed.data.candidates
    .filter((candidate) => offered.has(candidate.ref))
    .map((candidate) => ({ ...candidate, source: "list" as const }));

  // Fall back to the point only when the list produced nothing usable, so a
  // confident named element is never overridden by a coordinate.
  if (candidates.length === 0 && parsed.data.point) {
    const hit = elementAtPoint(elements, parsed.data.point.x, parsed.data.point.y);
    if (hit) {
      candidates.push({
        ref: hit.ref,
        kind: parsed.data.point.kind,
        confidence: parsed.data.point.confidence,
        source: "point",
      });
    }
    // A point that maps to nothing yields no candidate. The policy escalates,
    // which is today's behavior; the chain never clicks a bare coordinate.
  }

  return {
    candidates,
    goalMet: parsed.data.goalMet,
    stuck: parsed.data.stuck,
    blocked: parsed.data.blocked,
  };
}

const POINT_TOLERANCE_PX = 12;

/**
 * The smallest element containing the point, else the nearest within a small
 * tolerance. Smallest-first matters because interactive elements nest: a point
 * inside a button inside a card should resolve to the button.
 */
export function elementAtPoint(
  elements: readonly BrowserSnapshotNode[],
  x: number,
  y: number,
): BrowserSnapshotNode | undefined {
  const withRect = elements.filter(
    (element): element is BrowserSnapshotNode & { rect: NonNullable<BrowserSnapshotNode["rect"]> } =>
      Boolean(element.rect),
  );
  if (withRect.length === 0) return undefined;

  const containing = withRect.filter(
    (element) =>
      x >= element.rect.x &&
      x <= element.rect.x + element.rect.width &&
      y >= element.rect.y &&
      y <= element.rect.y + element.rect.height,
  );
  if (containing.length > 0) {
    return containing.reduce((a, b) =>
      b.rect.width * b.rect.height < a.rect.width * a.rect.height ? b : a,
    );
  }

  let best: { element: BrowserSnapshotNode; distance: number } | undefined;
  for (const element of withRect) {
    const dx = Math.max(element.rect.x - x, 0, x - (element.rect.x + element.rect.width));
    const dy = Math.max(element.rect.y - y, 0, y - (element.rect.y + element.rect.height));
    const distance = Math.hypot(dx, dy);
    if (distance <= POINT_TOLERANCE_PX && (!best || distance < best.distance)) {
      best = { element, distance };
    }
  }
  return best?.element;
}
```

Then rewrite `ModelPageDecider.decide`'s parsing block to call `parsePageDecision(raw, request.elements)` and return its result, so the two backends cannot drift. The `model` backend never emits a `point` — it is not given a screenshot — so that branch simply never fires for it.

Run: `pnpm vitest run packages/adapters/src/model-page-decider.test.ts`
Expected: PASS unchanged — the `model` backend emits no `point`, so only the list branch runs for it.

- [ ] **Step 1b: Test the point mapping**

Append to `packages/adapters/src/model-page-decider.test.ts`:

```typescript
import { elementAtPoint, parsePageDecision } from "./model-page-decider.js";

const boxes = [
  { ref: "e1", role: "group", name: "Card", rect: { x: 0, y: 0, width: 300, height: 200 } },
  { ref: "e2", role: "button", name: "Continue", rect: { x: 20, y: 150, width: 100, height: 30 } },
  { ref: "e3", role: "textbox", name: "Email", rect: { x: 20, y: 60, width: 200, height: 24 } },
];

describe("elementAtPoint", () => {
  // Interactive elements nest, so a point inside a button inside a card must
  // resolve to the button, not the card.
  it("prefers the smallest containing element", () => {
    expect(elementAtPoint(boxes, 60, 160)?.ref).toBe("e2");
  });

  it("snaps to the nearest element just outside a rect", () => {
    expect(elementAtPoint(boxes, 20, 55)?.ref).toBe("e3");
  });

  it("returns nothing when the point is far from everything", () => {
    expect(elementAtPoint(boxes, 900, 900)).toBeUndefined();
  });

  // Review Focus 6: a computer image that predates geometry reports no rects.
  it("returns nothing when no element carries a rect", () => {
    expect(elementAtPoint([{ ref: "e1", role: "button", name: "Go" }], 10, 10)).toBeUndefined();
  });
});

describe("parsePageDecision point fallback", () => {
  it("maps a point onto a ref when the list is empty", () => {
    const result = parsePageDecision(
      { candidates: [], point: { x: 60, y: 160, kind: "click", confidence: 0.8 }, goalMet: 0, stuck: 0, blocked: 0 },
      boxes,
    );
    expect(result).toEqual({
      candidates: [{ ref: "e2", kind: "click", confidence: 0.8, source: "point" }],
      goalMet: 0,
      stuck: 0,
      blocked: 0,
    });
  });

  // A confident named element must never be overridden by a coordinate.
  it("ignores the point when the list already produced a candidate", () => {
    const result = parsePageDecision(
      {
        candidates: [{ ref: "e3", kind: "fill", confidence: 0.9 }],
        point: { x: 60, y: 160, kind: "click", confidence: 0.99 },
        goalMet: 0,
        stuck: 0,
        blocked: 0,
      },
      boxes,
    );
    expect(result).toMatchObject({
      candidates: [{ ref: "e3", kind: "fill", confidence: 0.9, source: "list" }],
    });
  });

  it("yields no candidate when the point maps to nothing", () => {
    const result = parsePageDecision(
      { candidates: [], point: { x: 900, y: 900, kind: "click", confidence: 0.99 }, goalMet: 0, stuck: 0, blocked: 0 },
      boxes,
    );
    expect(result).toMatchObject({ candidates: [] });
  });
});
```

Run: `pnpm vitest run packages/adapters/src/model-page-decider.test.ts`
Expected: PASS, all seven new cases.

- [ ] **Step 2: Write the failing tests**

Create `packages/adapters/src/vision-page-decider.test.ts`:

```typescript
import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { VisionPageDecider } from "./vision-page-decider.js";

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
  screenshot: { data: "aGVsbG8=", mimeType: "image/png" },
};

function completion(content: unknown, status = 200) {
  return async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }),
      { status, headers: { "Content-Type": "application/json" } },
    );
}

const answer = {
  candidates: [{ ref: "e2", kind: "click", confidence: 0.9 }],
  goalMet: 0,
  stuck: 0,
  blocked: 0,
};

describe("VisionPageDecider", () => {
  it("declares that it needs pixels", () => {
    const decider = new VisionPageDecider({
      baseUrl: "https://vision.example.test",
      fetch: completion(answer),
    });
    expect(decider.describe().id).toBe("vision");
    expect(decider.describe().capabilities.vision).toBe(true);
  });

  it("maps a well-formed completion onto a decision", async () => {
    const decider = new VisionPageDecider({
      baseUrl: "https://vision.example.test",
      fetch: completion(answer),
    });
    const decision = await decider.decide(computer, request, context);
    expect(decision.candidates).toEqual([{ ref: "e2", kind: "click", confidence: 0.9 }]);
  });

  it("sends the screenshot as an image part", async () => {
    let sent = "";
    const decider = new VisionPageDecider({
      baseUrl: "https://vision.example.test",
      fetch: async (_url, init) => {
        sent = String(init?.body ?? "");
        return new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }),
          { status: 200 },
        );
      },
    });
    await decider.decide(computer, request, context);
    expect(sent).toContain("image_url");
    expect(sent).toContain("data:image/png;base64,aGVsbG8=");
  });

  it("reports an error rather than deciding blind without a screenshot", async () => {
    const decider = new VisionPageDecider({
      baseUrl: "https://vision.example.test",
      fetch: completion(answer),
    });
    const { screenshot, ...noPixels } = request;
    void screenshot;
    const decision = await decider.decide(computer, noPixels, context);
    expect(decision.error).toBeTruthy();
    expect(decision.candidates).toEqual([]);
  });

  // Review Focus 6: a mixed fleet means some bots report no geometry at all.
  it("yields no candidate when the model points but nothing has a rect", async () => {
    const decider = new VisionPageDecider({
      baseUrl: "https://vision.example.test",
      fetch: completion({
        candidates: [],
        point: { x: 10, y: 10, kind: "click", confidence: 0.99 },
        goalMet: 0,
        stuck: 0,
        blocked: 0,
      }),
    });
    const decision = await decider.decide(computer, request, context);
    expect(decision.candidates).toEqual([]);
    expect(decision.error).toBeUndefined();
  });

  it("maps a point onto a ref when the elements carry rects", async () => {
    const decider = new VisionPageDecider({
      baseUrl: "https://vision.example.test",
      fetch: completion({
        candidates: [],
        point: { x: 30, y: 10, kind: "click", confidence: 0.8 },
        goalMet: 0,
        stuck: 0,
        blocked: 0,
      }),
    });
    const decision = await decider.decide(
      computer,
      {
        ...request,
        elements: [
          { ref: "e1", role: "button", name: "Continue", rect: { x: 0, y: 0, width: 80, height: 24 } },
        ],
      },
      context,
    );
    expect(decision.candidates).toEqual([
      { ref: "e1", kind: "click", confidence: 0.8, source: "point" },
    ]);
  });

  it("reports an error on a non-OK status", async () => {
    const decider = new VisionPageDecider({
      baseUrl: "https://vision.example.test",
      fetch: completion(answer, 503),
    });
    const decision = await decider.decide(computer, request, context);
    expect(decision.error).toBeTruthy();
  });

  it("drops a ref it was never offered", async () => {
    const decider = new VisionPageDecider({
      baseUrl: "https://vision.example.test",
      fetch: completion({ ...answer, candidates: [{ ref: "e9", kind: "click", confidence: 1 }] }),
    });
    const decision = await decider.decide(computer, request, context);
    expect(decision.candidates).toEqual([]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run packages/adapters/src/vision-page-decider.test.ts`
Expected: FAIL — cannot resolve `./vision-page-decider.js`.

- [ ] **Step 4: Write the adapter**

Create `packages/adapters/src/vision-page-decider.ts`:

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
import {
  PAGE_DECISION_RESPONSE_SCHEMA,
  PAGE_DECISION_SYSTEM,
  parsePageDecision,
} from "./model-page-decider.js";
import { readBodyCapped } from "./web-ssrf.js";

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_JSON_BYTES = 64_000;
const MAX_ELEMENTS = 240;

const VISION_POINT_SYSTEM = [
  "Each element also carries a rect in CSS pixels relative to the viewport,",
  "matching this screenshot's coordinate space.",
  "If a listed element fits the goal, name it in candidates.",
  "Only if none fits, set point to the x and y you would click.",
  "Never set both.",
].join(" ");

export interface VisionPageDeciderOptions {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const EMPTY: PageDecision = { candidates: [], goalMet: 0, stuck: 0, blocked: 0 };

/**
 * Any OpenAI-compatible vision endpoint, which is how an open-weight GUI
 * specialist is reached — Holo1.5-7B is the reference target.
 *
 * Used in UI-VQA mode (screen plus a numbered element list, pick one) rather
 * than coordinate localization, because BrowserSnapshotNode carries no geometry
 * to map a coordinate back to an element.
 */
export class VisionPageDecider implements PageDecider {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: VisionPageDeciderOptions) {
    this.baseUrl = options.baseUrl.trim();
    if (!this.baseUrl) throw new Error("A page decider base URL is required");
    this.apiKey = options.apiKey?.trim() || undefined;
    this.model = options.model?.trim() || "Hcompany/Holo1.5-7B";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? fetch;
  }

  describe(): AdapterDescriptor<PageDeciderCapabilities> {
    return {
      id: "vision",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { pick: true, scores: true, vision: true, keyless: !this.apiKey },
    };
  }

  async decide(
    computer: ComputerRef,
    request: PageDecisionRequest,
    context: AdapterContext,
  ): Promise<PageDecision> {
    void computer;
    const caller = request.signal ?? context.signal;
    if (caller.aborted) return { ...EMPTY, error: "cancelled" };

    // Deciding without the screen is guessing. Say so and let the policy escalate.
    if (!request.screenshot) {
      return { ...EMPTY, error: "The vision decider needs a screenshot." };
    }

    const elements = request.elements.slice(0, MAX_ELEMENTS);
    const signal = AbortSignal.any([caller, AbortSignal.timeout(this.timeoutMs)]);

    let response: Response;
    try {
      response = await this.fetchImpl(new URL("/v1/chat/completions", this.baseUrl).toString(), {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          response_format: {
            type: "json_schema",
            json_schema: { name: "page_decision", schema: PAGE_DECISION_RESPONSE_SCHEMA },
          },
          messages: [
            // The shared prompt covers the list pick. Only a vision backend can
            // point, so that instruction is appended here instead of polluting
            // the prompt the text backends also use.
            { role: "system", content: `${PAGE_DECISION_SYSTEM} ${VISION_POINT_SYSTEM}` },
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: {
                    url: `data:${request.screenshot.mimeType};base64,${request.screenshot.data}`,
                  },
                },
                {
                  type: "text",
                  text: JSON.stringify({
                    goal: request.goal,
                    origin: new URL(request.url).origin,
                    title: request.title,
                    elements,
                    history: request.history,
                  }),
                },
              ],
            },
          ],
        }),
      });
    } catch {
      return { ...EMPTY, error: "The vision decider timed out or failed." };
    }

    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return { ...EMPTY, error: "The vision decider returned an error." };
    }

    let content: unknown;
    try {
      const bytes = await readBodyCapped(response, MAX_JSON_BYTES, signal);
      const body = JSON.parse(new TextDecoder().decode(bytes)) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = body.choices?.[0]?.message?.content;
      if (typeof text !== "string") {
        return { ...EMPTY, error: "The vision decider returned no decision." };
      }
      content = JSON.parse(text);
    } catch {
      return { ...EMPTY, error: "The vision decider returned no decision." };
    }

    // Returns a PageDecision either way, with `error` set on a bad answer, so
    // there is no union to narrow here. `"error" in parsed` would not have been
    // a sound discriminant: PageDecision carries an optional error of its own.
    return parsePageDecision(content, elements);
  }
}
```

- [ ] **Step 5: Run tests and add to conformance**

Run: `pnpm vitest run packages/adapters/src/vision-page-decider.test.ts`
Expected: PASS, all six.

In `packages/adapters/src/page-decider-conformance.test.ts` add the import and a case. Note the conformance request has no `screenshot`, so this adapter is exercised through a wrapper that supplies one — which is exactly the caller's job in Task 9:

```typescript
import { VisionPageDecider } from "./vision-page-decider.js";
```

```typescript
it("holds for vision (offline, stubbed completion)", async () => {
  const inner = new VisionPageDecider({
    baseUrl: "https://vision.example.test",
    fetch: async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  candidates: [{ ref: "e2", kind: "click", confidence: 0.9 }],
                  goalMet: 0,
                  stuck: 0,
                  blocked: 0,
                }),
              },
            },
          ],
        }),
        { status: 200 },
      ),
  });
  // A vision adapter declares vision:true, so the caller owes it a screenshot.
  await assertPageDeciderConformance({
    describe: () => inner.describe(),
    decide: (c, req, ctx) =>
      inner.decide(c, { ...req, screenshot: { data: "aGk=", mimeType: "image/png" } }, ctx),
  });
});
```

- [ ] **Step 6: Export, check and commit**

Add `export * from "./vision-page-decider.js";` to `packages/adapters/src/index.ts`.

Run: `pnpm --filter @rakazo/adapters check && pnpm lint`

```bash
git add packages/adapters/src/vision-page-decider.ts packages/adapters/src/vision-page-decider.test.ts packages/adapters/src/model-page-decider.ts packages/adapters/src/page-decider-conformance.test.ts packages/adapters/src/index.ts
git commit -m "feat(adapters): add the vision page decider for self-hosted GUI models"
```

---

### Task 6: Factory and deployment default

**Files:**
- Create: `packages/adapters/src/page-decider-factory.ts`
- Modify: `packages/adapters/src/index.ts`
- Test: `packages/adapters/src/page-decider-factory.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 4, 5 adapters.
- Produces: `resolvePageDeciderKind(env?)`, `createPageDecider(kind?, options?)`, `PAGE_DECIDER_KIND_ENV = "RAKAZO_PAGE_DECIDER"`, `CreatePageDeciderOptions`. Task 7 calls `resolvePageDeciderKind`; Task 8 calls `createPageDecider`.

- [ ] **Step 1: Write the failing tests**

Create `packages/adapters/src/page-decider-factory.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { createPageDecider, resolvePageDeciderKind } from "./page-decider-factory.js";

const generate = async () => ({ candidates: [], goalMet: 0, stuck: 0, blocked: 0 });

describe("resolvePageDeciderKind", () => {
  it("defaults to model so an unconfigured deployment still works", () => {
    expect(resolvePageDeciderKind({})).toBe("model");
    expect(resolvePageDeciderKind({ RAKAZO_PAGE_DECIDER: "   " })).toBe("model");
  });

  it("reads a configured kind case-insensitively", () => {
    expect(resolvePageDeciderKind({ RAKAZO_PAGE_DECIDER: "SystemOne" })).toBe("systemone");
  });

  it("passes an unknown kind through so the factory can reject it by name", () => {
    expect(resolvePageDeciderKind({ RAKAZO_PAGE_DECIDER: "nope" })).toBe("nope");
  });
});

describe("createPageDecider", () => {
  it("builds the model decider by default", () => {
    expect(createPageDecider(undefined, { generate }).describe().id).toBe("model");
  });

  it("builds the fake decider", () => {
    expect(createPageDecider("fake", { generate }).describe().id).toBe("fake");
  });

  it("builds the systemone decider from a base URL", () => {
    const decider = createPageDecider("systemone", {
      generate,
      baseUrl: "https://decider.example.test",
      apiKey: "k",
    });
    expect(decider.describe().id).toBe("systemone");
  });

  it("refuses systemone without a base URL", () => {
    expect(() => createPageDecider("systemone", { generate })).toThrow(/base URL/i);
  });

  it("builds the vision decider from a base URL", () => {
    const decider = createPageDecider("vision", {
      generate,
      baseUrl: "https://vision.example.test",
    });
    expect(decider.describe().id).toBe("vision");
    expect(decider.describe().capabilities.vision).toBe(true);
  });

  it("refuses vision without a base URL", () => {
    expect(() => createPageDecider("vision", { generate })).toThrow(/base URL/i);
  });

  it("names an unknown kind in its error", () => {
    expect(() => createPageDecider("nope", { generate })).toThrow(/nope/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/adapters/src/page-decider-factory.test.ts`
Expected: FAIL — cannot resolve `./page-decider-factory.js`.

- [ ] **Step 3: Write the factory**

Create `packages/adapters/src/page-decider-factory.ts`:

```typescript
import type { PageDecider } from "@rakazo/adapter-kit";
import { FakePageDecider } from "./fake-page-decider.js";
import { ModelPageDecider, type StructuredGenerate } from "./model-page-decider.js";
import { SystemOnePageDecider } from "./systemone-page-decider.js";
import { VisionPageDecider } from "./vision-page-decider.js";

export const PAGE_DECIDER_KIND_ENV = "RAKAZO_PAGE_DECIDER";

export interface CreatePageDeciderOptions {
  generate: StructuredGenerate;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * The deployment default only. Per-bot and per-run selection overrides this;
 * see pageDeciderForRun. `model` is the default so a deployment with nothing
 * configured is still a working deployment.
 */
export function resolvePageDeciderKind(source: NodeJS.ProcessEnv = process.env): string {
  const raw = source[PAGE_DECIDER_KIND_ENV]?.trim().toLowerCase();
  if (!raw || raw === "model") return "model";
  return raw;
}

export function createPageDecider(
  kind?: string,
  options?: CreatePageDeciderOptions,
): PageDecider {
  const resolved = (kind ?? resolvePageDeciderKind()).trim() || "model";
  switch (resolved) {
    case "model":
      if (!options?.generate) throw new Error("The model page decider requires a generate call");
      return new ModelPageDecider({ generate: options.generate });
    case "systemone":
      if (!options?.baseUrl) throw new Error("The systemone page decider requires a base URL");
      return new SystemOnePageDecider({
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        model: options.model,
        timeoutMs: options.timeoutMs,
        fetch: options.fetch,
      });
    case "vision":
      if (!options?.baseUrl) throw new Error("The vision page decider requires a base URL");
      return new VisionPageDecider({
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        model: options.model,
        timeoutMs: options.timeoutMs,
        fetch: options.fetch,
      });
    case "fake":
      return new FakePageDecider();
    default:
      throw new Error(`Unknown page decider "${resolved}"`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/adapters/src/page-decider-factory.test.ts`
Expected: PASS, all eight.

- [ ] **Step 5: Export and commit**

Add `export * from "./page-decider-factory.js";` to `packages/adapters/src/index.ts`.

Run: `pnpm --filter @rakazo/adapters check && pnpm lint`

```bash
git add packages/adapters/src/page-decider-factory.ts packages/adapters/src/page-decider-factory.test.ts packages/adapters/src/index.ts
git commit -m "feat(adapters): add the page decider factory"
```

---

### Task 7: Per-bot and per-run selection, with the consent gate

The privacy-critical task. A bot pinned to a self-hosted decider must never be silently upgraded to a hosted one.

**Files:**
- Create: `packages/adapters/src/page-decider-selection.ts`
- Modify: `packages/db/prisma/schema.prisma`, `packages/adapters/src/index.ts`
- Test: `packages/adapters/src/page-decider-selection.test.ts`

**Interfaces:**
- Consumes: `resolvePageDeciderKind` from Task 6.
- Produces: `selectPageDecider(input: PageDeciderSelectionInput): PageDeciderSelection`, and the types `PageDeciderChoice`, `PageDeciderSelectionInput`, `PageDeciderSelection`. Task 8 calls `selectPageDecider`.

- [ ] **Step 1: Write the failing tests**

Create `packages/adapters/src/page-decider-selection.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { selectPageDecider } from "./page-decider-selection.js";

const hosted = { provider: "systemone", model: "jev-latest", external: true };
const local = { provider: "systemone", model: "local", external: false };

describe("selectPageDecider", () => {
  it("prefers the run choice over the bot choice", () => {
    expect(
      selectPageDecider({ run: local, bot: hosted, deploymentKind: "model", consented: true }),
    ).toEqual({ ok: true, choice: local });
  });

  it("falls back to the bot choice when the run has none", () => {
    expect(
      selectPageDecider({ run: null, bot: local, deploymentKind: "model", consented: true }),
    ).toEqual({ ok: true, choice: local });
  });

  it("falls back to the deployment default when neither is set", () => {
    expect(
      selectPageDecider({ run: null, bot: null, deploymentKind: "fake", consented: true }),
    ).toEqual({ ok: true, choice: { provider: "fake", model: null, external: false } });
  });

  it("falls back to model when nothing at all is configured", () => {
    expect(
      selectPageDecider({ run: null, bot: null, deploymentKind: "model", consented: false }),
    ).toEqual({ ok: true, choice: { provider: "model", model: null, external: false } });
  });

  // The failure this design must not have: a bot the operator believed was
  // private quietly becoming not private. Refuse, never downgrade silently.
  it("refuses an external choice without consent instead of falling back", () => {
    const result = selectPageDecider({
      run: null,
      bot: hosted,
      deploymentKind: "model",
      consented: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/consent/i);
  });

  it("refuses an external run override without consent", () => {
    const result = selectPageDecider({
      run: hosted,
      bot: local,
      deploymentKind: "model",
      consented: false,
    });
    expect(result.ok).toBe(false);
  });

  it("allows a self-hosted choice without consent", () => {
    expect(
      selectPageDecider({ run: null, bot: local, deploymentKind: "model", consented: false }),
    ).toEqual({ ok: true, choice: local });
  });

  it("refuses an external deployment default without consent", () => {
    const result = selectPageDecider({
      run: null,
      bot: null,
      deploymentKind: "systemone",
      deploymentExternal: true,
      consented: false,
    });
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/adapters/src/page-decider-selection.test.ts`
Expected: FAIL — cannot resolve `./page-decider-selection.js`.

- [ ] **Step 3: Write the selection module**

Create `packages/adapters/src/page-decider-selection.ts`:

```typescript
export interface PageDeciderChoice {
  provider: string;
  model: string | null;
  /** True when this choice sends page content outside the deployment. */
  external: boolean;
}

export interface PageDeciderSelectionInput {
  run: PageDeciderChoice | null;
  bot: PageDeciderChoice | null;
  deploymentKind: string;
  /** Whether the deployment default sends page content externally. */
  deploymentExternal?: boolean;
  /** Whether this space has consented to sharing page content externally. */
  consented: boolean;
}

export type PageDeciderSelection =
  | { ok: true; choice: PageDeciderChoice }
  | { ok: false; reason: string };

const CONSENT_REFUSAL =
  "This bot's page decider sends page content to an external service, which this space has not consented to. Choose a self-hosted decider or grant consent.";

/**
 * Resolve which decider a run uses: run override, then bot default, then the
 * deployment default, then `model`.
 *
 * Consent is checked on the *selected* choice and refuses rather than falling
 * back. A silent downgrade would mean a bot the operator believed was private
 * had quietly stopped being private, with no signal either way.
 */
export function selectPageDecider(input: PageDeciderSelectionInput): PageDeciderSelection {
  const choice: PageDeciderChoice =
    input.run ??
    input.bot ?? {
      provider: input.deploymentKind || "model",
      model: null,
      external: input.deploymentExternal ?? false,
    };

  if (choice.external && !input.consented) return { ok: false, reason: CONSENT_REFUSAL };
  return { ok: true, choice };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/adapters/src/page-decider-selection.test.ts`
Expected: PASS, all eight.

- [ ] **Step 5: Add the schema columns**

In `packages/db/prisma/schema.prisma`, in the `Bot` model, directly after the existing `modelId String?` line:

```prisma
  pageDeciderProvider String?
  pageDeciderModel    String?
```

In the `Run` model, directly after its existing `modelId String?` line, add the same two lines.

- [ ] **Step 6: Generate and migrate**

Run: `pnpm db:generate`
Expected: Prisma client regenerates with the four new optional fields.

Run: `pnpm db:migrate`
Expected: a new migration adding four nullable columns. Both columns on both tables must be nullable with no default, so the migration is additive and orders cleanly against upstream migrations.

- [ ] **Step 7: Export, check and commit**

Add `export * from "./page-decider-selection.js";` to `packages/adapters/src/index.ts`.

Run: `pnpm --filter @rakazo/adapters check && pnpm --filter @rakazo/db check && pnpm lint`

```bash
git add packages/adapters/src/page-decider-selection.ts packages/adapters/src/page-decider-selection.test.ts packages/adapters/src/index.ts packages/db/prisma/schema.prisma packages/db/prisma/migrations
git commit -m "feat: select the page decider per bot and per run, gated on consent"
```

---

### Task 8: Executor wiring

**Files:**
- Modify: `packages/adapters/src/executor.ts` (around line 2953, where `deps.browser` is defaulted)
- Test: `packages/adapters/src/page-decider-executor.test.ts`

**Interfaces:**
- Consumes: `createPageDecider` (Task 6), `selectPageDecider` (Task 7), `ModelPageDecider`'s `StructuredGenerate` (Task 4).
- Produces: `deps.pageDecider?: PageDecider` on the executor dependency object, defaulted exactly as `deps.browser` is. Task 9 reads it.

- [ ] **Step 1: Write the failing test**

Create `packages/adapters/src/page-decider-executor.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { FakePageDecider } from "./fake-page-decider.js";
import { pageDeciderFromDeps } from "./executor.js";

const generate = async () => ({ candidates: [], goalMet: 0, stuck: 0, blocked: 0 });

describe("pageDeciderFromDeps", () => {
  it("uses an injected decider unchanged", () => {
    const injected = new FakePageDecider();
    expect(pageDeciderFromDeps({ pageDecider: injected, generate })).toBe(injected);
  });

  it("defaults to the model decider when none is injected", () => {
    expect(pageDeciderFromDeps({ generate }).describe().id).toBe("model");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/adapters/src/page-decider-executor.test.ts`
Expected: FAIL — `pageDeciderFromDeps` is not exported from `./executor.js`.

- [ ] **Step 3: Add the helper and the default**

In `packages/adapters/src/executor.ts`, add an exported helper next to the existing browser defaulting:

```typescript
export function pageDeciderFromDeps(deps: {
  pageDecider?: PageDecider;
  generate: StructuredGenerate;
}): PageDecider {
  return deps.pageDecider ?? createPageDecider(undefined, { generate: deps.generate });
}
```

Add `pageDecider?: PageDecider` to the executor's dependency type beside `browser`, and at line 2953, directly after the existing `const browser = …` line:

```typescript
  const pageDecider = pageDeciderFromDeps({ pageDecider: deps.pageDecider, generate });
```

where `generate` is a `StructuredGenerate` built from the run's resolved model through the existing Pi structured-output path — the same path `deps.runtime` already uses. Use `request.resolveModel` when `selectPageDecider` returns a choice whose provider is not `model`, so the decider's connection is resolved under the run's own user and space scope.

Add the imports at the top of the file, top-level `import type` for types:

```typescript
import type { PageDecider } from "@rakazo/adapter-kit";
import { createPageDecider } from "./page-decider-factory.js";
import type { StructuredGenerate } from "./model-page-decider.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/adapters/src/page-decider-executor.test.ts`
Expected: PASS, both cases.

- [ ] **Step 5: Validate a configured base URL before constructing the adapter**

Task 5 defines `assertDeciderBaseUrl` but nothing calls it yet. The call belongs here, because this is where `prisma` and the acting user exist — the same place `mcp-connector.ts:447` resolves its own private-endpoint permission.

Add to `packages/adapters/src/page-decider-executor.test.ts`:

```typescript
it("refuses a loopback decider for an actor without the private-endpoint permission", async () => {
  await expect(
    resolveDeciderConnection({
      choice: { provider: "systemone", model: null, external: false },
      baseUrl: "http://127.0.0.1:8000",
      allowPrivate: false,
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    }),
  ).rejects.toThrow(/private/i);
});

it("allows a loopback decider for an actor with the permission", async () => {
  await expect(
    resolveDeciderConnection({
      choice: { provider: "systemone", model: null, external: false },
      baseUrl: "http://127.0.0.1:8000",
      allowPrivate: true,
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    }),
  ).resolves.toMatchObject({ baseUrl: "http://127.0.0.1:8000" });
});

it("needs no URL check for the model backend", async () => {
  await expect(
    resolveDeciderConnection({
      choice: { provider: "model", model: null, external: false },
      allowPrivate: false,
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    }),
  ).resolves.toMatchObject({ provider: "model" });
});
```

Run it and watch it fail on the missing export, then add to `executor.ts`:

```typescript
export async function resolveDeciderConnection(input: {
  choice: PageDeciderChoice;
  baseUrl?: string;
  allowPrivate: boolean;
  resolve?: ResolveHostname;
  signal?: AbortSignal;
}): Promise<{ provider: string; model: string | null; baseUrl?: string }> {
  if (input.choice.provider === "model" || input.choice.provider === "fake") {
    return { provider: input.choice.provider, model: input.choice.model };
  }
  if (!input.baseUrl) throw new Error(`The ${input.choice.provider} page decider requires a base URL`);
  const url = await assertDeciderBaseUrl(
    input.baseUrl,
    { allowPrivate: input.allowPrivate },
    input.resolve,
    input.signal,
  );
  return { provider: input.choice.provider, model: input.choice.model, baseUrl: url.toString() };
}
```

In the run path at line 2953, pass `allowPrivate: await actorMayUsePrivateEndpoint(prisma, request.userId, allowPrivateEndpoint)` — the helper and the instance flag are already imported there (`executor.ts:304`).

Run: `pnpm vitest run packages/adapters/src/page-decider-executor.test.ts`
Expected: PASS, all five.

- [ ] **Step 6: Run the executor suite for regressions**

Run: `pnpm vitest run packages/adapters/src/executor.test.ts`
Expected: PASS with no edits to that file. The decider is constructed but not yet consulted, so nothing should change.

- [ ] **Step 7: Commit**

```bash
git add packages/adapters/src/executor.ts packages/adapters/src/page-decider-executor.test.ts
git commit -m "feat(adapters): default a page decider alongside the browser provider"
```

---

### Task 9: The chain, and the `goal` tool field

Wires decider + policy into the browser tool path. Owns Review Focus 5 and the chain half of Review Focus 4.

**Files:**
- Create: `packages/adapters/src/page-decision-chain.ts`
- Modify: `packages/adapters/src/browser-tools.ts`, `packages/adapters/src/builtin-tools.ts`, `packages/adapters/src/index.ts`
- Test: `packages/adapters/src/page-decision-chain.test.ts`

**Interfaces:**
- Consumes: `decidePageAction`, `DEFAULT_PAGE_DECISION_THRESHOLDS` (Task 2); `PageDecider` (Task 1); `BrowserProvider` (existing).
- Produces: `runPageDecisionChain(input: PageDecisionChainInput): Promise<PageDecisionChainResult>` and `normalizeGoal(value: unknown): string | undefined`. Task 10 calls both.

- [ ] **Step 1: Write the failing tests**

Create `packages/adapters/src/page-decision-chain.test.ts`:

```typescript
import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { FakeBrowserProvider } from "./fake-browser.js";
import { FakePageDecider } from "./fake-page-decider.js";
import { normalizeGoal, runPageDecisionChain } from "./page-decision-chain.js";

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

// Review Focus 5: a junk goal must mean "behave exactly as before", never
// "send junk to a third party".
describe("normalizeGoal", () => {
  it.each([
    ["undefined", undefined],
    ["a number", 42],
    ["empty", ""],
    ["whitespace", "   \n\t "],
  ])("treats %s as absent", (_label, value) => {
    expect(normalizeGoal(value)).toBeUndefined();
  });

  it("trims a usable goal", () => {
    expect(normalizeGoal("  press continue  ")).toBe("press continue");
  });

  it("caps an absurdly long goal", () => {
    expect(normalizeGoal("x".repeat(10_000))?.length).toBe(400);
  });
});

describe("runPageDecisionChain", () => {
  it("tells the model what it did, so the planner is not left blind", async () => {
    const browser = new FakeBrowserProvider({ pages });
    await browser.navigate(computer, { url: "https://example.test/form" }, context);
    const snapshot = await browser.snapshot(computer, {}, context);
    const button = snapshot.elements.find((el) => el.name.toLowerCase().includes("continue"))!;

    const result = await browserActFromTool(
      browser,
      computer,
      context,
      { actions: [{ kind: "click", ref: button.ref }], goal: "press continue" },
      {
        decider: new FakePageDecider({
          decisions: [
            { candidates: [{ ref: button.ref, kind: "click", confidence: 0.95 }] },
            { goalMet: 0.95 },
          ],
        }),
      },
    );
    expect(result).toMatchObject({ steps: 1 });
    expect((result as { acted: string[] }).acted[0]).toMatch(/continue/i);
  });

  it("adds no account when the chain acted zero times", async () => {
    const browser = new FakeBrowserProvider({ pages });
    const result = await browserNavigateFromTool(
      browser,
      computer,
      context,
      { url: "https://example.test/form", goal: "press continue" },
      { decider: new FakePageDecider({ decisions: [{ candidates: [] }] }) },
    );
    expect(result).not.toHaveProperty("steps");
    expect(result).not.toHaveProperty("acted");
  });

  it("acts while confident and reports the steps it took", async () => {
    const browser = new FakeBrowserProvider({ pages });
    await browser.navigate(computer, { url: "https://example.test/form" }, context);
    const snapshot = await browser.snapshot(computer, {}, context);
    const button = snapshot.elements.find((el) => el.name.toLowerCase().includes("continue"))!;

    const result = await runPageDecisionChain({
      browser,
      decider: new FakePageDecider({
        decisions: [
          { candidates: [{ ref: button.ref, kind: "click", confidence: 0.95 }] },
          { goalMet: 0.99 },
        ],
      }),
      computer,
      context,
      goal: "press continue",
      snapshot,
    });

    expect(result.outcome).toBe("done");
    expect(result.steps).toBe(1);
    expect(result.acted).toEqual(["Continue"]);
    expect(result.goalMetConfidence).toBe(0.99);
  });

  it("escalates without acting when the decider is unsure", async () => {
    const browser = new FakeBrowserProvider({ pages });
    await browser.navigate(computer, { url: "https://example.test/form" }, context);
    const snapshot = await browser.snapshot(computer, {}, context);

    const result = await runPageDecisionChain({
      browser,
      decider: new FakePageDecider({
        decisions: [{ candidates: [{ ref: snapshot.elements[0]!.ref, kind: "click", confidence: 0.1 }] }],
      }),
      computer,
      context,
      goal: "press continue",
      snapshot,
    });

    expect(result.outcome).toBe("escalate");
    expect(result.steps).toBe(0);
  });

  it("escalates on a decider error without acting", async () => {
    const browser = new FakeBrowserProvider({ pages });
    await browser.navigate(computer, { url: "https://example.test/form" }, context);
    const snapshot = await browser.snapshot(computer, {}, context);

    const result = await runPageDecisionChain({
      browser,
      decider: new FakePageDecider({ error: "timeout" }),
      computer,
      context,
      goal: "press continue",
      snapshot,
    });

    expect(result.outcome).toBe("escalate");
    expect(result.steps).toBe(0);
  });

  it("reports takeover when the page looks like an interstitial", async () => {
    const browser = new FakeBrowserProvider({ pages });
    await browser.navigate(computer, { url: "https://example.test/form" }, context);
    const snapshot = await browser.snapshot(computer, {}, context);

    const result = await runPageDecisionChain({
      browser,
      decider: new FakePageDecider({ decisions: [{ blocked: 0.95 }] }),
      computer,
      context,
      goal: "press continue",
      snapshot,
    });

    expect(result.outcome).toBe("takeover");
  });

  // Review Focus 6, provider half: no capture means no accelerator, not a crash.
  it("escalates when a vision decider has no screenshot source", async () => {
    const browser = new FakeBrowserProvider({ pages });
    await browser.navigate(computer, { url: "https://example.test/form" }, context);
    const snapshot = await browser.snapshot(computer, {}, context);
    // Simulate a provider on a computer image that predates the capture.
    browser.noScreenshot = true;

    const decider = new FakePageDecider({ decisions: [{ candidates: [] }] });
    // A vision-declaring decider that is never given pixels must not act.
    const visionLike = {
      describe: () => ({
        ...decider.describe(),
        capabilities: { ...decider.describe().capabilities, vision: true },
      }),
      decide: decider.decide.bind(decider),
    };

    const result = await runPageDecisionChain({
      browser,
      decider: visionLike,
      computer,
      context,
      goal: "press continue",
      snapshot,
    });

    expect(result.outcome).toBe("escalate");
    expect(result.steps).toBe(0);
    expect(decider.requests[0]?.screenshot).toBeUndefined();
  });

  // The spec requires logging the outcome, reason and scores, and never page
  // text, element names, or a URL beyond its origin.
  it("logs the decision without leaking page content", async () => {
    const browser = new FakeBrowserProvider({ pages });
    await browser.navigate(computer, { url: "https://example.test/form" }, context);
    const snapshot = await browser.snapshot(computer, {}, context);
    const events: unknown[] = [];

    await runPageDecisionChain({
      browser,
      decider: new FakePageDecider({ decisions: [{ goalMet: 0.99, stuck: 0.01 }] }),
      computer,
      context,
      goal: "press continue",
      snapshot,
      log: (event) => events.push(event),
    });

    expect(events).toHaveLength(1);
    const serialized = JSON.stringify(events);
    expect(serialized).toContain("done");
    expect(serialized).toContain("0.99");
    expect(serialized).toContain("https://example.test");
    expect(serialized).not.toContain("/form");
    // The account goes to the model; element names must never reach the log.
    expect(serialized).not.toContain("Continue");
    expect(serialized).not.toContain("press continue");
    expect(serialized).not.toContain("acted");
  });

  // Review Focus 4, chain half: an action whose result is uncertain may already
  // have taken effect. Stop and let the model observe; never replay it.
  it("stops the chain when an action reports an uncertain result", async () => {
    const browser = new FakeBrowserProvider({ pages });
    await browser.navigate(computer, { url: "https://example.test/form" }, context);
    const snapshot = await browser.snapshot(computer, {}, context);
    const button = snapshot.elements.find((el) => el.name.toLowerCase().includes("continue"))!;

    const original = browser.act.bind(browser);
    browser.act = async (c, request, ctx) => ({
      ...(await original(c, request, ctx)),
      uncertain: true,
    });

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

    expect(result.outcome).toBe("escalate");
    expect(result.uncertain).toBe(true);
    expect(decider.requests.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

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
  PageDecisionAttempt,
} from "@rakazo/adapter-kit";
import {
  DEFAULT_PAGE_DECISION_THRESHOLDS,
  decidePageAction,
  type PageDecisionThresholds,
} from "@rakazo/core";

const MAX_GOAL_CHARS = 400;
const MAX_EXCERPT_CHARS = 4_000;

/**
 * A goal is optional on the browser tools. Anything that is not usable text
 * means "absent", which skips the decider entirely and leaves behavior exactly
 * as it was before this feature existed.
 */
/**
 * One viewport capture for a vision decider, or undefined when this provider
 * cannot take one. Never throws: a missing screenshot is an escalation, not an
 * error the caller has to handle.
 */
async function captureViewport(
  input: PageDecisionChainInput,
): Promise<{ data: string; mimeType: string; scale?: number } | undefined> {
  if (!input.browser.screenshot) return undefined;
  try {
    const shot = await input.browser.screenshot(
      input.computer,
      { signal: input.context.signal },
      input.context,
    );
    if (shot.fallback || shot.error || !shot.data) return undefined;
    return { data: shot.data, mimeType: shot.mimeType, scale: shot.scale };
  } catch {
    return undefined;
  }
}

export function normalizeGoal(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, MAX_GOAL_CHARS);
}

/**
 * What a decision is allowed to record. Scores and the outcome are useful for
 * diagnosing a loop; page text, element names and the path are not, and a
 * logged URL is reduced to its origin.
 */
export interface PageDecisionLogEvent {
  outcome: string;
  reason?: string;
  origin: string;
  steps: number;
  goalMet: number;
  stuck: number;
  blocked: number;
  topConfidence: number | null;
}

export interface PageDecisionChainInput {
  browser: BrowserProvider;
  decider: PageDecider;
  computer: ComputerRef;
  context: AdapterContext;
  goal: string;
  snapshot: BrowserSnapshotResult;
  thresholds?: PageDecisionThresholds;
  now?: () => number;
  log?: (event: PageDecisionLogEvent) => void;
}

export interface PageDecisionChainResult {
  outcome: "done" | "escalate" | "takeover" | "refuse";
  reason?: string;
  steps: number;
  /**
   * The decider's own probability that the goal is met.
   *
   * Reported as a claim, never as a verdict. The decider that scored this is
   * the same one that chose the actions, so it is self-assessment; the
   * frontier model does the verifying, which is the "verify" the published
   * plan/classify/verify pattern calls for.
   */
  goalMetConfidence?: number;
  /**
   * Names of the elements acted on, in order.
   *
   * The chain compresses several steps into one tool call, so without this the
   * model cannot see what happened and may repeat work or act on a stale
   * picture of the page. The highest-scoring published system returns exactly
   * this: a concise description of what changed.
   */
  acted: string[];
  /** True when an action may have taken effect but its result was lost. */
  uncertain?: boolean;
  snapshot: BrowserSnapshotResult;
}

/**
 * Run confident steps back to back, stopping the moment the policy is not
 * sure. Every stop lands in behavior that existed before the decider, so the
 * worst case is the previous loop plus one cheap call.
 */
export async function runPageDecisionChain(
  input: PageDecisionChainInput,
): Promise<PageDecisionChainResult> {
  const thresholds = input.thresholds ?? DEFAULT_PAGE_DECISION_THRESHOLDS;
  const clock = input.now ?? (() => Date.now());
  const needsPixels = input.decider.describe().capabilities.vision;
  const started = clock();
  const history: PageDecisionAttempt[] = [];
  const acted: string[] = [];
  let snapshot = input.snapshot;
  let steps = 0;

  for (;;) {
    // Pixels come from the page browser's own viewport capture, so they share
    // the rects' coordinate space. A provider without it yields undefined and
    // the vision adapter reports that it cannot decide, which escalates.
    const screenshot = needsPixels ? await captureViewport(input) : undefined;
    const decision = await input.decider.decide(
      input.computer,
      {
        goal: input.goal,
        elements: snapshot.elements,
        excerpt: snapshot.tree.slice(0, MAX_EXCERPT_CHARS),
        url: snapshot.url,
        title: snapshot.title,
        history,
        screenshot,
        signal: input.context.signal,
      },
      input.context,
    );

    // The decider speaks element refs; the policy speaks opaque targets. The
    // whole adaptation is these three map calls, which is what keeps the
    // policy free of browser concepts and reusable by a desktop chain.
    const outcome = decidePageAction({
      decision: {
        ...decision,
        candidates: decision.candidates.map((candidate) => ({
          target: candidate.ref,
          kind: candidate.kind,
          confidence: candidate.confidence,
        })),
      },
      budget: { steps, elapsedMs: clock() - started },
      history: history.map((attempt) => ({
        target: attempt.ref,
        kind: attempt.kind,
        changed: attempt.changed,
      })),
      knownTargets: snapshot.elements.map((element) => element.ref),
      // The chain can only click: the decider never supplies text to type.
      // The policy uses this to skip a fill candidate and try the next click.
      dispatchableKinds: ["click"],
      thresholds,
    });

    const record = (stop: PageDecisionChainResult["outcome"], reason?: string) => {
      input.log?.({
        outcome: stop,
        reason,
        origin: new URL(snapshot.url).origin,
        steps,
        goalMet: decision.goalMet,
        stuck: decision.stuck,
        blocked: decision.blocked,
        topConfidence: decision.candidates[0]?.confidence ?? null,
      });
    };

    if (outcome.action === "done") {
      record("done");
      return { outcome: "done", steps, acted, goalMetConfidence: decision.goalMet, snapshot };
    }
    if (outcome.action === "takeover") {
      record("takeover", outcome.reason);
      return { outcome: "takeover", reason: outcome.reason, steps, acted, snapshot };
    }
    if (outcome.action === "refuse") {
      record("refuse", outcome.reason);
      return { outcome: "refuse", reason: outcome.reason, steps, acted, snapshot };
    }
    if (outcome.action === "escalate") {
      record("escalate", outcome.reason);
      return { outcome: "escalate", reason: outcome.reason, steps, acted, snapshot };
    }

    const before = snapshot.url + snapshot.tree;
    const chosenName =
      snapshot.elements.find((element) => element.ref === outcome.target)?.name ?? "";
    const result = await input.browser.act(
      input.computer,
      { actions: [{ kind: "click", ref: outcome.target }], signal: input.context.signal },
      input.context,
    );
    steps += 1;

    if (result.uncertain) {
      record("escalate", "uncertain");
      return { outcome: "escalate", reason: "uncertain", steps, acted, uncertain: true, snapshot };
    }
    if (!result.ok || result.fallback) {
      record("escalate", "act_failed");
      return { outcome: "escalate", reason: "act_failed", steps, acted, snapshot };
    }

    snapshot = {
      url: result.url,
      title: result.title,
      tree: result.tree ?? snapshot.tree,
      elements: result.elements ?? snapshot.elements,
    };
    history.push({
      ref: outcome.target,
      kind: "click",
      changed: before !== snapshot.url + snapshot.tree,
    });
    // Captured from the pre-act snapshot's element, which is the one the
    // decider chose. Names go to the model, never to the log.
    acted.push(chosenName || outcome.target);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/adapters/src/page-decision-chain.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Add the `goal` field to the two tool schemas**

In `packages/adapters/src/builtin-tools.ts`, in `browser_navigate`'s `inputSchema.properties` (line ~212), add after `url`:

```typescript
        goal: {
          type: "string",
          description:
            "Optional. What to accomplish on this page, so simple steps run without a screenshot. The result reports what was done and a goalMetConfidence to check against the page, not a guarantee.",
        },
```

In `browser_act`'s `inputSchema.properties` (line ~230), add alongside `actions`:

```typescript
        goal: {
          type: "string",
          description:
            "Optional. What to accomplish on this page, so simple steps run without a screenshot.",
        },
```

Leave both `required` arrays unchanged — `goal` is optional, and its absence must preserve current behavior exactly.

- [ ] **Step 6: Consult the chain from the browser tools**

**Pass the decider through `options`, never as a new positional argument.** Both tool functions are called positionally. `browserActFromTool` already takes an `options` object as its fifth parameter (`browser-tools.ts:75`), so `decider` joins it; `browserNavigateFromTool` has no options parameter yet, so one is **appended** last. Inserting a parameter after `browser` would break every existing call site.

```typescript
export interface BrowserToolDeciderOptions {
  decider?: PageDecider;
}

// browserNavigateFromTool: append, never insert.
export async function browserNavigateFromTool(
  browser: BrowserProvider,
  computer: ComputerRef,
  context: AdapterContext,
  args: Record<string, unknown>,
  options: BrowserToolDeciderOptions = {},
) { /* … */ }

// browserActFromTool: extend the options type it already has.
options: {
  resolveSecretFill?: ResolveSecretFill;
  redactions?: () => string[];
  decider?: PageDecider;
} = {},
```

Add one shared helper, so neither tool grows a second copy of this logic:

```typescript
/**
 * Run confident steps when the model supplied a goal. Returns undefined when
 * the decider should not run at all, which is the signal to return exactly
 * what the tool returned before this feature existed.
 */
async function chainForGoal(
  browser: BrowserProvider,
  computer: ComputerRef,
  context: AdapterContext,
  args: Record<string, unknown>,
  options: BrowserToolDeciderOptions,
): Promise<PageDecisionChainResult | undefined> {
  const goal = normalizeGoal(args.goal);
  if (!goal || !options.decider) return undefined;
  const snapshot = await browser.snapshot(computer, { signal: context.signal }, context);
  if (snapshot.fallback || snapshot.error) return undefined;
  return await runPageDecisionChain({
    browser,
    decider: options.decider,
    computer,
    context,
    goal,
    snapshot,
  });
}

/**
 * Render a chain result in the shape the calling tool already returns.
 *
 * This deliberately does not return the snapshot: `browser_navigate` answers
 * with `{url, title}` today, and widening that to a full tree would change a
 * tool contract the model already relies on. The chain only updates where we
 * landed and adds at most one flag.
 */
function formatChainResult<T extends { fallback?: "computer_act"; error?: string }>(
  base: T,
  chain: PageDecisionChainResult,
) {
  const landed = { ...base, url: chain.snapshot.url, title: chain.snapshot.title };

  // What changed, so the model can verify rather than take our word for it.
  // Empty when the chain acted zero times, which keeps a no-op chain's result
  // byte-identical to the pre-decider one.
  const account = chain.steps > 0 ? { steps: chain.steps, acted: chain.acted } : {};

  if (chain.outcome === "takeover") {
    return formatBrowserResult({ ...landed, ...account, takeover: true, reason: chain.reason });
  }
  if (chain.outcome === "done") {
    // A confidence, never `goalMet: true`. The decider that scored this also
    // chose the actions, so asserting it as fact would hand the model a cheap
    // model's opinion as an established result and remove the verify step.
    return formatBrowserResult({
      ...landed,
      ...account,
      goalMetConfidence: chain.goalMetConfidence,
    });
  }
  if (chain.uncertain) {
    return formatBrowserResult({ ...landed, ...account, uncertain: true });
  }
  // escalate and refuse hand the page back, as before.
  return formatBrowserResult({ ...landed, ...account });
}
```

In `browserNavigateFromTool`, replace `return formatBrowserResult(result);` (line 41) with:

```typescript
    const chain = await chainForGoal(browser, computer, context, args, options);
    return chain ? formatChainResult(result, chain) : formatBrowserResult(result);
```

In `browserActFromTool`, replace `return redactConnectorPayload(formatBrowserResult(result), options.redactions?.() ?? []);` (line 92) with:

```typescript
    const chain = await chainForGoal(browser, computer, context, args, options);
    const payload = chain ? formatChainResult(result, chain) : formatBrowserResult(result);
    return redactConnectorPayload(payload, options.redactions?.() ?? []);
```

**Redaction must stay outside the branch.** `browserActFromTool` redacts its payload today; routing a chain result around `redactConnectorPayload` would be a silent regression in the one path that handles saved logins.

Add the imports at the top of the file, types separately per the global constraints:

```typescript
import type { PageDecider } from "@rakazo/adapter-kit";
import type { PageDecisionChainResult } from "./page-decision-chain.js";
import { normalizeGoal, runPageDecisionChain } from "./page-decision-chain.js";
```

- [ ] **Step 7: Pin the two contracts this step could silently break**

Append to `packages/adapters/src/page-decision-chain.test.ts`:

```typescript
describe("browser tool integration", () => {
  // browser_navigate answers with {url,title} today. A chain that ran must not
  // widen that into a snapshot, or the model's expectations change under it.
  it("keeps browser_navigate's result shape when a chain runs", async () => {
    const browser = new FakeBrowserProvider({ pages });
    const result = await browserNavigateFromTool(
      browser,
      computer,
      context,
      { url: "https://example.test/form", goal: "press continue" },
      { decider: new FakePageDecider({ decisions: [{ goalMet: 0.99 }] }) },
    );
    // Assert the absences, not an exact key set: a provider may include
    // `fallback: undefined`, which would show up in Object.keys.
    expect(result).not.toHaveProperty("tree");
    expect(result).not.toHaveProperty("elements");
    // A claim, not a verdict: the model must be able to disagree with it.
    expect(result).toMatchObject({ goalMetConfidence: 0.99 });
    expect(result).not.toHaveProperty("goalMet");
  });

  it("returns exactly the old shape when no goal is supplied", async () => {
    const browser = new FakeBrowserProvider({ pages });
    const withDecider = await browserNavigateFromTool(
      browser,
      computer,
      context,
      { url: "https://example.test/form" },
      { decider: new FakePageDecider({ decisions: [{ goalMet: 0.99 }] }) },
    );
    const without = await browserNavigateFromTool(browser, computer, context, {
      url: "https://example.test/form",
    });
    expect(withDecider).toEqual(without);
  });

  // rakazo already couples the page-browser and desktop paths: a successful
  // browser mutation clears the desktop visual-loop streak, because the live
  // view can change without a new desktop frame. That reset reads `error`,
  // `fallback` and `ok`, so a chain result must keep those three meaning what
  // they meant before, or the desktop loop guard silently mis-fires.
  it("keeps the desktop visual-loop reset working after a chain", async () => {
    const browser = new FakeBrowserProvider({ pages });
    await browser.navigate(computer, { url: "https://example.test/form" }, context);
    const snapshot = await browser.snapshot(computer, {}, context);
    const button = snapshot.elements.find((el) => el.name.toLowerCase().includes("continue"))!;

    const result = await browserActFromTool(
      browser,
      computer,
      context,
      { actions: [{ kind: "click", ref: button.ref }], goal: "press continue" },
      {
        decider: new FakePageDecider({
          decisions: [
            { candidates: [{ ref: button.ref, kind: "click", confidence: 0.95 }] },
            { goalMet: 0.95 },
          ],
        }),
      },
    );

    const streak = unchangedVisualStreakAfterPageBrowser(
      { frameId: "f1", actionKey: "k", count: 3 },
      "browser_act",
      result,
    );
    expect(streak.count).toBe(0);
  });

  it("does not clear the desktop streak when the chain's action failed", async () => {
    const browser = new FakeBrowserProvider({ pages });
    await browser.navigate(computer, { url: "https://example.test/form" }, context);
    const snapshot = await browser.snapshot(computer, {}, context);
    browser.actError = new Error("click failed");

    const result = await browserActFromTool(
      browser,
      computer,
      context,
      { actions: [{ kind: "click", ref: snapshot.elements[0]!.ref }], goal: "press continue" },
      { decider: new FakePageDecider({ decisions: [{ candidates: [] }] }) },
    );

    const streak = unchangedVisualStreakAfterPageBrowser(
      { frameId: "f1", actionKey: "k", count: 3 },
      "browser_act",
      result,
    );
    expect(streak.count).toBe(3);
  });

  // The act path redacts saved-login values. A chain result must not go around it.
  it("still redacts the payload when a chain runs", async () => {
    const browser = new FakeBrowserProvider({ pages });
    await browser.navigate(computer, { url: "https://example.test/form" }, context);
    const snapshot = await browser.snapshot(computer, {}, context);
    const button = snapshot.elements.find((el) => el.name.toLowerCase().includes("continue"))!;

    const result = await browserActFromTool(
      browser,
      computer,
      context,
      { actions: [{ kind: "click", ref: button.ref }], goal: "press continue" },
      {
        decider: new FakePageDecider({ decisions: [{ goalMet: 0.99 }] }),
        redactions: () => ["example.test"],
      },
    );
    expect(JSON.stringify(result)).not.toContain("example.test");
  });
});
```

Add to that file's imports:

```typescript
import { browserActFromTool, browserNavigateFromTool } from "./browser-tools.js";
import { unchangedVisualStreakAfterPageBrowser } from "./computer-tools.js";
```

Run: `pnpm vitest run packages/adapters/src/page-decision-chain.test.ts`
Expected: PASS. The second test is the important one — it asserts the decider is genuinely removable.

- [ ] **Step 8: Run the browser suites for regressions**

Run: `pnpm vitest run packages/adapters/src/browser-tools.test.ts packages/adapters/src/browser-conformance.test.ts packages/adapters/src/page-browser-login-fill.test.ts`
Expected: PASS with no edits to those files. No existing call passes a `goal`, so every existing path must be byte-identical in behavior.

- [ ] **Step 9: Export, check and commit**

Add `export * from "./page-decision-chain.js";` to `packages/adapters/src/index.ts`.

Run: `pnpm --filter @rakazo/adapters check && pnpm lint`

```bash
git add packages/adapters/src/page-decision-chain.ts packages/adapters/src/page-decision-chain.test.ts packages/adapters/src/browser-tools.ts packages/adapters/src/builtin-tools.ts packages/adapters/src/index.ts
git commit -m "feat(adapters): run confident browser steps through the page decider"
```

---

### Task 10: Replay suite and calibration harness

Where "both, equally" is enforced and where the accuracy floor and the call-reduction target are measured.

**Files:**
- Create: `packages/testkit/src/page-decider-replay.ts`, `packages/testkit/src/page-decider-replay.test.ts`, `packages/testkit/src/cli/page-decider-calibrate.ts`, `packages/testkit/src/__fixtures__/page-decider/*.json`
- Modify: `package.json` (one script)

**Interfaces:**
- Consumes: `runPageDecisionChain`, `FakePageDecider`, `ModelPageDecider`, `SystemOnePageDecider`, `FakeBrowserProvider`.
- Produces: `replayPageDeciderCase(fixture, decider)` and `PAGE_DECIDER_FIXTURES`.

- [ ] **Step 1: Write the fixtures**

Create `packages/testkit/src/__fixtures__/page-decider/confident-click.json`:

```json
{
  "name": "confident-click",
  "goal": "press continue",
  "page": {
    "url": "https://example.test/form",
    "title": "Signup",
    "html": "<!doctype html><html><head><title>Signup</title></head><body><label>Email <input id=\"email\" name=\"email\" /></label><button type=\"submit\">Continue</button></body></html>"
  },
  "seeded": [
    { "candidates": [{ "ref": "e2", "kind": "click", "confidence": 0.95 }] },
    { "goalMet": 0.99 }
  ],
  "expect": { "outcome": "done", "maxSteps": 1 }
}
```

Create `packages/testkit/src/__fixtures__/page-decider/bot-wall.json`:

```json
{
  "name": "bot-wall",
  "goal": "read the article",
  "page": {
    "url": "https://example.test/checking",
    "title": "Checking your browser",
    "html": "<!doctype html><html><head><title>Checking your browser</title></head><body><p>Verifying you are human.</p><button>Verify</button></body></html>"
  },
  "seeded": [{ "blocked": 0.95 }],
  "expect": { "outcome": "takeover", "maxSteps": 0 }
}
```

Create `packages/testkit/src/__fixtures__/page-decider/canvas-only.json`:

```json
{
  "name": "canvas-only",
  "goal": "open the menu",
  "page": {
    "url": "https://example.test/canvas",
    "title": "Canvas app",
    "html": "<!doctype html><html><head><title>Canvas app</title></head><body><canvas id=\"c\"></canvas></body></html>"
  },
  "seeded": [{ "candidates": [] }],
  "expect": { "outcome": "escalate", "maxSteps": 0 }
}
```

- [ ] **Step 2: Write the failing replay test**

Create `packages/testkit/src/page-decider-replay.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { PAGE_DECIDER_FIXTURES, replayPageDeciderCase } from "./page-decider-replay.js";

describe("page decider replay", () => {
  // "Both, equally": the same assertions must hold whichever backend answers.
  for (const backend of ["fake", "model", "systemone", "vision"] as const) {
    describe(`on the ${backend} backend`, () => {
      for (const fixture of PAGE_DECIDER_FIXTURES) {
        it(`matches ${fixture.name}`, async () => {
          const result = await replayPageDeciderCase(fixture, backend);
          expect(result.outcome).toBe(fixture.expect.outcome);
          expect(result.steps).toBeLessThanOrEqual(fixture.expect.maxSteps);
        });
      }
    });
  }

  it("never regresses below the escalation floor", async () => {
    for (const fixture of PAGE_DECIDER_FIXTURES) {
      const result = await replayPageDeciderCase(fixture, "fake");
      expect(["done", "escalate", "takeover", "refuse"]).toContain(result.outcome);
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run packages/testkit/src/page-decider-replay.test.ts`
Expected: FAIL — cannot resolve `./page-decider-replay.js`.

- [ ] **Step 4: Write the replay module**

Create `packages/testkit/src/page-decider-replay.ts`:

```typescript
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AdapterContext, ComputerRef, PageDecider, PageDecision } from "@rakazo/adapter-kit";
import {
  FakeBrowserProvider,
  FakePageDecider,
  ModelPageDecider,
  type PageDecisionChainResult,
  runPageDecisionChain,
  SystemOnePageDecider,
  VisionPageDecider,
} from "@rakazo/adapters";

export interface PageDeciderFixture {
  name: string;
  goal: string;
  page: { url: string; title: string; html: string };
  /** Index into the snapshot's elements, so a fixture never bakes in a ref. */
  seeded: ReadonlyArray<{
    candidates?: ReadonlyArray<{ index: number; kind: "click"; confidence: number }>;
    goalMet?: number;
    stuck?: number;
    blocked?: number;
  }>;
  expect: { outcome: PageDecisionChainResult["outcome"]; maxSteps: number };
}

export type PageDeciderBackend = "fake" | "model" | "systemone" | "vision";

const FIXTURE_DIR = fileURLToPath(new URL("./__fixtures__/page-decider/", import.meta.url));

export const PAGE_DECIDER_FIXTURES: PageDeciderFixture[] = readdirSync(FIXTURE_DIR)
  .filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(readFileSync(`${FIXTURE_DIR}${name}`, "utf8")) as PageDeciderFixture)
  .sort((a, b) => a.name.localeCompare(b.name));

const context: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

const computer: ComputerRef = { id: "c1", botId: "b1", kind: "fake", providerRef: "c1" };

/** Turn one seeded step into a full decision against the live element refs. */
function materialize(
  step: PageDeciderFixture["seeded"][number],
  refs: readonly string[],
): PageDecision {
  return {
    candidates: (step.candidates ?? [])
      .filter((candidate) => refs[candidate.index] !== undefined)
      .map((candidate) => ({
        ref: refs[candidate.index]!,
        kind: candidate.kind,
        confidence: candidate.confidence,
      })),
    goalMet: step.goalMet ?? 0,
    stuck: step.stuck ?? 0,
    blocked: step.blocked ?? 0,
  };
}

/**
 * Every backend answers from the same seeded script, so the three paths are
 * compared on identical decisions and the suite stays offline. This is where
 * "both, equally" is enforced: the assertions do not vary by backend.
 */
function deciderFor(
  backend: PageDeciderBackend,
  decisions: readonly PageDecision[],
): PageDecider {
  let cursor = 0;
  const next = (): PageDecision =>
    decisions[Math.min(cursor++, decisions.length - 1)] ?? {
      candidates: [],
      goalMet: 0,
      stuck: 0,
      blocked: 0,
    };

  if (backend === "fake") return new FakePageDecider({ decisions: [...decisions] });

  if (backend === "model") {
    return new ModelPageDecider({ generate: async () => next() });
  }

  if (backend === "vision") {
    return new VisionPageDecider({
      baseUrl: "https://vision.example.test",
      fetch: async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify(next()) } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    });
  }

  return new SystemOnePageDecider({
    baseUrl: "https://decider.example.test",
    apiKey: "test-key",
    fetch: async () => {
      const decision = next();
      // Report the full ranking, as the real endpoint does, so the replay
      // exercises the same candidate path production will take.
      return new Response(
        JSON.stringify({
          answers: {
            ...(decision.candidates.length > 0
              ? {
                  element: {
                    type: "choice",
                    choice: decision.candidates[0]!.ref,
                    confidence: decision.candidates[0]!.confidence,
                    probabilities: Object.fromEntries(
                      decision.candidates.map((c) => [c.ref, c.confidence]),
                    ),
                  },
                }
              : {}),
            goalMet: { type: "noul", noul: decision.goalMet },
            stuck: { type: "noul", noul: decision.stuck },
            blocked: { type: "noul", noul: decision.blocked },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });
}

export async function replayPageDeciderCase(
  fixture: PageDeciderFixture,
  backend: PageDeciderBackend,
): Promise<PageDecisionChainResult & { deciderCalls: number }> {
  const browser = new FakeBrowserProvider({
    pages: { [fixture.page.url]: { title: fixture.page.title, html: fixture.page.html } },
  });
  await browser.navigate(computer, { url: fixture.page.url }, context);
  const snapshot = await browser.snapshot(computer, {}, context);
  const refs = snapshot.elements.map((element) => element.ref);
  const decisions = fixture.seeded.map((step) => materialize(step, refs));

  let deciderCalls = 0;
  const inner = deciderFor(backend, decisions);
  const counted: PageDecider = {
    describe: () => inner.describe(),
    decide: (c, request, ctx) => {
      deciderCalls += 1;
      return inner.decide(c, request, ctx);
    },
  };

  const result = await runPageDecisionChain({
    browser,
    decider: counted,
    computer,
    context,
    goal: fixture.goal,
    snapshot,
  });
  return { ...result, deciderCalls };
}
```

Update the three fixtures' `seeded` blocks to use `index` instead of `ref`, matching the type above. In `confident-click.json` the Continue button is the second interactive element, so:

```json
  "seeded": [
    { "candidates": [{ "index": 1, "kind": "click", "confidence": 0.95 }] },
    { "goalMet": 0.99 }
  ],
```

In `bot-wall.json` and `canvas-only.json` the `seeded` blocks need no candidates and are already correct.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run packages/testkit/src/page-decider-replay.test.ts`
Expected: PASS — three fixtures × three backends, plus the floor test.

- [ ] **Step 6: Measure the call reduction and the decision latency**

The spec's success criteria name two numbers no test above produces. Add them to `packages/testkit/src/page-decider-replay.test.ts`:

```typescript
it("reports the model handoffs the decider avoided", async () => {
  let handled = 0;
  let escalated = 0;
  for (const fixture of PAGE_DECIDER_FIXTURES) {
    const result = await replayPageDeciderCase(fixture, "fake");
    handled += result.steps;
    if (result.outcome === "escalate") escalated += 1;
  }
  // Before the decider, every step was a screenshot into the frontier model.
  // Steps the decider completed are handoffs that did not happen.
  const baseline = handled + escalated;
  const reduction = baseline === 0 ? 0 : handled / baseline;
  console.log(
    `page decider: ${handled} steps handled, ${escalated} escalations, ${(reduction * 100).toFixed(0)}% of calls avoided`,
  );
  expect(baseline).toBeGreaterThan(0);
});

it("decides fast enough to be worth the extra call", async () => {
  const started = performance.now();
  for (const fixture of PAGE_DECIDER_FIXTURES) {
    await replayPageDeciderCase(fixture, "fake");
  }
  const perCase = (performance.now() - started) / PAGE_DECIDER_FIXTURES.length;
  console.log(`page decider: ${perCase.toFixed(1)}ms per case in process`);
  // In-process only — it bounds our own overhead, not a provider's latency.
  // The hosted and self-hosted medians come from the calibration harness
  // against real traffic, which is where the spec's 500ms target is judged.
  expect(perCase).toBeLessThan(500);
});
```

Run: `pnpm vitest run packages/testkit/src/page-decider-replay.test.ts`
Expected: PASS, with both numbers printed. Record them in the PR description. Three fixtures is a floor check, not a benchmark — say so in the PR rather than quoting the percentage as the spec's 50% target met.

- [ ] **Step 7: Write the calibration harness**

Create `packages/testkit/src/cli/page-decider-calibrate.ts`: a script, not a test. It reads labeled fixtures from a directory given as `--fixtures <dir>`, sweeps each threshold in `DEFAULT_PAGE_DECISION_THRESHOLDS` across `0.5…0.95` in steps of `0.05`, and prints one table per threshold with true/false positives and negatives against each fixture's labeled expectation, so a threshold is chosen from data. It must print the false-takeover count as its own column, because interrupting a person is the cost that must never be traded silently for recall.

Add to root `package.json` scripts, after `test:evals`:

```json
    "test:page-decider-calibrate": "tsx packages/testkit/src/cli/page-decider-calibrate.ts",
```

- [ ] **Step 8: Run the harness on the fixtures**

Run: `pnpm test:page-decider-calibrate --fixtures packages/testkit/src/__fixtures__/page-decider`
Expected: a table per threshold. Three fixtures is too few to calibrate from — the harness working is the deliverable here, not a tuned number. Record in the PR that the defaults remain the published starting points until real traffic is replayed.

- [ ] **Step 9: Commit**

```bash
git add packages/testkit/src/page-decider-replay.ts packages/testkit/src/page-decider-replay.test.ts packages/testkit/src/cli/page-decider-calibrate.ts packages/testkit/src/__fixtures__/page-decider package.json
git commit -m "test: replay the page decider across both configurations"
```

---

### Task 11: The settings picker

The only user-facing addition. Progressively disclosed: it renders only once a bot has a computer that can run the page browser.

**Files:**
- Modify: `apps/web/src/pages/ModelSettingsOverlay.tsx` — the overlay that already edits `modelProvider` / `modelId` / `thinkingLevel`.
- Test: `apps/web/src/pages/shell/bot-settings.test.tsx`.
- Read first: `apps/web/src/pages/shell/bot-panel.tsx`, which renders the overlay, to see how the bot and its computer reach it.

**Interfaces:**
- Consumes: the two `Bot` columns from Task 7.
- Produces: no new exported API; a form control bound to `pageDeciderProvider` / `pageDeciderModel`.

- [ ] **Step 1: Read the existing control**

Read `apps/web/src/pages/ModelSettingsOverlay.tsx` and note the exact `packages/ui-web` components its model picker uses — reuse those, do not introduce new ones. Then read `apps/web/src/pages/shell/bot-panel.tsx` to see how the bot and its computer reach the overlay, which is what the disclosure condition reads.

- [ ] **Step 2: Write the failing test**

In `apps/web/src/pages/shell/bot-settings.test.tsx`, add (matching that file's existing render helper and prop shapes rather than the placeholders below):

```typescript
it("hides the decider picker for a bot with no page browser", () => {
  render(<BotModelSettings bot={{ ...bot, computer: null }} />);
  expect(screen.queryByLabelText(/decider/i)).toBeNull();
});

it("offers the decider picker once the bot has a capable computer", () => {
  render(<BotModelSettings bot={{ ...bot, computer: { pageBrowser: true } }} />);
  expect(screen.getByLabelText(/decider/i)).toBeInTheDocument();
});

it("defaults to the bot's own model", () => {
  render(<BotModelSettings bot={{ ...bot, computer: { pageBrowser: true } }} />);
  expect(screen.getByLabelText(/decider/i)).toHaveTextContent(/this bot's model/i);
});
```

Adjust the component name, props and render helper to match what Step 1 found.

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run apps/web/src/pages/shell/bot-settings.test.tsx`
Expected: FAIL — no element matching `/decider/i`.

- [ ] **Step 4: Add the control**

Add a select beside the existing model picker, using the same `packages/ui-web` select the model picker uses. Requirements:

- Rendered only when the bot's computer reports the page browser contract.
- Options: one default reading `This bot's model`, plus each configured decider connection by its own name.
- Accessible name: `Page decider`. No body copy, no helper text, no tooltip — the options carry the meaning.
- Colors from `@rakazo/ui-tokens` semantic tokens only. No hex, no `[var(--…)]`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run apps/web/src/pages/shell/bot-settings.test.tsx`
Expected: PASS, all three.

- [ ] **Step 6: Add the screen to the web E2E so CI captures it**

Ensure a web test opens the bot settings screen, so the CI E2E screenshot shows the control and can be linked on the PR, as `AGENTS.md` requires for UI changes. If no such test exists, add one that navigates to bot settings and asserts the model picker is visible.

- [ ] **Step 7: Full check and commit**

Run: `pnpm lint && pnpm test && pnpm check`
Expected: clean.

```bash
git add apps/web/src/pages/ModelSettingsOverlay.tsx apps/web/src/pages/shell/bot-settings.test.tsx
git commit -m "feat(web): choose a page decider per bot"
```

---

## Final verification

- [ ] `pnpm lint` — clean
- [ ] `pnpm test` — all suites pass
- [ ] `pnpm check` — no type errors in any package
- [ ] `pnpm vitest run packages/adapters/src/page-decider-conformance.test.ts` — every adapter conforms
- [ ] `pnpm vitest run packages/testkit/src/page-decider-replay.test.ts` — both configurations, same assertions
- [ ] `git log --oneline` — one commit per task, no secrets, no local paths or personal data in any message
- [ ] PR description: why / what / how tested, quoting the one line of new UI copy (`Page decider`, `This bot's model`) and saying why it cannot be shorter, with the CI E2E screenshot of the settings screen linked
