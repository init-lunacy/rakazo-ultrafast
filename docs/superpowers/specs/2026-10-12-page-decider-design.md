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

- **Accuracy floor, absolute.** Task success does not regress
  against the current loop. The design guarantees this structurally: every decider
  outcome other than a confident pick falls through to today's behavior, so the
  worst case is the current loop plus one cheap call.
- **Fewer expensive calls.** Vision-model calls per completed browser task drop
  materially. Target: at least a 50% reduction, measured on recorded traffic. The published
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
The success criteria above are therefore hypotheses to measure on real traffic, not
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
        +-- done      -> hand back with a goal-met confidence for the model to check
        +-- escalate  -> today's path: screenshot + the bot's own model
        +-- takeover  -> request_takeover / waiting_takeover
        +-- refuse    -> budget exhausted, hand back with what is known
```

**The decider assesses; the frontier model verifies.** `goalMet` is scored by the
same component that chose the actions, so it is self-assessment and is reported as a
claim — `goalMetConfidence`, never `goalMet: true`. Asserting it as fact would hand
the model a cheap model's opinion as an established result and delete the "verify"
from plan / classify / verify, which is the step the published systems treat as
load-bearing.

**A chain says what it did.** Because several steps collapse into one tool call, the
result carries the number of steps and the names of the elements acted on. Without
it the planner cannot see the path it just took and may repeat work or reason from a
stale picture of the page. The highest-scoring published system's stated insight is
precisely this: compress the browsing into one call and return a concise description
of what changed. Those fields are absent when the chain acted zero times, so a no-op
chain is byte-identical to the pre-decider result. Element names go to the model and
never to the log.

The decider is strictly an accelerator. Every outcome except `act` and `done` lands
in behavior that exists today. Removing the slot restores the current loop exactly.

### Contract

New types in `packages/adapter-kit/src/types.ts`, new interface in
`packages/adapter-kit/src/interfaces.ts`:

```ts
export interface PageDeciderCapabilities {
  /**
   * True when the decider uses a screenshot. The only capability, because it is
   * the only one anything branches on: the chain captures the viewport only then.
   */
  vision: boolean;
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
  screenshot?: { data: string; mimeType: "image/png"; scale: number };
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

Two real deciders plus a fake, and the default is none at all.

- **Off (default).** No decider: the tools behave exactly as today at zero extra
  calls, and the product runs with no vendor. An earlier draft defaulted to asking
  the bot's own model before every step, which was strictly slower than today and
  bought nothing escalation does not already do.
- **`model`** — any connected model, run through the agent runtime exactly as Auto
  Review runs its checker: no tools, no history, JSON only. That reaches every model
  rakazo supports — Holo1.5-7B on the `local` provider, Haiku through Anthropic,
  anything through OpenRouter or the Cloudflare gateway — with credentials, OAuth and
  usage already handled. Whether it sees the page is a property of the chosen model,
  read with `modelAcceptsImageInput`, not a separate backend: a model that accepts
  images gets the viewport capture and may point; one that does not picks from the
  element list. An earlier draft had a separate hand-written vision client, which
  reached only OpenAI-compatible endpoints.

  The self-hosted reference is **Holo1.5-7B** (Apache 2.0, open weights, the
  localizer inside a 97.1% WebVoyager system), connected like any other local model.

