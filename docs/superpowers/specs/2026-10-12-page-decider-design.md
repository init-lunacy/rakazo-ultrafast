# Page decider: a fast decision slot for the browser loop

Status: design, approved for planning
Date: 2026-10-12

## Why

Today a browser task spends most of its time and money in one place: round-tripping
screenshots into a frontier vision model to answer small, repetitive questions —
*which element do I click*, *did that work*, *am I stuck*. The model that plans the
task is also the model that makes every mechanical per-click decision, and it makes
them from pixels.

Those per-step questions are typed decisions over an enumerated candidate list. They
do not need a frontier model and they do not need pixels. Published browser-agent
work puts them behind a fast decision model and reports order-of-magnitude drops in
calls per task while finishing in seconds rather than minutes.

This design adds a provider-neutral slot for those decisions, keeps the frontier
model for planning and verification, and keeps pixels in the loop where the evidence
says they earn their cost.

## Intent and success criteria

The goal is a browser loop that is faster and no less accurate, that works with no
hosted vendor at all, and that hands a bot-wall to the human quickly and reliably.
The split between the fast decider and the planning model must be invisible to the
user and to the bot's model.

Success is measured, not asserted:

- **Accuracy floor, absolute.** Task success on the replay suite does not regress
  against the current loop. The design guarantees this structurally: every decider
  outcome other than a confident pick falls through to today's behavior, so the
  worst case is the current loop plus one cheap call.
- **Fewer expensive calls.** Vision-model calls per completed browser task drop
  materially. Target: at least a 50% reduction on the replay suite. The published
  comparable is roughly a tenth, on a task shape we have not replicated, so 50% is
  the bar to clear, not the ceiling to expect.
- **Decision latency.** Median per-step decision under 500ms on the hosted
  configuration; recorded and reported, not capped, on the self-hosted one.
- **Bot-wall handling.** On a labeled set of interstitials, recall at the configured
  threshold is reported alongside the false-takeover rate. A false takeover
  interrupts a person, so it is tracked as its own number and never traded silently
  for recall.
- **Both configurations pass the same suite.** Self-hosted and hosted are both
  first-class. The conformance suite is identical for both.

## Research basis

Three findings shaped this design, and two of them cut against the obvious approach.

**The pattern is plan / classify / verify.** The frontier model interprets the goal
and verifies completion; a fast decision model picks one action per step from the
page's enumerated interactive elements and scores whether the goal is met or the run
is stuck; control returns to the frontier model when confidence drops or the decider
reports blocked. Reference implementation: `jkudish/jev-browser`. Reported
single-task figures there are ~4s and $0.0016 for a three-step Wikipedia
navigation. A separate reported comparison on a flight search dropped browser calls
from ~1,092 to ~101.

**The role split is what the benchmarks reward; the perception modality is not.**
An earlier draft of this spec justified keeping screenshots with WebVoyager's
multimodal 59.1% against accessibility-tree-only 40.1%. That figure is from the
original 2024 paper and the model generation of its time, and it does not support
the conclusion today. The current leaderboard:

| System | Score | Perception |
|---|---|---|
| browser-control (Claude Fable 5) | 99.19% | vision |
| Alumnium (Sonnet 4.6 orchestrating GPT-5 nano) | 98.5% | primarily accessibility trees |
| Surfer 2 (o3 + Sonnet 4.5 + GPT-4.1 + Holo1.5) | 97.1% | purely visual, no DOM |
| Magnitude (Sonnet 4) | 93.9% | modular agentic |
| Surfer-H + Holo1 | 92.2% | Holo1-7B policy, GPT-4o validation |

Both extremes clear 97%, so modality is not the deciding variable. What the top
systems share is this design's shape: multi-model orchestration with specialized
roles — a capable planner, a small fast specialist for per-step localization, and a
separate verification pass. Alumnium is a large model driving a tiny one. Surfer 2
uses Holo1.5-7B purely as a localizer beside large planners. That is the role this
spec gives the decider.

Vision therefore stays in the loop because a capable model reasoning over pixels is
proven, not because structure-only is disqualified.

**No benchmark exists for the typed-decision pick.** Everything published for the
Jev-style browser loop is single-task anecdote and one vendor's call-count
comparison. There is no WebVoyager or Online-Mind2Web figure for it. Every
benchmarked localizer in the table above is a *vision* model; Jev is text-only.
The success criteria above are therefore hypotheses the replay suite tests, not
results anyone has reproduced — which is the reason the decider is built as a
removable accelerator with a structural accuracy floor rather than as a new
default path.

