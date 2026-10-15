# Browser tabs: addressable tabs for the bot, its helpers, and the user

Status: approved design, revised after review, not yet implemented
Date: 2026-10-14

> **Revisions after review.** A review against the code, for upstream fit and
> over-engineering, changed the first draft. The changes, so nothing moves silently:
>
> - **Ownership, handles and purposes live in the executor's memory for the run,
>   not in a locked file inside the computer.** Helpers run inline in the parent's
>   worker process, so one in-memory map is already race-free. The file was not a
>   security boundary: the bot's shell runs as the same user. It would also have
>   stranded tabs after a run lease takeover. The Python helper now only addresses
>   tabs, so ownership logic exists once, in TypeScript.
> - **`browser_tabs` is read-only and has no `close`.** Approval is decided per
>   tool name, so a listing tool that sometimes mutates did not fit. Instead:
>   - the tab cap counts only tabs this run opened;
>   - the run closes the background tabs it opened when it ends.
>
>   With the first draft's global cap, tabs nobody owned could fill up across runs
>   and block every later helper.
> - **The chat activity prefix is dropped.** Activity lines are built from the
>   call's arguments before it runs, so they have no tab labels to show.
> - **The strip loads with the computer status, not from a new listing RPC.** The
>   status carries the latest run's tab list, so web and mobile need nothing new to
>   load it. One RPC remains, for pinning.
> - **Version skew is handled.** An old computer image or supervisor would silently
>   ignore `tab` and act in the focused tab. The executor now probes for tab support
>   once per run and refuses tab arguments when it is missing.
> - **Hidden-tab rendering is the main risk, not screenshots.** It is now the first
>   implementation task, with a defined fallback.
> - The tab is threaded through the page-decider chain, and the plumbing list
>   includes the browser request types.

## Why

A bot has one Chromium per screen, and every page-browser command acts on "the
focused visible tab". The helper (`infra/sandboxes/computer/rakazo-page-browser`)
finds that tab by attaching to every page target, up to 32, on every command. It
gives up when the answer is ambiguous. There are no tab tools. A tab opened by
`target=_blank` or `window.open` is picked up only by accident, and the model cannot
tell which tab it is in or what the other tabs hold.

That blocks parallel browsing, the largest speedup left for browser work:

- The model already issues tool calls in parallel (pi-agent-core's default
  `toolExecution: "parallel"`), but parallel browser calls today hit the same page.
- `run_subagent` helpers (up to 4 at once) share the parent's computer. Two helpers
  that browse collide on the one focused tab, or fail with "No unambiguous visible
  browser tab".

This design makes tabs addressable. An agent names the tab it acts in, owns the
tabs it works in, and can read every tab. The user watches the tab that acted last
or pins one, and a strip shows what each tab is for and who is using it.

## Intent and success criteria

- **Agent-friendly.** An agent can:
  - list tabs and see what each holds;
  - open a tab for a purpose;
  - switch between tabs by handle;
  - read any tab.

  It is told when its click opened a new tab.
- **Safe parallelism.** The main agent and its helpers browse at the same time
  without acting in each other's tabs.
- **Transparent.** The user sees every tab's owner and purpose. The live screen
  follows the tab that acted last, the switch is animated in the strip, and the user
  can pin a tab.
- **No regression.** A bot that never names a tab behaves exactly as today. A
  single-tab bot shows no new UI. Computers without tab support keep today's
  behavior.
- **Faster addressed commands.** A command that names its tab attaches to that one
  target, instead of probing every open tab.

## What already exists

- **The page-browser helper.** A stateless Python CDP client, run once per command
  by the Docker supervisor (`/computers/:id/browser`). Commands: `navigate`,
  `snapshot`, `screenshot` and `act`.
- **Actions run as page JavaScript** in an isolated world, not as input events.
- **One Chromium per bot screen** (`:N`, CDP port `9221+N`), launched by
  `infra/sandboxes/computer/rakazo-browser`, which reuses a running instance.
  Chromium's own tab bar is visible on the live screen.
- **Agent identity on every call.** Tool calls carry an execution ID that includes
  the agent namespace: `main` or the helper's agent ID (`pi-runtime.ts`). Helpers
  run inline in the parent's worker process (`executeSubagent`), and their
  start and end reach the executor as `thread.subagent` events.
- **Thread events.** Live events go over the realtime fanout, and a persisted
  event reducer (`packages/core/src/events.ts`) rebuilds thread state on load.