  It asks for both at once: name the element that advances the goal, or — only when
  it saw the page and nothing fits — give a point. The point is divided by the
  capture's scale into CSS pixels and mapped to the smallest element whose rect
  contains it, or the nearest within a few pixels, then returned as an ordinary
  candidate marked `source: "point"`. The model is never shown rects: it names a ref
  or points at an image pixel, and only our code maps back. A point that maps to
  nothing yields no candidate, and the policy escalates. Without a capture — an older
  computer image — the model still decides from the element list.
- **`systemone`** — hosted Jev, through the code the Auto Review Jev client already
  uses, at the same fixed URL with the existing `TYPESAFE_API_KEY`. Questions map
  onto the protocol's `choice` (element pick) and `noul` (goal met, stuck, blocked)
  types in one parallel pass. A `choice` answer carries `probabilities` over every
  option, so the adapter returns a fully ranked list — without it the policy's
  next-best fallback would be dead code. The protocol accepts up to 255 options,
  which bounds the element cap. The request code is extracted from
  `jev-auto-review.ts` so both share it; it returns a failure kind rather than a
  message, so Auto Review keeps its exact wording, and it passes `state` through
  untouched, so Auto Review's payload is unchanged. Text-only.

  The URL is not configurable. That existed only for a self-hosted Jev replacement,
  which Holo1.5 on the `local` provider now covers, and a fixed public endpoint
  needs no SSRF policy.
- **`fake`** — seeded decisions, for offline tests.

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

### Selection: per bot

The decider is chosen per bot, like the bot's model, so one bot can run entirely on
the operator's hardware and another against a hosted service. `Bot` gains
`pageDeciderProvider` and `pageDeciderModel`, both nullable, travelling the same
path as `modelProvider` / `modelId`: the Prisma model, the `Bot` contract and its
update schema with the same "both set or both cleared" rule, the bot mapper in
`db/src/repos.ts`, and the API's bot update. Null means off.

There is no per-run column and no deployment-wide default. Nothing would write a
per-run decider — per-run model choice exists through `modelPin`, and carrying a
decider on it is separate work — and with off-by-default and per-bot choice, a
deployment default would be a second way to set the same thing.

At run time the decider's model resolves through `resolveConnectedModel`, the call
the run already uses for backup and helper models, so it accepts exactly the models
the picker lists and inherits the run's user-and-space credential scope. Jev is the
provider id `jev` and needs the deployment's `TYPESAFE_API_KEY`. The decider is
built lazily, once per run, on the first browser call that carries a goal, so a run
that never sends one resolves nothing. A decider whose model can no longer be
resolved is skipped with a log line: it is an accelerator, and losing it never fails
a run. Its calls are billed through `recordUsage`, as Auto Review's are.

### Settings surface

One select directly under the bot's model select. That select already sits inside
the bot panel's Advanced `<details>`, so the decider inherits native progressive
disclosure with no new state. Its options are `Off`, the same connected models the
model select lists, and Jev when the deployment can run it — signalled by
`Me.jevAvailable`, which follows the existing `ticketBoardEnabled` flag and reads the
existing key. A saved decider that is no longer offered stays visible, as the model
select already does. The new copy is the label `Page decider` and the option `Off`.

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
change, keeps the fallback path honest, and lets a test compare output with and
without a decider byte for byte. The model sees the same two
tools; with a goal supplied it simply gets further per call, because a confident
decider chain runs several steps before returning.

This is additive to the tool schema and adds no user-facing copy.

## Scope, and what carries over to computer use

**This accelerates the page-browser path only.** A task driving a native
application, a terminal, or a canvas-heavy surface goes through
`computer_observe` / `computer_act` and never reaches the decider. The
call-reduction target therefore applies to the fraction of work that is web pages
reachable through the page browser, not to all browser-ish work — a distinction
measurement on real traffic should report rather than average away.

The two paths are already coupled, which is worth knowing before extending either:
`unchangedVisualStreakAfterPageBrowser` clears the desktop visual-loop streak after a
successful browser mutation, because the live view can change without a new desktop
frame. That reset reads `error`, `fallback` and `ok`, so a chain result must keep
those three meaning exactly what they meant before. Two tests pin it.

**The evidence for doing this on the desktop is stronger than for the browser.**
Surfer 2 reaches 97.1% purely visually, with no DOM or accessibility tree at all, and
Holo1.5 and UI-Venus-2 are GUI localizers trained on desktop screenshots. The role
split is better supported there than the typed-decision pick is here.

Three things block a straight extension, and they are design problems rather than
volume of code — `computer-tools.ts` already supplies the loop guard, `ComputerAction`
the dispatch contract, and six providers the implementations:

1. **No element refs, so the dispatch safety model inverts.** This design's guarantee
   is that the decider names a ref and the action goes through `browser_act` with its
   origin checks and stale-ref rejection. A desktop has no element list, so a decider
   would return a coordinate and we would dispatch it raw — the non-goal above.
2. **Geometry does not transfer.** Rects come from `getBoundingClientRect()` inside
   the page. A desktop screenshot has nothing to snap a coordinate onto, so the
   "map the point back to a safe named target" step disappears.
3. **Only one of the three backends applies.** Jev is text-only and a desktop state is
   pixels, so `systemone` is inapplicable; only `vision` carries over.

A fourth point is a prerequisite rather than a blocker: pointer input has no
interpolation. `ComputerInput` carries absolute `move` / `down` / `up` / `click`, and
every move is an `xdotool mousemove` warp with no intermediate motion. Scroll is
`up`/`down` with an amount, implemented as repeated button clicks — no horizontal and
no pixel-precise scrolling. Hover fires, because a motion event is generated at the
destination, but path-dependent interaction does not: drags are two-point teleports,
so canvas drawing, slider drags, drag-to-select and anything reading velocity
misbehave. Those are exactly the surfaces the desktop path exists to handle, so an
accurate localizer would be feeding points into an input layer that cannot express the
gestures they need.

**What this design does to stay reusable** is deliberately small, because a premature
shared abstraction would cost more than it saves. The policy in `@rakazo/core` already
depends on nothing and declares its own structural types; its identifiers are named
`target` and `knownTargets` rather than `ref`, so a desktop chain could pass coordinate
keys and reuse `decidePageAction`, its thresholds, and its evaluation order
unchanged. The adaptation at the page chain's boundary is three
`map` calls. Per-bot selection and consent are already
path-neutral.

What is deliberately *not* generalized: `PageDecider` keeps `BrowserSnapshotNode[]` and
refs. A desktop decider would be its own interface, because that is a real boundary,
and merging them before a second implementation exists is the speculative abstraction
this repository's conventions tell us to avoid.

## Security and privacy

The decider receives the text and element names of a page the bot is logged into,
and a seeing model also receives a viewport capture. That is among the most sensitive
data the product handles, which is why a fully local configuration is first-class.

- **Consent is the existing flow.** `aiConsentStatus` already collects every bot
  model, routine model, backup, voice and cloud agent as recipients and prompts for
  any not yet allowed. A bot's decider is appended to the same list the way backups
  and the team-chat judge model are, so it is the existing `"model"` use — the same
  one Auto Review's checker falls under — with the same base-URL binding as any other
  use of that connection, and no new disclosure copy. The existing flow blocks rather
  than substitutes, so a private bot is never silently re-routed to an outside
  service.
- **No secrets, structurally.** The decider never produces or receives typed text,
  so credential values cannot reach it through the action path. Element values are
  never sent: `systemone` sends one label per element, built by a single function
  that excludes the value, and `model` sends `ref`, `role`, `name` and `tag` only.
  The in-computer helper already masks password values at the source.
- **Rects stay in the process.** The model is never shown them; only our code maps a
  point back to an element.
- **Bounded payloads.** At most 240 elements, labels capped at 120 characters, the
  page excerpt at 4,000, and the System One response read through `readBodyCapped`.
- **No new network surface.** `systemone` calls the same fixed public endpoint as
  today's Auto Review client; `model` reaches whatever connection the operator
  configured, through the runtime's existing path.
- **Logging.** One event per stop, built by a pure function tested to carry outcome,
  reason, scores and URL origin only — never page text, element names or a full URL.

## Testing

Deterministic and offline throughout.

1. **Policy** — every branch and threshold boundary, the evaluation order,
   out-of-range and `NaN` scores, unknown refs, empty lists, dispatchable-kind
   filtering.
2. **Decider conformance** — `fake`, `systemone` and `model` run identical
   assertions: in-range scores, only offered refs, valid kinds, cancellation
   honored. Hosted and self-hosted are first-class together because they meet one
   contract.
3. **Adapters** — ranking from `probabilities`, timeouts, no element value sent,
   fenced JSON, point mapping through the capture's scale, list-only fallback
   without a capture.
4. **Chain and tools** — confident clicks, escalation, takeover, no replay of an
   uncertain action, a capture only for a seeing decider, byte-identical output
   without a goal, preserved result shape, redaction, and the desktop loop-guard
   reset.
5. **Selection and consent** — the decider is built only when configured and
   resolvable, and a bot's decider appears as a consent recipient.
6. **Settings** — the picker sits inside Advanced, offers Jev only when available,
   saves and clears.

Measuring the success criteria — call reduction, latency, bot-wall recall and false
takeovers — needs recorded real traffic, not a handful of fixtures, so it is not part
of this change. A replay suite and calibration harness from an earlier draft were
dropped for that reason: three fixtures make a percentage meaningless, and a
calibration tool needs labelled data to calibrate on. Thresholds remain configuration
in the meantime.

The desktop Playwright suite is not run locally, per AGENTS.md; CI's virtual-display
job covers it. A web test opens the bot panel's Advanced section so the CI screenshot
can be linked on the PR.

## Fork and upstream workflow

The work is written to be upstreamable, which is also what keeps merges quiet. Two
practices carry that:

**Additive files, minimal shared edits.** Everything new lands in new files. The
edits to shared files are each one or two lines, and they are the complete list:

| File | Edit |
|---|---|
| `packages/adapter-kit/src/registry.ts` | one `slots` entry |
| `packages/adapter-kit/src/types.ts` | optional `rect`, screenshot types, one command variant |
| `packages/adapter-kit/src/interfaces.ts` | one optional `BrowserProvider.screenshot` |
| `infra/sandboxes/computer/rakazo-page-browser` | rects, cap 240, a `screenshot` command |
| `packages/adapters/src/computer-browser.ts` | `screenshot()` |
| `packages/adapters/src/fake-browser.ts`, `page-browser-session.ts` | offline rects and capture |
| `packages/adapters/src/jev-auto-review.ts` | moved onto the shared System One client |
| `packages/adapters/src/browser-tools.ts` | the chain, behind an options field |
| `packages/adapters/src/builtin-tools.ts` | one optional `goal` field on two tool schemas |
| `packages/adapters/src/executor.ts` | a lazy per-run decider and two dispatch edits |
| `packages/db/prisma/schema.prisma` | two nullable columns on `Bot` |
| `packages/contracts/src/domain.ts`, `db/src/repos.ts`, `api/src/router.ts` | the two columns, end to end, and `jevAvailable` |
| `apps/api/src/ai-consent.ts` | the decider as one more model recipient |
| `apps/web/src/pages/shell/bot-panel.tsx` | one select under Advanced |

The schema change is additive and nullable, so a merge that brings in upstream
migrations orders cleanly alongside it. The files most likely to collide on an
upstream merge are the helper and `bot-panel.tsx`; both edits are kept to additions.

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
- **No set-of-marks rendering.** Element geometry plus `sharp`, already an adapters
  dependency, would allow drawing numbered boxes onto the screenshot — an
  established way to improve a vision model's grounding. Geometry makes it possible;
  this spec does not build it. Follow-up once the point fallback has numbers.
- **No raw coordinate dispatch.** When a point maps to no element it yields no
  candidate and the policy escalates, so the tool returns what it returned before.
  The chain never clicks a bare coordinate, because that would leave the ref envelope's origin checks and
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