**Do not copy the thresholds.** Confidence scores from any model are not calibrated
to our prevalence or our cost ratio. The act / hold / escalate / refuse policy
therefore lives in our code as a pure, tested function, with thresholds as
configuration and a calibration procedure. Published values (0.85, 0.7) are starting
points recorded as defaults, not constants to trust.

## What already exists

This is mostly wiring. The following are in the repository today:

- `BrowserProvider` and the `browser` registry slot — `packages/adapter-kit/src/interfaces.ts`,
  `packages/adapter-kit/src/registry.ts`.
- `browser_snapshot` returning a compact tree plus `BrowserSnapshotNode[]` element
  refs — `packages/adapter-kit/src/types.ts`, `BrowserSnapshotResult`.
- A working `/v1/systemone` client, used only as an Auto Review verifier —
  `packages/adapters/src/jev-auto-review.ts`.
- A keyless local OpenAI-compatible model provider and an operator-declared vision
  capability — `packages/adapters/src/pi-local-provider.ts`,
  `packages/adapters/src/model-modalities.ts`.
- The takeover machinery: the `request_takeover` builtin tool, the
  `waiting_takeover` run state, and resume — `packages/adapters/src/builtin-tools.ts`,
  `packages/core/src/run-state.ts`, `packages/adapters/src/takeover-resume.ts`.
- Offline conformance test conventions — `packages/adapters/src/browser-conformance.test.ts`.
- Payload bounding and redaction conventions — `packages/adapters/src/web-ssrf.ts`,
  `packages/adapters/src/connector-safety.ts`.

Nothing in the browser loop consults any of the decision machinery today. That is
the gap this design closes.

## Architecture

A new adapter slot, `page-decider`, sitting beside the existing `browser` slot. It
follows the established adapter shape exactly: a capabilities descriptor, a factory
that resolves a kind from configuration, and an offline conformance suite.

```text
browser_navigate / browser_act
        |
        v
BrowserProvider.snapshot  ->  elements[] + bounded text excerpt
        |
        v
PageDecider.decide(goal, elements, excerpt, history)
        |
        v
decidePageAction(decision, budget, thresholds)   <- pure policy, in core
        |
        +-- act       -> BrowserProvider.act (one step)
        +-- done      -> return to the model with the goal met
        +-- escalate  -> today's path: screenshot + the bot's own model
        +-- takeover  -> request_takeover / waiting_takeover
        +-- refuse    -> budget exhausted, hand back with what is known
```

The decider is strictly an accelerator. Every outcome except `act` and `done` lands
in behavior that exists today. Removing the slot restores the current loop exactly.

### Contract

New types in `packages/adapter-kit/src/types.ts`, new interface in
`packages/adapter-kit/src/interfaces.ts`:

```ts
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
   * A CDP viewport capture, in the same coordinate space as each element's
   * `rect`. Supplied only when the adapter declares `vision`, so a text-only
   * decider is never handed pixels and the cheap path stays cheap.
   */
  screenshot?: { data: string; mimeType: string; scale?: number };
  signal?: AbortSignal;
}

export interface PageDecisionCandidate {
  ref: string;
  kind: BrowserActKind;
  confidence: number;
  /** How this candidate was found. Calibration reads it; the policy ignores it. */
  source?: "list" | "point";
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

export interface PageDecider {
  describe(): AdapterDescriptor<PageDeciderCapabilities>;
  decide(
    computer: ComputerRef,
    request: PageDecisionRequest,
    context: AdapterContext,
  ): Promise<PageDecision>;
}
```

`BrowserActKind` is reused unchanged. Two deliberate exclusions:

- **The decider never produces text to type.** It returns a ref and a kind. For
  `fill` and `type`, the text comes from the bot's model, as it does today, or from
  `fill_secret`. This keeps one source of truth for typed content and keeps the
  decider out of the credential path entirely. This exclusion is absolute and is
  what keeps the decider out of the credential path no matter which backend runs.
- **A text-only decider never receives a screenshot.** The caller supplies
  `screenshot` only when the adapter declares `vision`, so the `systemone` path
  stays structural and fast while a vision localizer gets what it needs.