- **Secret fill checks.** `fill_secret` checks the HTTPS origin in the same
  evaluation as the fill, so it is already checked per tab.

Only the Docker computer runs the page-browser helper. E2B, Daytona, Box and
CreateOS fall back to `computer_act`, and this design leaves them unchanged.

## Approach

The helper learns to address tabs: it takes a target, lists targets, opens a target,
activates one, and reports targets an action opened. Everything about who may use
which tab lives in one small TypeScript module that the executor holds per run.

Rejected alternatives:

- **A persistent browser daemon in the computer.** It would also remove per-command
  startup cost, but it is a new long-lived process to supervise and a larger change
  for upstream. It stays a later performance project, and the tool contract below
  does not change if it lands.
- **Driving Chromium with Playwright from the worker.** It reaches across the
  sandbox boundary and discards the helper's secret-fill and redaction guarantees.
- **Ownership in a locked state file inside the computer.** This was the first
  draft; see the revisions above.

## Agent-facing contract

### Handles

Tabs are named by short handles: `t1`, `t2`, and so on. The run's tab registry
assigns them and keeps each one stable for the rest of the run. Chrome target IDs
never reach the model.

### Tools

| Tool | Arguments | Notes |
|---|---|---|
| `browser_tabs` | `{}` | New and read-only. It lists `{ tab, title, url, owner, purpose }` for every tab. `owner` is `"you"`, `"helper: <label>"`, or absent. |
| `browser_navigate` | `{ url, tab?, newTab?, purpose?, goal? }` | `newTab: true` opens a tab owned by the caller. `purpose` is a short note of what the tab is for. |
| `browser_snapshot` | `{ tab? }` | Reads any tab, owned or not. |
| `browser_act` | `{ actions, tab?, goal? }` | Acts only in a tab the caller owns, or claims an unowned one. |

Every result includes the `tab` it ran in. `browser_navigate` and `browser_act`
results list tabs the call opened (`opened: ["t4"]`).

### Defaults

When `tab` is omitted, the agent uses the tab it used last in this run.

- **Main agent.** Its first call uses the focused visible tab, found with today's
  probe. That probe runs only for this first call. Bots and prompts that never
  name a tab keep working.
- **Helper, `browser_navigate`.** Its first navigate without a tab opens a new tab
  for it.
- **Helper, `browser_act`.** With no tab named and none used yet, it fails with
  "Open a tab with browser_navigate first." Helpers never start by sharing a tab.
- **`browser_snapshot`.** With no tab named and none used yet, it reads the focused
  visible tab.

### Ownership

- **Owner value.** An owner is `main` or a helper's agent ID. It comes from the
  call's execution ID, never from tool arguments.
- **Claiming.** Acting in or navigating a tab requires owning it. Doing either in
  an unowned tab claims it, which covers tabs the user opened by hand and tabs left
  over from earlier runs.
- **Another agent's tab.** Acting in it fails with: "t2 belongs to helper
  '<label>'. Read it with browser_snapshot."
- **Pop-ups.** A tab opened by a page from an owned tab, found through its CDP
  `openerId`, gets the same owner. The result reports it.
- **Hand-back.** When a helper ends (finished, failed or aborted), the main agent
  takes over its tabs.
- **Lifetime.** The registry lives for the run. A new run, or a run resumed after a
  lease takeover, starts with every tab unowned, and the main agent claims as
  today.

### Limits and cleanup

- **Tab cap.** A run may open at most 12 tabs. The next `newTab` fails with "Reuse a
  tab you own." Tabs the run did not open do not count.
- **Cleanup.** When the run ends, it closes the tabs it opened that are not in
  front. The tab the user is looking at stays. A run that dies before cleanup leaves
  its tabs behind, unowned. That is harmless, because they do not count toward any
  later run's cap.
- **Helpers.** The helper cap stays at `MAX_PARALLEL_SUBAGENTS = 4`.

### Instructions

The bot's browser instructions gain one line: tabs can be opened and read in
parallel in one step, each agent acts in its own tabs, and tabs should be reused.

## Computer side

### Helper changes

`navigate`, `snapshot`, `screenshot` and `act` take an optional `target` (a CDP
target ID).
- **With a target,** the helper attaches to that target only.
- **Without one,** it keeps today's focused-visible probe.
- **Every result echoes the `target`** it ran in.
- **`navigate` and `act` also return `opened`:** page targets whose `openerId` is
  the acted target and that did not exist before the call.
