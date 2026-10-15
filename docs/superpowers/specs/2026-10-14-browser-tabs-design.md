# Browser tabs: addressable tabs for the bot, its helpers, and the user

Status: approved design, not yet implemented
Date: 2026-10-14

## Why

A bot has one Chromium per screen, and every page-browser command acts on "the
focused visible tab". The helper (`infra/sandboxes/computer/rakazo-page-browser`)
finds that tab by attaching to every page target, up to 32, on every command, and
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

- **Agent-friendly.** An agent can list tabs and see what each holds, open a tab
  for a purpose, switch between tabs by handle, and read any tab. It is told when
  its click opened a new tab.
- **Safe parallelism.** The main agent and its helpers browse at the same time
  without acting in each other's tabs.
- **Transparent.** The user sees every tab's owner and purpose. The live screen
  follows the tab that acted last, the switch is animated in the strip, and the
  user can pin a tab.
- **No regression.** A bot that never names a tab behaves exactly as today. A
  single-tab bot shows no new UI.
- **Faster single-tab commands.** Targeting one tab removes the per-command probe of
  every open tab.

## What already exists

- The page-browser helper, a stateless Python CDP client run once per command by
  the Docker supervisor (`/computers/:id/browser`), with `navigate`, `snapshot`,
  `screenshot` and `act`. It is one process per command, not a daemon.
- Actions are dispatched as page JavaScript in an isolated world, not as input
  events, so they work in background tabs.
- One Chromium per bot screen (`:N`, CDP port `9221+N`), launched by
  `infra/sandboxes/computer/rakazo-browser`, which reuses a running instance.