- **The decider always returns refs, never coordinates.** A vision adapter may ask
  its model to *point* when no listed element fits, but it maps that point to a ref
  itself before returning. Geometry therefore stays an implementation detail of the
  one backend that needs it: `PageDecider`, the policy and the chain are all
  unchanged by it. `PageDecisionCandidate` carries an optional
  `source?: "list" | "point"` purely so calibration can tell how often the point
  path fires and whether it is more or less reliable than the list path.

### Policy, in code

`packages/core/src/page-decision-policy.ts`, a pure function with no I/O:

```ts
export type PageDecisionOutcome =
  | { action: "act"; ref: string; kind: BrowserActKind }
  | { action: "done" }
  | { action: "escalate"; reason: "low_confidence" | "stuck" | "no_candidates" | "error" }
  | { action: "takeover"; reason: string }
  | { action: "refuse"; reason: "step_budget" | "time_budget" };

export function decidePageAction(
  decision: PageDecision,
  budget: { steps: number; elapsedMs: number },
  thresholds: PageDecisionThresholds,
): PageDecisionOutcome;
```

Evaluation order is fixed and tested, because the order is the policy:

1. Budget exhausted (`steps` or `elapsedMs` over limit) → `refuse`.
2. `blocked` at or above threshold → `takeover`. Checked before `stuck`, because an
   interstitial is a specific kind of stuck and the human handoff is the useful
   response to it.
3. `goalMet` at or above threshold → `done`.
4. `stuck` at or above threshold → `escalate`.
5. `decision.error` set, or no candidates at all → `escalate`.
6. Drop every candidate that repeats a prior attempt which did not change the page.
7. Drop every candidate whose kind the caller cannot dispatch. If that empties a
   non-empty set → `escalate` with `needs_text`; if nothing was addressable to begin
   with → `escalate` with `no_candidates`.
8. The best remaining candidate is below the confidence threshold → `escalate`.
9. Otherwise → `act` on the best remaining candidate.

The confidence threshold is applied last, to whichever candidate actually survives —
never to one the policy has already discarded.

Step 7 exists because the caller's dispatchable set is narrower than the decider's
vocabulary: the chain can only click, since the decider never supplies text to type.
Filtering inside the policy rather than rejecting afterwards is what keeps the ranked
fallback working — a `fill` candidate at the top no longer hides a clickable one just
below it. The two reasons are kept apart because they mean different things:
`needs_text` is a routine hand-back to the model, while `no_candidates` usually means
the page is not what we thought it was.

Stop conditions are evaluated before any action executes. `elapsedMs` is measured
from the start of the current browser leg, meaning the tool call that began this
decider chain, not from the start of the run.

Defaults, recorded as starting points requiring calibration:

| Threshold | Default | Source |
|---|---|---|
| `goalMet` | 0.85 | reference implementation, measured on two sites |
| `stuck` | 0.85 | reference implementation |
| `blocked` | 0.85 | same family; our own number comes from calibration |
| candidate confidence | 0.70 | published example value |
| step budget | 24 | reference implementation default |
| time budget | 180s | reference implementation default |

### Backends

Three real adapters plus a fake.

- **`model`** — asks the bot's existing model one structured question through the
  machinery already used for structured tool schemas. Requires no vendor and no key,
  so core keeps working with nothing configured. Its value is a dependency-free
  conformance baseline and a correct fallback, **not** speed: it will not be
  meaningfully faster than today's loop for the pick itself. It earns its place by
  making the seam real and by letting the whole suite run with no external service.
- **`systemone`** — any `/v1/systemone` endpoint, distinguished only by base URL and
  key. One adapter, not two, because the wire protocol is identical; this is the "one
  source of truth" rule applied. Questions map onto the protocol's `choice` (element
  pick) and `noul` (goal met, stuck, blocked) types, evaluated in a single parallel
  pass. A `choice` answer carries a `probabilities` map over every option, so the
  adapter returns a fully ranked candidate list rather than only the winner — without
  it, the policy's next-best fallback would be dead code on the real adapter. The
  protocol accepts up to 255 options, which is what bounds the element cap. The
  existing `jev-auto-review.ts` client is refactored so its request plumbing, body
  capping and response validation are shared rather than duplicated. Text-only:
  declares `vision: false`.