- **Actions run as a user gesture** (`userGesture: true` on the action's
  evaluation). An agent's click is a deliberate click. Without the flag, Chromium's
  popup blocker drops `target=_blank` links and `window.open`, so the tab a click
  should open never appears.

New commands:

| Command | Effect |
|---|---|
| `tabs` | Lists page targets: `{ target, title, url, openerId }`. |
| `open` | Runs `Target.createTarget` with a URL (and `newWindow`, if the spike below requires it), then waits like `navigate`. |
| `close` | Closes a target. Only the executor's run-end cleanup uses it. |
| `activate` | Runs `Target.activateTarget` on a target. With `pin`, it records or clears the pin. Without `pin`, it is a follow, which does nothing while a pin is set. |

**Pin storage.** The pin is one file, `/tmp/rakazo/pinned-<display>`, holding a
target ID. Only `activate` with `pin` writes it, by atomic rename, so it needs no
lock. A pin naming a closed target counts as unpinned.

### Tab registry (adapters, TypeScript)

The registry is a small pure module the executor creates once per run. It maps:

- handle ↔ target;
- owner;
- purpose;
- the target each agent used last;
- the targets this run opened.

It decides:

- claims;
- the ownership error;
- pop-up adoption from `opened`;
- hand-back;
- the cap;
- the cleanup list.

Calls are synchronous inside one Node process, so parallel tool calls cannot race
a claim. Follow is also applied here. After an action, the executor sends
`activate` (follow) for the acting tab, unless the front changed less than 1.5 s
ago in this run. That dwell keeps parallel helpers from flickering the screen.

### Tab support probe

The first tab-related need in a run calls `tabs` once:
- the first named `tab` or `newTab`;
- a helper's first navigate;
- `browser_tabs`.

An "unknown command" reply, or a supervisor schema rejection, marks the computer as
having no tab support for the run. Then:

- `browser_tabs` and tab arguments return "This computer needs an update for
  tabs."
- Helpers navigate in the shared focused tab, which is today's behavior.

The probe also checks the echo. A result without the echoed `target` is treated the
same way, so an old helper can never act in the wrong tab silently.

### Hidden tabs (first implementation task)

Actions run as page JavaScript, so a click does not need focus. But Chromium does
not run `requestAnimationFrame` or `IntersectionObserver` work in hidden tabs, and
may not produce screenshots of them. Lazy-loaded lists and animated UIs could stall
in a background tab.

The first implementation task is a spike on a real Docker computer. It opens two
tabs, drives the background one through a lazy-loading page, and takes a screenshot
of it. It runs with the three flags below. The outcome decides one switch:

- **It works:** tabs stay tabs.
- **It stalls:** `open` passes `newWindow: true`. Each agent tab becomes its own
  window, and with occluded-window backgrounding disabled, Chromium keeps it
  rendering. Nothing else in this design changes, and the strip matters more,
  because Chromium's own tab bar then shows one tab per window.

`rakazo-browser` adds `--disable-background-timer-throttling`,
`--disable-renderer-backgrounding` and `--disable-backgrounding-occluded-windows` in
both cases. The flags apply the next time Chromium starts.

### Plumbing

Each layer gains `target`, `opened` and the new commands:

- the supervisor's zod schema for `/computers/:id/browser`;
- `docker-sandbox.ts`;
- the browser request and result types in `packages/adapter-kit/src/types.ts`
  (`BrowserNavigateRequest`, the snapshot and act requests, `PageBrowserCommand`,
  `PageBrowserResult`) and `interfaces.ts`;
- `computer-browser.ts`;
- `browser-tools.ts`;
- `page-decision-chain.ts`, whose `browser.act` and `readPage` calls pass the
  call's target.

The in-process fake (`PageBrowserSessionStore`) becomes one session per target, so
offline tests and the conformance suite exercise tabs. The existing 512 KiB reply
cap is unchanged.

## User-facing surface

### Web (and Electron)

A tab strip appears above the live screen in `ComputerWorkspace` when the run has
two or more tabs.

- **Chip text.** Each chip reads `owner · label`.
  - The owner is the bot's name for the main agent, or the helper's task label as
    its chat card shows it.
  - The label is the tab's purpose, else the page title.
  - The URL is the chip's title and part of its accessible name.
- **Front indicator.** An indicator under the front tab slides to the new front tab
  with a CSS transform transition, and the strip scrolls it into view. There is no
  transition under `prefers-reduced-motion`.
- **Pinning.** Clicking a chip pins the view to that tab. While pinned, one
  **Follow** button appears, and it unpins.

