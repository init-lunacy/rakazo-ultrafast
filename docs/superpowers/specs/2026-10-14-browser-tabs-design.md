# Browser tabs: addressable tabs for the bot, its helpers, and the user

Status: implemented on 2026-10-15 (branch `feat/browser-tabs`)
Date: 2026-10-14

> **Corrections from implementation.** Building this design settled or changed a few
> of its statements, listed here so nothing changes silently:
>
> - **Agent tabs open as their own windows.** Measured in the computer image: a
>   background tab is hidden, stops animating and cannot be captured, while a
>   background window renders fully. A new window takes focus, though, so `open`
>   puts the previously active window back. After an `open`, an unnamed command
>   still reaches the tab the user was watching.
> - **`browser_tabs` is answered before the page-tool dispatch,** and that dispatch
>   now fails closed: only `browser_act` reaches the path that clicks. Between two
>   commits on the branch, the approval-exempt `browser_tabs` fell into the act
>   path. The finished branch has no such gap.
> - **The mobile menu is its own component,** like the computer's maintenance menu.
>   Its trigger is a glass surface around a plain view, because a pressable button
>   inside `MenuView` would take the tap from the menu.
> - **Review fixes:**
>   - One queue orders every screen change: follow, the desktop hold, and the end of
>     the run. A desktop hold is taken before it waits, and it ends when its holder
>     goes back to page tools as well as when it finishes.
>   - Opening a tab waits for unaddressed commands to finish.
>   - A tab probe that fails without a definite answer refuses with "The page
>     browser is not answering…", instead of sending a helper to the focused tab.
>   - An older computer is recognised from the supervisor's real answers: an older
>     helper's unknown command is passed through. A server error never counts as
>     "no tabs", which would send helpers into the shared focused tab; such a
>     computer keeps refusing with "not answering".
>   - The strip marks tabs the run opened (`opened`). A resumed run reads them back,
>     so they still close at the end.
>   - The `runs(botId, createdAt)` index is built concurrently.

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

> **Second review: tracing the plan through the code.** That review changed:
>
> - **Handles.** They are derived from tab IDs, so a paused run that resumes keeps
>   them.
> - **The pin.** The computer's pin file is mirrored from every reply, so a pin from
>   the UI is never undone.
> - **Cleanup.** It happens once, for every terminal run including Stop, and never
>   closes the front or pinned tab.
> - **The loop guard** counts per agent.
> - **Publishing** is serialized and starts only at two tabs.
> - **The main agent's first untargeted call** is guarded against a helper's tab.
> - **Two new UI strings were dropped:** a pin error, and a tabs activity line.
> - **The mobile menu** is the native `MenuView`.
> - **Background tabs** likely need separate windows, which Task 1 decides inside
>   the computer image.

> **Third review: what the agents actually see.** Helpers see only tool
> descriptions and tool results, never the bot's system prompt. So every rule is
> enforced in code and explained by the refusal an agent meets, and the prompt
> carries only what no description can. That review changed:
>
> - **`browser_act` takes no tab.** Refs never repeat, so a ref names the tab its
>   snapshot came from, and the act goes there. A tab's refs accumulate across
>   snapshots, so another agent's read never orphans them. Acting with refs read from another
>   agent's tab meets the ownership refusal instead of clicking in the wrong page.
> - **A read no longer breaks another agent's refs.** A snapshot used to clear the
>   page's refs, so the main agent reading a helper's tab would turn the helper's
>   next click stale.
> - **Unnamed navigate is refused once an agent has two tabs of its own,** since
>   navigating replaces a page. Reading a tab of one's own makes it current;
>   reading another's does not.
> - **Desktop actions hold the screen** once a run has two tabs. Otherwise a
>   helper's fallback clicks could land in whichever tab follow had just brought
>   forward.
> - **Context keeps each tab's newest page.** A snapshot of one tab no longer trims
>   another tab's from the model's context.
> - **The main agent's final tab stays open and comes forward** at the end, so the
>   result is what the user sees. A finished helper's tabs keep its name as their
>   purpose.
> - **The instructions no longer say "a tab per task".** A single-site task keeps
>   its one tab; the prompt says when fanning out helps. Every refusal now says what
>   to do next.
> - **Task 1 also checks that opening a window leaves the active window alone.**

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