- **`vision`** — any OpenAI-compatible vision endpoint, which is how an open-weight
  GUI specialist is reached. The reference target is **Holo1.5-7B** (Apache 2.0, open
  weights, Docker-served, the localizer inside a 97.1% WebVoyager system). Declares
  `vision: true`, so the caller supplies a screenshot alongside the element list.

  It asks for both at once: name the element that advances the goal, or, when no
  listed element fits, give a point. A point is mapped to the element whose `rect`
  contains it — or the nearest within a small tolerance — and returned as an ordinary
  ref-bearing candidate marked `source: "point"`. One round trip, and the pick path
  and the point path share a single answer schema.

  This is what makes the model's coordinate-localization strength usable without
  letting coordinates escape the adapter. A point that maps to nothing yields no
  candidate, and the policy escalates as it does for any other empty ranking.

  This is the self-hosted path. It replaces the text-only drop-in an earlier draft
  named, which scored 63.9 against Jev's 90.4 on the vendor's own intelligence
  benchmark and had no published browser result at all. Holo1.5-7B needs no new
  transport either: an OpenAI-compatible vision endpoint is already reachable through
  `pi-local-provider.ts` and declared vision-capable with `RAKAZO_LOCAL_VISION_MODELS`.
- **`fake`** — in-process, seeded decisions, for offline conformance and replay.

### Geometry and the viewport screenshot

The vision backend needs two things the page browser does not expose yet: where each
element is, and a screenshot in the same coordinate space. Both are additive.

**Element rects are nearly free.** The in-computer helper's `visible()` already calls
`getBoundingClientRect()` and discards the result. `BrowserSnapshotNode` gains an
optional `rect: { x, y, width, height }` in CSS pixels relative to the viewport.

**The screenshot comes from CDP, not the desktop.** `BrowserProvider` gains an
optional `screenshot()`, backed by a new `{ command: "screenshot" }` page-browser
command that calls `Page.captureScreenshot` in the session the helper already holds.

This choice is the whole reason geometry is tractable. A desktop screenshot is the
full screen including window chrome, in device pixels; element rects are CSS pixels
relative to the viewport. Mapping between them needs the window offset and the
device pixel ratio, both unreliable under X11, and every error there becomes a click
in the wrong place. A CDP viewport capture is in the *same space as the rects by
construction*, so there is no transform to get wrong. The capture reports its own
scale factor for the one conversion that remains.

**Everything degrades.** `rect` and `screenshot()` are both optional. Providers
shipping an older computer image report neither; the vision backend then cannot run
and the policy escalates, which is exactly today's behavior. No provider breaks, and
a bot on an un-rebuilt image loses the accelerator rather than the browser.

This revises two earlier decisions in this document. `BrowserProvider` does change
after all — by one optional method, because that is where a page-browser capability
belongs, and routing around it through an injected callback to preserve a stale
promise would be worse design. And the element cap rises from 80 to 240: a point
landing on element 81 cannot be named, so the fallback would fail silently on
exactly the dense pages it exists for. 240 matches the reference implementation and
stays under the protocol's 255-option ceiling. The image rebuild the cap change
needs is already required by the geometry work.

### Selection: per bot, per run

The decider is selected the same way the bot's main model is selected, because
anything else would make it the one model in the product that an operator cannot
route. A deployment must be able to run one bot entirely on its own hardware and
another against a hosted endpoint, and to override that for a single run.

Rakazo already stores `modelProvider` / `modelId` on `Bot`, on `Run`, and on
`SteeringMessage`. The decider mirrors the first two:

| Table | Columns | Meaning |
|---|---|---|
| `Bot` | `pageDeciderProvider`, `pageDeciderModel` (both nullable) | this bot's default |
| `Run` | `pageDeciderProvider`, `pageDeciderModel` (both nullable) | override for one run |

Resolution precedence, highest first: the run's columns, then the bot's columns, then
the deployment default from configuration, then `model`. Null at every level means
`model`, so an unconfigured deployment is still a working deployment and the
environment variable is only a default — never the only way to choose.

The connection itself resolves through the hook `AgentRunRequest` already exposes:

```ts
/** Resolve an explicitly requested helper model within the active user and space scope. */
resolveModel?: (provider: string, modelId: string) => Promise<AgentRunModel>;
```

That gives the decider the same user-and-space credential scoping as the main model,
with no second secret path to secure. Hosted and self-hosted `systemone` endpoints
are two connection entries differing by `baseUrl` — a field `AgentRunModel` already
carries, and the mechanism the existing `openai-compatible` provider already uses.
Per AGENTS.md, no provider- or model-specific environment variable is added for
either; the generic connection expresses the difference.