Pinning exists because the live screen is view-only for a watcher. Without taking
control, there is no other way to choose which tab to watch.

New copy: **"Follow"**. It appears only while a tab is pinned, because the user
needs one way back to following the agent. Everything else in the strip is data.

### State and updates

- **The event.** The executor publishes `computer.browser_tabs`, carrying the tab list
  keyed by target and the front target it last activated, after any call that:
  - opened or adopted a tab;
  - changed the front tab;
  - changed a tab's title or URL;
  - ran cleanup.
- **Initial load.** `ComputerStatus` gains an optional `browserTabs`. The API fills
  it from the latest run's latest `computer.browser_tabs` event, only while the
  computer is running. The web applies live events to the status the way it applies
  the other `computer.*` events, and mobile already polls the status. So opening
  the overlay or reloading shows the strip with no listing RPC. A tab the user
  opened by hand appears after the agent's next call.
- **Pinning RPC.** Pinning is one RPC, `computer.showBrowserTab({ botId, target })`,
  where `target: null` unpins. It sends `activate` with `pin` and is authorized like
  the other computer controls.

### Mobile

`apps/mobile/app/computer.tsx` gets a native header menu, shown only with two or more
tabs:
- it lists `owner · label` from the polled computer status, with a check on the front tab;
- choosing an item pins that tab;
- a **Follow** item appears while pinned.

There is no animated strip on mobile; the native menu is the better pattern there.

## Errors

No tab error throws. Each returns a structured result the model can act on.

| Case | Result |
|---|---|
| Closed or unknown handle | "t3 is closed. Call browser_tabs." |
| Tab owned by another agent | The ownership message above |
| Run's tab cap reached | "Reuse a tab you own." |
| Helper `browser_act` before any tab | "Open a tab with browser_navigate first." |
| Computer without tab support | "This computer needs an update for tabs." |
| Helper failure | Today's `fallback: "computer_act"` |
| User holds control, or teaching is active | Today's blocks, unchanged |

## Security

- **Ownership** is decided in the executor's registry. The agent comes from the
  execution ID, never from the model. Ownership coordinates the run's agents. It is
  not a boundary against the bot itself, which already holds the whole computer.
- **Secret fill** keeps its HTTPS and saved-origin check, which runs in the same
  evaluation as the fill in whichever tab is targeted.
- **The page decider** runs only in the call's tab. If a chain click opens a tab,
  the chain stops with a new `opened_tab` reason, next to `left_origin`, instead of
  following it.
- **Redaction.** Tab titles and URLs pass through the run's secret redaction, both
  in tool results and in `computer.browser_tabs`. The event is visible only to people
  who can read the thread, which already shows URLs in activity lines.
- **Approval.** `browser_tabs` is read-only. Cleanup's `close` is the executor's,
  not a model action.

## Testing

All tests are deterministic and offline.

- **Python helper** (`test_page_browser.py`, fake CDP):
  - `target` addressing and the echo;
  - `tabs`;
  - `open`;
  - `opened` from `openerId`;
  - `activate` follow versus pin, and a pin naming a closed target;
  - `close`.
- **Tab registry** (unit):
  - handles;
  - claims, including two parallel claims;
  - the ownership error;
  - adoption;
  - hand-back on helper end;
  - the per-run cap;
  - the cleanup list;
  - the follow dwell.
- **Adapters:**
  - the fake's per-target sessions and the conformance cases for tabs;
  - `browser-tools` tab arguments and result fields;
  - the support probe and the missing-echo fallback;
  - the executor deriving the agent from the execution ID;
  - redaction of tab data;
  - the chain passing the tab and stopping on `opened_tab`.
- **Supervisor:** the route schema accepts the new commands and fields.
- **Web:**
  - strip component tests: hidden with one tab; pin shows Follow; Follow unpins; no
    transition under reduced motion;
  - the reducer keeping the latest tab list;
  - `e2e/page-browser.spec.ts` gains a two-tab case, so CI captures the strip for
    the PR.
- **Mobile:** a unit test for the menu items built from a tab list.
- **Manual, on a Docker computer:**
  - the hidden-tab spike (first task);
  - once more at the end, with two helpers browsing in separate tabs.

## Non-goals

- Shared goals or plans between the main agent, helpers and peer bots. That is the
  next design, and `purpose` is the seed it builds on.
- A persistent browser daemon.
- Tabs on non-Docker computer providers.
- Tiled views or live per-tab thumbnails.
- A model-facing close, and raising the helper cap.