Tabs are named by short handles: `t` and four characters derived from the tab's
Chrome target ID, for example `tq3x7`. Every run's registry derives the same
handle for the same tab. So a paused run that resumes with a fresh registry still
means the same tab by the same handle, and nothing has to be stored. Chrome target
IDs never reach the model.

### Tools

| Tool | Arguments | Notes |
|---|---|---|
| `browser_tabs` | `{}` | New and read-only. It lists `{ tab, title, url, owner, purpose, current }` for every tab. `owner` is `"you"`, `"main"`, `"helper: <label>"`, or absent. `current` marks the caller's current tab. |
| `browser_navigate` | `{ url, tab?, newTab?, purpose?, goal? }` | `newTab: true` opens a tab owned by the caller. `purpose` is a short note of what the tab is for. Handles are accepted in any case. |
| `browser_snapshot` | `{ tab? }` | Reads any tab, owned or not. |
| `browser_act` | `{ actions, goal? }` | No tab argument: it acts in the tab its refs came from, which the caller must own or which nobody owns. |

Every result includes the `tab` it ran in. `browser_navigate` and `browser_act`
results list tabs the call opened (`opened: ["t4"]`).

### Defaults

When `tab` is omitted, the agent uses its current tab: the one of its own it last
navigated, acted in or read. Reading another agent's tab does not change it.

- **Unnamed navigate with two tabs of one's own** is refused with "You have 2 tabs:
  t…, t…. Name one with tab, or use newTab." Navigating replaces a page, so it
  must never pick one by guesswork.
- **`browser_act`** goes where its refs came from. With unknown refs it falls back
  to the current tab, where a stale ref fails as it does today.

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
  '<label>' until it finishes. Read it with browser_snapshot, or open your own tab
  with browser_navigate newTab."
- **Pop-ups.** A tab opened by a page from an owned tab, found through its CDP
  `openerId`, gets the same owner. The result reports it.
- **Hand-back.** When a helper ends (finished, failed or aborted), the main agent
  takes over its tabs. A tab with no purpose takes the helper's name as one, so the
  main agent and the user can still tell what it was for.
- **Lifetime.** The registry lives for the run. A new run, or a run resumed after a
  lease takeover, starts with every tab unowned, and the main agent claims as
  today.

### Limits and cleanup

- **Tab cap.** A run may have at most 12 tabs it opened. The next `newTab` fails
  with "This run has 12 tabs open, the most it can. Navigate one of yours with tab;
  browser_tabs lists them." Tabs the run did not open do not count.
- **Cleanup.** When the run reaches a terminal state, it first brings the main
  agent's current tab forward, unless the user pinned another. Then it closes the
  tabs it opened, except the one in front, the pinned one and that current tab:
  - a terminal state is completed, failed or cancelled, including a Stop;
  - a paused run keeps its tabs;
  - one tab always stays.

  The check runs in one place, at the end of the run's lifecycle, from the run's
  committed status. A run that dies before cleanup leaves its tabs behind, unowned.
  That is harmless, because they do not count toward any later run's cap.
- **Helpers.** The helper cap stays at `MAX_PARALLEL_SUBAGENTS = 4`.

### Desktop actions

Desktop actions (`computer_act`) land in whichever tab is in front. With one tab
nothing changes. Once a run has two tabs, the first agent to use them holds the
screen until it finishes or goes back to page tools: its current tab comes forward, follow stops, and any
other agent's desktop action is refused with "The screen is in use by <owner>. Use
page tools in your own tab." When the user has pinned another tab, the refusal
says so and suggests Follow. An agent with no tab of its own is refused while
another agent's tab is in front, since its clicks would land there. If the computer cannot answer, the action goes ahead,
since desktop tools are the way on when the page browser is down.
`computer_observe` only reads, so it is not held.