### Settings surface

Choosing the decider is a real control, and it is the only user-facing addition in
this design.

It is shown progressively, not persistently. Most people will never set it, so it
does not become a second model dropdown sitting next to the first. It appears beside
the existing model choice, and only once a bot has a computer capable of the page
browser contract — before that it has nothing to configure and is not rendered.

The control is a connection picker with the same shape as the model picker, with no
explanatory body copy: the choice is between named connections the operator has
already configured, and a default option meaning "use this bot's own model." Any
wording lands in the PR description per AGENTS.md, quoted, with the case for why the
label cannot be shorter.

### Integration point

The decider is consulted inside the browser tool path in
`packages/adapters/src/browser-tools.ts`, not in the executor loop. That keeps the
change local to the browser tools, leaves the agent loop untouched, and means a bot
whose computer has no page-browser contract is unaffected. The adapter is
constructed where `BrowserProvider` already is — the `deps.browser` defaulting site
at `packages/adapters/src/executor.ts:2953` — and passed into the tool functions
alongside `browser`, which those functions already take as a parameter.

**Where the goal comes from.** The decider needs the leg's goal, and the current
tool schemas have nowhere to put it. `browser_navigate` and `browser_act` therefore
gain one optional `goal` string in their input schemas. Return shapes do not change.

When `goal` is absent, the decider is skipped entirely and behavior is exactly
today's. That makes the parameter a genuine opt-in rather than a silent behavior
change, keeps the fallback path honest, and gives the replay suite a way to run the
same recorded task both with and without the decider. The model sees the same two
tools; with a goal supplied it simply gets further per call, because a confident
decider chain runs several steps before returning.

This is additive to the tool schema and adds no user-facing copy.

## Security and privacy

The decider receives the text and element names of a page the bot is logged into.
That is among the most sensitive data the product handles, and it is the reason both
configurations are first-class.

- **Consent gates the selection, not just the request.** Decider requests go through
  the existing AI data-sharing consent path
  (`packages/adapters/src/ai-consent.ts`). Because the decider is now selectable per
  bot and per run, consent is checked at resolution: selecting a hosted endpoint in a
  space that has not consented to sharing page content externally fails the
  selection with a clear reason rather than silently falling back, and a run-level
  override cannot escalate a bot past its space's consent. Falling back silently
  would mean a bot the operator believed was private had quietly stopped being
  private, which is the one failure this design must not have.
- **A screenshot raises the stakes, so only a vision adapter gets one.** The caller
  supplies `screenshot` only when the adapter declares `vision`, and a screenshot of
  a logged-in page is treated as external data sharing exactly as page text is: the
  same consent gate, checked at selection. Since the `vision` backend's reference
  target is a model running on the operator's own hardware, the accurate
  configuration and the private one are the same configuration here.
- **No secrets, structurally.** The decider never produces or receives typed text,
  so credential values cannot reach it through the action path. Element `value`
  fields for password-type inputs are dropped before the request is built; the
  in-computer helper already masks password values at the source.
- **Bounded payloads.** Element count, excerpt length and total body size are capped
  before the request, following the limits already set in `jev-auto-review.ts`.
  Redaction reuses `connector-safety.ts`.
- **SSRF.** A self-hosted base URL is validated through the existing
  `web-ssrf.ts` / `private-endpoint.ts` checks, as the current client does.
- **Logging.** Decisions log the outcome, the reason and the scores. They never log
  page text, element names or URLs beyond origin.

## Testing

Deterministic and offline by default, and identical across both configurations.

1. **`page-decider-conformance.test.ts`** — every adapter must advertise
   `pick` and `scores`, return a well-formed `PageDecision` for a seeded page, and
   honor cancellation. Mirrors `browser-conformance.test.ts`, including its seeded
   HTML approach.
2. **Policy unit tests** — exhaustive over the evaluation order and every threshold
   boundary, including the ordering case that matters most: a page that is both
   `blocked` and `stuck` must produce `takeover`, never `escalate`.
3. **Replay suite** — recorded page states with expected outcomes, run against the
   `model` backend through the existing model emulator and against a seeded
   `systemone` emulator. The same assertions must pass on both. This is the suite
   the accuracy floor is measured on, and it is where "both, equally" is enforced.