- Tool calls carry an execution ID that includes the agent namespace (`main` or the
  helper's agent ID; `pi-runtime.ts`), so the executor knows which agent made each
  call.
- Live thread events over the realtime fanout. Helper progress already travels this
  way as `thread.subagent`.
- `computer.status` and the computer overlay (`ComputerWorkspace.tsx` on web,
  `apps/mobile/app/computer.tsx`) with a live noVNC screen.

Only the Docker computer runs the page-browser helper. E2B, Daytona, Box and
CreateOS fall back to `computer_act`, and this design leaves them unchanged.

## Approach

Each command names its tab. The helper stays stateless per command and gains
target-addressed commands. Tab ownership and purpose live in a small locked file
inside the computer, next to the Chromium they describe.

Two alternatives were rejected:

- **A persistent browser daemon in the computer.** It would also remove per-command
  startup cost, but it is a new long-lived process to supervise and a larger change
  for upstream. It stays a later performance project. The tool contract below does
  not change if it lands.
- **Driving Chromium with Playwright from the worker.** It reaches across the
  sandbox boundary and discards the helper's existing secret-fill and redaction
  guarantees.

## Agent-facing contract

### Handles

Tabs are named by short handles: `t1`, `t2`, and so on. A handle is stable for the
life of its tab and is never reused while the state file lives. Chrome target IDs
never reach the model.

### Tools

| Tool | Arguments | Notes |
|---|---|---|
| `browser_tabs` | `{ close?: string[] }` | New. Lists `{ tab, title, url, owner, purpose, front }` for every tab. `owner` is `"you"`, `"helper: <label>"`, or absent. `close` closes the caller's own tabs. |
| `browser_navigate` | `{ url, tab?, newTab?, purpose?, goal? }` | `newTab: true` opens a tab owned by the caller. `purpose` is a short note of what the tab is for, kept with the tab. |
| `browser_snapshot` | `{ tab? }` | Reads any tab, owned or not. |
| `browser_act` | `{ actions, tab?, goal? }` | Acts only in a tab the caller owns, or claims an unowned one. |

Every result includes the `tab` it ran in. `browser_navigate` and `browser_act`
results list tabs the call opened (`opened: ["t4"]`).

### Defaults

When `tab` is omitted, the agent uses the tab it used last in this run.
- The main agent's first call uses the front tab, which is today's behavior. Bots
  and prompts that never name a tab keep working.
- A helper's first `browser_navigate` without a tab opens a new tab for it. A
  helper's `browser_act` with no tab and none used yet fails with "Open a tab with
  browser_navigate first." Helpers never start by sharing a tab.

`browser_snapshot` without a tab and without a last-used tab reads the front tab.

### Ownership

- An owner is `{ run, agent }`, where `agent` is `main` or a helper's agent ID. It
  comes from the executor, never from tool arguments.
- Acting in, navigating, or closing a tab requires owning it. Acting in or
  navigating an unowned tab claims it, which covers tabs the user opened by hand.
- Acting in a tab another agent owns fails with: "t2 belongs to helper '<label>'.
  Read it with browser_snapshot."
- A tab opened by a page from an owned tab (its CDP `openerId`) gets the same
  owner, and the result reports it.
- When a helper ends (finished, failed, or aborted), ownership of its tabs passes to
  the main agent. The tabs stay open.
- Ownership is scoped to a run. A record whose `run` is not the current run reads as
  unowned, but its `purpose` stays.

### Limits

- At most 12 tabs per screen. Opening another fails with "Close a tab first."
  Nothing is closed silently.
- The helper cap stays at `MAX_PARALLEL_SUBAGENTS = 4`.

### Instructions

The bot's browser instructions gain one line: tabs can be opened and read in
parallel in one step, and each agent should act in its own tab.

## Computer side

### Helper commands

Every command takes `{ tab?, agent, run }` in its JSON args. The helper attaches
only to the resolved target instead of probing every page. New commands:

| Command | Effect |
|---|---|
| `tabs` | Returns every page target, with handles and owner records. |
| `open` | `Target.createTarget`, assigns a handle and owner, records `purpose`, then navigates. |
| `close` | Closes an owned tab. |
| `front` | `Target.activateTarget` on a tab. With `pin: true` it pins the view. `pin: false` unpins. |

`navigate`, `snapshot`, `screenshot` and `act` gain `tab` and the owner check.

### Tab state

The state lives in `/tmp/rakazo/tabs-<display>.json`, one file per screen:

```json
{
  "next": 5,
  "tabs": {
    "t1": { "target": "<cdp target id>", "run": "<run id>", "agent": "main", "purpose": "flights" }
  },
  "pinned": null,
  "frontChangedAt": 0
}
```

- Every helper invocation takes `fcntl.flock` on the file around read-modify-write.
  Claims are atomic, so two parallel claims of one tab cannot both win.
- Chromium's target list is the source of truth for which tabs exist. Records whose
  target is gone are dropped on every read. Targets with no record get a handle when
  first listed.
- An unreadable file is replaced: handles are reassigned from the live targets and
  no tab is owned. The main agent then claims the front tab, as today.

The ownership check runs in the helper, under the same lock as the claim or use.
The executor supplies `agent` and `run` from the tool call's execution ID.

### Pop-ups

After `act` and `navigate`, the helper lists targets whose `openerId` is the acted
tab and that have no record yet. It gives each one a handle and the acted tab's
owner, and returns them in `opened`.

### Background tabs

`rakazo-browser` adds `--disable-background-timer-throttling`,
`--disable-renderer-backgrounding` and `--disable-backgrounding-occluded-windows`.
Hidden tabs then run at full speed. The flags apply the next time Chromium starts.
The wrapper reuses a running instance, so they take effect after a computer image
update or browser restart.

### Follow

Bringing a tab to the front is for the viewer only, since actions do not need focus.
After an action, the helper activates the acting tab unless:
- a tab is pinned, or
- the front tab changed less than 1.5 s ago.

The dwell keeps parallel helpers from flickering the screen.

### Hidden-tab screenshots

`Page.captureScreenshot` on a hidden tab may not produce a frame. This is the only
known risk, and it is verified during implementation. If capture of a hidden tab
fails, the vision page decider falls back to text-only for that step, which is a
path it already has. Agents' own browsing never needs screenshots.

### Plumbing

The new commands and `tab` flow through each layer:
- the supervisor's zod schema for `/computers/:id/browser`;
- `docker-sandbox.ts`;
- `PageBrowserCommand` / `PageBrowserResult` in `packages/adapter-kit/src/types.ts`;
- `computer-browser.ts`;
- `browser-tools.ts`.

The in-process `PageBrowserSession` used for fake computers gains the same tab
model, so offline tests and the conformance suite cover it. The existing 512 KiB
reply cap is unchanged.

## User-facing surface

### Web (and Electron)

A tab strip above the live screen in `ComputerWorkspace`. It is shown only when
there are two or more tabs.

- **Chip text.** Each chip reads `owner · label`.
  - The owner is the bot's name for the main agent, or the helper's task label as
    its chat card shows it.
  - The label is the tab's `purpose`, else the page title.
  - The URL is the chip's title and part of its accessible name.
- **Front indicator.** An indicator under the front tab slides to the new front tab
  with a CSS transform transition, and the strip scrolls it into view. There is no
  transition under `prefers-reduced-motion`.
- **Pinning.** Clicking a chip pins the view to that tab and brings it to the front.
  While pinned, one **Follow** button appears; it unpins.

New copy: **"Follow"**. It appears only while a tab is pinned, because the user
needs one way back to following the agent. Everything else in the strip is data.

### Live updates

- The executor publishes `thread.browser_tabs`, carrying the full tab list, after any
  call that opened, closed or adopted a tab, changed the front tab, or changed a tab's
  title or URL.
- Opening the computer overlay loads the list with a new `computer.browserTabs`
  RPC. That also catches tabs the user opened on the screen.
- Pinning uses `computer.browserFront({ botId, tab, pin })`. It is authorized like
  the other computer controls.

### Chat

When the run has two or more tabs, browser activity lines are prefixed with the tab
label ("Hotels: Using the page"). No new chat cards.

### Mobile

`apps/mobile/app/computer.tsx` gets a native header menu, shown only with two or
more tabs:
- it lists `owner · label`, with a check on the front tab;
- choosing an item pins it;
- a **Follow** item appears while pinned.

There is no animated strip on mobile. The native menu is the better pattern there.

## Errors

No tab error throws. Each returns a structured result the model can act on:

| Case | Result |
|---|---|
| Closed or unknown handle | "t3 is closed. Call browser_tabs." |
| Tab owned by another agent | The ownership message above |
| Tab cap reached | "Close a tab first." |
| State file unreadable | Rebuilt as described; the call proceeds |
| Helper failure | Today's `fallback: "computer_act"` |
| User holds control, or teaching is active | Today's blocks, unchanged |

## Security

- **Ownership.** It is enforced in the helper under the state-file lock. `agent` and
  `run` come from the executor's execution ID, never from the model.
- **Secret fill.** `fill_secret` keeps its HTTPS and saved-origin checks, evaluated
  against the tab it targets.
- **Page decider.** The chain runs only in the call's tab. If a chain click opens a
  tab, the chain escalates with a new `opened_tab` reason instead of following,
  alongside the existing `left_origin` stop.
- **Redaction.** Tab titles and URLs pass through the run's secret redaction, in tool
  results and in `thread.browser_tabs`. That event is visible only to people who
  can already read the thread, which already shows URLs in activity lines.
- **Approval.** `browser_tabs` with `close` changes state. It is treated as an acting
  tool for workspace checkpoints and approval rules, and can only close the caller's
  own tabs.

## Testing

All tests are deterministic and offline.

- **Python helper** (`test_page_browser.py`, fake CDP): handle assignment and
  stability; claims under concurrent invocations (one wins); owner checks;
  pop-up adoption via `openerId`; follow dwell; pin and unpin; the 12-tab cap;
  rebuild after an unreadable file.
- **Adapters:**
  - fake `PageBrowserSession` tab model and the page-browser conformance cases for
    tabs;
  - `browser-tools` `tab` and `newTab` arguments and the `opened` and `tab` result
    fields;
  - hand-back of a helper's tabs;
  - the executor deriving the agent from the execution ID;
  - redaction of tab titles and URLs;
  - the chain's `opened_tab` escalation.
- **Supervisor:** route schema accepts the new commands and rejects unknown fields.
- **Web:**
  - strip component tests: hidden with one tab; pin shows Follow; Follow unpins; no
    transition under reduced motion;
  - `e2e/page-browser.spec.ts` gains a two-tab case, so CI captures the strip for
    the PR.
- **Mobile:** unit test for the menu items built from a tab list.
- **Manual, once, on a Docker computer:** two helpers browsing in separate tabs, and
  the hidden-tab screenshot behavior.

## Non-goals

- Shared goals or plans between the main agent, helpers and peer bots. That is the
  next design, and `purpose` is the seed it builds on.
- A persistent browser daemon.
- Tabs on non-Docker computer providers.
- Multiple Chromium windows, tiled views, or live per-tab thumbnails.
- Raising the helper cap.