### Context

Today the runtime keeps the newest three page results in the model's context and
trims older ones. A page in one tab never supersedes another's, so the newest
result of each tab also stays, for up to 12 tabs. A trimmed result names its tab.

### Instructions

Helpers see only tool descriptions and results, so those carry the rules. The main
agent's prompt adds what no description can:

- to work on several sites at once, open each in its own tab, and calls in
  different tabs can run in the same step;
- a `run_subagent` helper browses in a tab of its own and hands its tabs back;
- the current tab stays open for the user at the end, and the others close.

It does not say "a tab per task": a single-site task keeps its one tab.

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
- **A snapshot keeps earlier refs.** It drops only refs whose element has left the
  page, instead of clearing them all. Any agent may read any tab, and a read must
  not turn the owner's next click into "Stale element ref". Refs never repeat, and
  acting already refuses an element that is gone.
- **Opening leaves the active window alone.** If Task 1 finds that a new window
  takes focus, `open` puts the previously active window back.

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

That file is the only record of the pin. Every tab-aware reply (`navigate`,
`snapshot`, `act`, `tabs`, `open`) reports the live pin, and the run mirrors it. So a
pin set or cleared from the UI is never undone by the run's stale copy.

**A failed `open`** closes the tab it created before it reports the error, so no tab
leaks. **`close`** returns only once the tab is gone.

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
`activate` (follow) for the acting tab, unless a follow was attempted less than
1.5 s ago in this run. That dwell keeps parallel helpers from flickering the screen.
If the action opened a tab, Chromium already shows it, and nothing follows.

**Race guards.** The main agent's first call may go untargeted, to today's focused
tab, only before any helper has asked for a tab and before any tab work. While an
untargeted call is in flight, nothing follows, so no other tab can be brought
forward under it.

**Publishing.** The executor publishes the strip only once a run has two or more
tabs, plus the one update that takes it back below two. Publishes are serialized
in the order they were decided. A single-tab bot therefore writes no tab events.

**Loop guard.** The run's stuck-loop guard counts identical calls per agent.
Identical reads from parallel helpers are normal, not a loop.

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

Chromium stops `requestAnimationFrame` in a background *tab* whatever the flags,
so separate windows are the likely outcome. With several visible windows, the
main agent's untargeted first call relies on exactly one window having focus. The
spike checks that too, inside the computer image with its window manager.

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
  where `target: null` unpins.
  - It sends `activate` with `pin`, and is authorized like the other computer
    controls.
  - It echoes the result into the latest run's own thread, which may be a group
    thread.
  - A failed pin shows nothing; the view simply stays.
- **Lookup cost.** Mobile polls the status every 2 s, so the API reads the bot's
  latest run through a new `runs(botId, createdAt)` index.
- **Live delivery.** The event is forwarded for peer-bot and background runs too,
  since it carries no message content. Web applies it to the status without
  reloading the screen URL.

### Mobile

`apps/mobile/app/computer.tsx` gets a native menu (`MenuView`, as the repo's other
menus use), opened from a glass icon in the viewer's top bar. It is shown only with
two or more tabs:
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
| Run's tab cap reached | "This run has 12 tabs open, the most it can. Navigate one of yours with tab; browser_tabs lists them." |
| Unnamed navigate with two tabs of one's own | "You have 2 tabs: t…, t…. Name one with tab, or use newTab." |
| Both `tab` and `newTab` | "Use tab or newTab, not both." |
| Helper `browser_act` before any tab | "Open a tab with browser_navigate first." |
| Main agent `browser_act` with unknown refs once tabs are in use | "Take a browser_snapshot of the tab to act in first; its refs name the tab." |
| One `browser_act` with refs from two tabs | "These refs come from different tabs. Act in one tab per call." |
| Desktop action while another agent holds the screen, or the user pinned another tab | The desktop messages above |
| Computer without tab support | "This computer's browser cannot address tabs. Leave out tab and newTab." |
| A `tab` that is not a handle | "tab must be a tab handle such as t4k2z, from a result or browser_tabs." |
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