4. **Resolution precedence tests** — run columns beat bot columns beat the
   deployment default beats `model`, with null at each level falling through rather
   than erroring. Includes the case that protects the privacy promise: a bot pinned
   to a self-hosted decider must not be silently upgraded to a hosted one by a
   deployment default, and a run override must be scoped to the same user and space
   as the credential it resolves.
5. **Calibration harness** — a script, not a test, that replays labeled states and
   reports a confusion matrix per threshold, so thresholds are set from data.
   Follows the `test:evals` precedent.

The desktop Playwright suite is not run locally for this work, per AGENTS.md; CI's
virtual-display job covers it. The settings picker gets a web test that opens the
screen, so the CI E2E screenshot can be linked on the PR as AGENTS.md requires for
UI changes.

## Fork and upstream workflow

The work is written to be upstreamable, which is also what keeps merges quiet. Two
practices carry that:

**Additive files, minimal shared edits.** Everything new lands in new files. The
edits to shared files are each one or two lines, and they are the complete list:

| File | Edit |
|---|---|
| `packages/adapter-kit/src/registry.ts` | one `slots` entry |
| `packages/adapter-kit/src/types.ts` | new type block, appended |
| `packages/adapter-kit/src/interfaces.ts` | new interface, appended |
| `packages/adapters/src/index.ts` | export lines for the new modules |
| `packages/adapters/src/browser-tools.ts` | the decider consultation |
| `packages/adapters/src/builtin-tools.ts` | one optional `goal` field on two tool schemas |
| `packages/adapters/src/executor.ts` | one `deps.pageDecider` default beside `deps.browser` |
| `packages/db/prisma/schema.prisma` | two nullable columns on `Bot`, two on `Run` |
| bot settings UI | one progressively-disclosed connection picker |

The schema change is additive and nullable, so a merge that brings in upstream
migrations orders cleanly alongside it. The settings picker is the only edit that
touches a file upstream is also likely to be changing, and it is the one to keep
smallest.

**Remote topology.** `origin` currently points at the upstream repository. Create a
fork, then:

```sh
git remote rename origin upstream
git remote add origin <your-fork-url>
git fetch upstream
```

Keep `main` tracking `upstream/main` and never commit to it directly; do all work on
topic branches off `main`. Sync with `git fetch upstream && git merge upstream/main`
on `main`, then rebase live topic branches. Because the shared-file edits above are
small additions rather than rewrites, that merge stays mechanical.

## Non-goals

Stated explicitly, so scope does not drift during implementation.

- **No CAPTCHA solving and no bot-detection evasion.** The design detects an
  interstitial and hands the live screen to the human through the takeover path that
  already exists. Circumventing anti-abuse controls is out of scope, and it would
  also break on every vendor change, which is the opposite of the reliability goal.
- **The 80-element snapshot cap stays.** The reference design enumerates up to 240
  DOM elements and prefers the DOM over the accessibility tree because
  accessibility trees under-report inputs. Our cap is at
  `infra/sandboxes/computer/rakazo-page-browser:434`, inside the in-computer helper,
  so raising it requires rebuilding the computer image. It is a plausible constraint
  on dense pages and a likely follow-up, measured first on the replay suite rather
  than changed on assumption.
- **No set-of-marks rendering.** Element geometry plus `sharp`, already an adapters
  dependency, would allow drawing numbered boxes onto the screenshot — an
  established way to improve a vision model's grounding. Geometry makes it possible;
  this spec does not build it. Follow-up once the point fallback has numbers.
- **No raw coordinate dispatch.** When a point maps to no element, the result is
  `fallback: "computer_act"` — the path that exists today. The chain never clicks a
  bare coordinate, because that would leave the ref envelope's origin checks and
  stale-ref rejection and create a new way to click the wrong thing.
- **No new browser engine.** `ComputerBrowserProvider` remains the default; this is
  not a Playwright or hosted-browser product.
- **No vision model swap.** Which model sees screenshots stays a connection setting.
  Operators wanting a fully local vision path already have
  `pi-local-provider.ts` and `RAKAZO_LOCAL_VISION_MODELS`.
- **No UI beyond the decider picker.** The acceleration itself is invisible: no
  status chrome, no progress text, no explanation of which brain made which
  decision. Takeover already has its own surface and wording. The one addition is
  the progressively-disclosed connection picker described above, and it is the only
  place this design adds user-facing words.
