# Browser Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a bot, and the helpers it starts, each browse in their own tabs of the bot's one Chromium at the same time. Agents can list tabs, read any tab, and act only in their own. The user watches the tab that acted last, or pins one, in a tab strip.

**Architecture:**
- **The in-computer helper** gains tab addressing: a `target` on every command, plus `tabs`, `open`, `activate` and `close`. It echoes the tab it ran in, reports tabs an action opened, and reports the pin on every reply. The pin file is its only record. A snapshot no longer invalidates earlier refs, so one agent reading a tab never breaks its owner's next click.
- **One pure TypeScript registry per run**, held by the executor, decides ownership, hand-back, the cap, cleanup and the follow dwell. Helpers run inline in the parent's worker process, so that one map is already race-free. Handles are derived from tab IDs, so they survive a paused run's resume without being stored.
- **The user's view.** The executor publishes a `computer.browser_tabs` event. The API serves the latest one on `ComputerStatus`. Web renders a strip and mobile a native menu. One RPC pins a tab.

**Tech Stack:**
- TypeScript (ES modules, top-level `import type` only), pnpm workspaces, Turbo, Vitest, Zod 4, Biome.
- Prisma/Postgres, oRPC.
- React with `@rakazo/ui-web` and Lingui on web; Expo / React Native on mobile.
- The in-computer helper is stdlib Python driving Chromium over CDP.

**Spec:** `docs/superpowers/specs/2026-10-14-browser-tabs-design.md`. Read it, including its "Revisions after review", before Task 1.

## Global Constraints

Every task's requirements implicitly include these.

- **Code style.**
  - Top-level `import type` only, never inline type imports.
  - Reuse existing primitives; add no speculative options.
  - Biome's line width is 100. Each task's run step formats its files first with `pnpm exec biome check --write <files>`.
  - Tests are deterministic and offline, and no test reaches the network. The Playwright helper test in `apps/web/e2e/page-browser.spec.ts` drives a local Chromium against a loopback server, as it already does.
- **Tab handles.**
  - A handle is `t` plus 4 base36 characters derived from the tab's computer ID, by `tabHandle(target)`. It is the same in every registry, so a paused run that resumes keeps its handles.
  - CDP target IDs never reach the model.
- **No regression.** A bot that never names a tab behaves exactly as today:
  - it makes no extra helper calls;
  - it publishes no tab events, which go out only once a run has two or more tabs.
- **Limits.**
  - At most `MAX_RUN_TABS = 12` tabs opened by one run, counting opens still in flight.
  - The follow dwell is `FOLLOW_DWELL_MS = 1500`, measured from the last follow attempt.
  - The helper cap stays `MAX_PARALLEL_SUBAGENTS = 4`.
- **Ownership.**
  - An owner is `"main"` or a helper's agent ID, taken from the tool call's execution ID and never from tool arguments.
  - Reading is open to any agent. Acting needs ownership, or claims an unowned tab.
  - `browser_act` takes no tab: its refs name the tab they came from. A tab's refs accumulate across snapshots, so another agent's read never orphans them. An unnamed navigate needs the agent to have at most one tab of its own.
  - Once a run has two tabs, one agent at a time may use desktop actions. It holds the screen until it finishes, and follow stops meanwhile.
- **What agents read.**
  - Helpers see only tool descriptions and tool results, never the bot's system prompt. Every rule a helper must follow is enforced in code and explained by the refusal it meets.
  - The main agent's prompt adds only what no description can say: when to fan out, and what happens to tabs at the end. It does not tell a single-site task to open a tab.
- **The pin file is the only source of truth for the pin.** The helper reports `pinned` on every tab-aware reply. The run's registry mirrors it, and nothing else invents a pin.
- **Messages, verbatim** (`<h>` is a handle). Each one says what to do next.
  - `"<h> is closed. Call browser_tabs."`
  - `"<h> belongs to helper '<label>' until it finishes. Read it with browser_snapshot, or open your own tab with browser_navigate newTab."`
  - `"<h> belongs to the main agent. Read it with browser_snapshot, or open your own tab with browser_navigate newTab."`
  - `"This run has 12 tabs open, the most it can. Navigate one of yours with tab; browser_tabs lists them."`
  - `"You have <n> tabs: <h>, <h>. Name one with tab, or use newTab."`
  - `"Use tab or newTab, not both."`
  - `"Open a tab with browser_navigate first."`
  - `"Take a browser_snapshot of the tab to act in first; its refs name the tab."`
  - `"These refs come from different tabs. Act in one tab per call."`
  - `"The screen is in use by <the main agent | helper '<label>'>. Use page tools in your own tab."`
  - `"The user pinned another tab on screen, so desktop actions would land in it. Use page tools in <h>, or have the user choose Follow."`
  - `"Another agent's tab is in front, so desktop actions would land in it. Open a tab with browser_navigate first."`
  - `"tab must be a tab handle such as t4k2z, from a result or browser_tabs."`
  - `"This computer's browser cannot address tabs. Leave out tab and newTab."`
  - The helper's own error is `"That tab is closed."`
- **New UI copy:**
  - **"Follow"** appears only while a tab is pinned.
  - **"Tabs"** is the strip's accessible name and the mobile menu's title.

  Nothing else. Chip text is data, the activity line for `browser_tabs` reuses "Reading the page", and a failed pin shows no new error.
- **Closing tabs.**
  - Never close the last tab of a screen, the front tab, the pinned tab, or the main agent's current tab. That last one is brought forward at the end, unless the user pinned another.
  - Close tabs only once the run is terminal (completed, failed or cancelled), never while it is paused.
- **Public repo.** No secrets, real data, local paths, usernames or hostnames in commits, and no attribution lines in commit messages.
- **Intermediate commits.** Tasks 3–7 let a target ID reach a model-facing result until Task 8 strips it. The branch ships as a whole, and that is acceptable only because of that; record it in the ledger.

## Review Focus

These are the inputs the spec implies that a task-by-task reading could leave untested, most likely first. Each is pinned by a test in the task named.

1. **The main agent's first unnamed call while helpers browse.** Once a helper has asked for a tab, or while an unaddressed command is in flight, the focused tab may be a helper's. The main agent must never land there:
   - follow pauses while an unaddressed command is in flight;
   - after that, an unnamed navigate opens a tab, and an act goes where its refs came from or asks for a snapshot.

   Task 7.
2. **A tab closed under an agent**, by the user, the page or Chromium, while the agent still holds its handle. The agent gets the closed message, never a silent act in another tab. Tasks 2 and 7.
3. **A paused run that resumes.** Its handles still name the same tabs. Ownership resets and is reclaimed on use. Tasks 6 and 7.
4. **A computer image or supervisor that predates tabs**, or one that fails a probe once. An old one refuses tab arguments with the update message, and unnamed calls keep today's behavior. A one-off failure is not remembered. Tasks 3 and 7.
5. **A pin set or cleared from the UI while the run is active.** The next published tab list reflects the computer's pin, never a stale one. Tasks 2, 4 and 7.
6. **Run-end cleanup when every tab was opened by the run**, the front tab is unknown, a tab is pinned, or the run was cancelled. The front and pinned tabs stay, the main agent's final tab stays, at least one tab stays, and a cancelled run still cleans up. Tasks 6, 7 and 10.
7. **Agents working side by side.** The main agent reads a helper's tab while the helper is about to click; a helper falls back to desktop actions while follow would move the screen; the main agent compares four tabs at once. The helper's refs keep working, desktop clicks never land in another agent's tab, and no tab's page trims another's from context. Tasks 2, 4, 7 and 9.

## Existing code this plan builds on

- **The helper:** `infra/sandboxes/computer/rakazo-page-browser`.
  - `attach_page` probes up to 32 page targets and picks the focused visible one.
  - `navigate`, `snapshot`, `screenshot` and `act` take a CDP `session_id`.
  - `run(argv)` dispatches commands. Arguments arrive as one JSON line on stdin, or as argv in the e2e test.
  - Offline tests: `infra/sandboxes/computer/test_page_browser.py`, run by `infra/sandboxes/supervisor/src/page-browser-helper.test.ts`.
  - Real-Chromium test: `apps/web/e2e/page-browser.spec.ts`.
- **Chromium launch flags** are set in two places:
  - `infra/sandboxes/computer/rakazo-browser` (`FLAGS=`), pinned by `infra/sandboxes/supervisor/src/computer-spec.test.ts`;
  - `browserLauncherCommand` in `packages/core/src/node/desktop-runtime.ts`, tested through `ensureScreenCommand` in `desktop-runtime.test.ts`.
- **Supervisor route** `POST /computers/:id/browser` in `infra/sandboxes/supervisor/src/index.ts`: a zod discriminated union over commands, run in the bot's screen. Its tests are `page-browser-route.test.ts`.
- **Adapter contract:**
  - `packages/adapter-kit/src/types.ts`: the `Browser*Request` and `Browser*Result` types, `PageBrowserCommand` and `PageBrowserResult`;
  - `packages/adapter-kit/src/interfaces.ts`: the `BrowserProvider` interface.
- **Browser providers:**
  - `packages/adapters/src/computer-browser.ts`: `ComputerBrowserProvider`, the live path through `sandbox.pageBrowser`, with `runLive` validating replies;
  - `packages/adapters/src/fake-browser.ts`: `FakeBrowserProvider`, the offline jsdom path, with sessions keyed by `pageBrowserSessionKey(computer, context)`;
  - `EmulatorBrowserProvider` extends the fake.
- **Tool layer:**
  - `packages/adapters/src/browser-tools.ts`: `browserNavigateFromTool`, `browserSnapshotFromTool`, `browserActFromTool`, `chainForGoal`, `withChain` and `formatBrowserResult`;
  - `packages/adapters/src/page-decision-chain.ts`: `readPage`, `capture`, `runPageDecisionChain`.
- **Executor** (`packages/adapters/src/executor.ts`):
  - the browser dispatch is inside `applyTool` (search `PAGE_BROWSER_TOOL_NAMES.has(name)`);
  - subagent events are handled at `event.type === "subagent"`;
  - the terminal flush is `await workspaceCheckpoint.flush(); terminalCheckpointComplete = true;`;
  - `legacyPiToolCallId` decodes `["pi-tool", agent, callId]` execution IDs;
  - helpers' tool calls carry their agent ID in slot 1 (`pi-runtime.ts`, `executeSubagent`).
- **API:**
  - `apps/api/src/computer-status.ts` (`toComputerStatus`);
  - `apps/api/src/thread-target.ts` (`threadSnapshot` builds `computer`);
  - `apps/api/src/router.ts` (`computerStatus`, `computer.*` handlers, `computerContext`, `toComputerRef`).
- **Web:**
  - `apps/web/src/lib/thread-events.ts`: `reduceComputerStatus` and `isComputerStatusEvent`;
  - `apps/web/src/components/computer/ComputerWorkspace.tsx`;
  - the `ComputerWorkspace` usage in `apps/web/src/pages/Shell.tsx`.
- **Mobile:**
  - `apps/mobile/app/computer.tsx`, the full-screen viewer, polls `computer/status` every 2 s;
  - `presentMessageActionSheet` in `apps/mobile/lib/message-action-sheet.ts`;
  - the catalogs in `apps/mobile/lib/locales/{de,ru,zh}.ts`.

## Execution ledger

Record here, as tasks finish, anything that differs from a step's text, in the same table form as the page-decider plan's "Corrections from execution".

| Task | The plan said | What shipped, and why |
|---|---|---|

---

### Task 1: Spike — do hidden tabs keep working?

Throwaway. This decides `OPEN_IN_NEW_WINDOW` for Task 2, and whether Task 2 needs its window-restore item. Nothing from this task is committed except a ledger line.

Run it where agents actually browse: inside the computer image, with its window manager. Window stacking, focus and occlusion all differ under a bare X server.

Expect Chromium to stop running `requestAnimationFrame` in a background *tab* whatever the flags are, so the likely outcome is `OPEN_IN_NEW_WINDOW = True`. That changes the main agent's unaddressed call: `attach_page` then has several visible windows to choose from, and relies on exactly one having focus. So the probe checks that too. It also checks that opening one leaves the active window alone: a window that jumps in front would move the user's view past a pin, and land an agent's desktop clicks in another agent's tab.

**Files:**
- Create (scratchpad only, not the repo): `spike_hidden_tabs.py`

**Interfaces:**
- Produces, recorded in the ledger for Task 2:
  - the value of `OPEN_IN_NEW_WINDOW` (Python `True` or `False`);
  - `activeWindowKept` from the chosen row.

- [ ] **Step 1: Write the probe**

Write this to the session scratchpad directory:

```python
"""Throwaway: does a background tab or window keep rendering in the computer image?"""
import http.server
import importlib.machinery
import importlib.util
import json
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
import time

loader = importlib.machinery.SourceFileLoader("pb", sys.argv[1])
spec = importlib.util.spec_from_loader(loader.name, loader)
pb = importlib.util.module_from_spec(spec)
loader.exec_module(pb)

PAGE = b"""<!doctype html><title>probe</title><body>
<script>
window.frames_ = 0; (function tick() { window.frames_++; requestAnimationFrame(tick); })();
window.seen = 0; window.timers = 0; setInterval(() => window.timers++, 100);
</script>
<div style="height:3000px"></div><div id="lazy">lazy</div>
<script>
new IntersectionObserver((entries) => {
  for (const entry of entries) if (entry.isIntersecting) window.seen++;
}).observe(document.getElementById("lazy"));
setTimeout(() => document.getElementById("lazy").scrollIntoView(), 300);
</script>"""


class Page(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("content-type", "text/html")
        self.end_headers()
        self.wfile.write(PAGE)

    def log_message(self, *args):
        pass


server = socketserver.TCPServer(("127.0.0.1", 0), Page)
threading.Thread(target=server.serve_forever, daemon=True).start()
url = f"http://127.0.0.1:{server.server_address[1]}/"
CHROMIUM = shutil.which("chromium") or shutil.which("chromium-browser")
FLAGS = [
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
]


def trial(new_window: bool) -> dict:
    port = 9400 + (1 if new_window else 0)
    browser = subprocess.Popen(
        [CHROMIUM, "--no-sandbox", "--no-first-run", "--no-default-browser-check",
         f"--user-data-dir={tempfile.mkdtemp()}", f"--remote-debugging-port={port}",
         "--remote-debugging-address=127.0.0.1", *FLAGS, url],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        pb.wait_for_cdp(port, timeout_s=20)
        time.sleep(2)
        client = pb.CdpClient(pb.discover_ws_url(port))
        client.connect()
        first = [t["targetId"] for t in pb.page_targets(client)] if hasattr(pb, "page_targets") else [
            t["targetId"] for t in client.call("Target.getTargets")["targetInfos"] if t.get("type") == "page"]
        def active_window() -> str:
            return subprocess.run(["xdotool", "getactivewindow"], capture_output=True, text=True).stdout.strip()

        active_before = active_window()
        target = client.call(
            "Target.createTarget", {"url": url, "background": True, "newWindow": new_window}
        )["targetId"]
        session = client.call("Target.attachToTarget", {"targetId": target, "flatten": True})["sessionId"]
        time.sleep(3)
        active_after = active_window()

        def value(expression: str):
            return client.call("Runtime.evaluate", {"expression": expression, "returnByValue": True},
                               session_id=session)["result"].get("value")

        result = {
            "newWindow": new_window,
            "visibility": value("document.visibilityState"),
            "rafFrames": value("window.frames_"),
            "timerTicks": value("window.timers"),
            "intersections": value("window.seen"),
            # The window in front before the open is still the one in front.
            "activeWindowKept": bool(active_before) and active_before == active_after,
        }
        try:
            shot = client.call("Page.captureScreenshot", {"format": "png"}, session_id=session, timeout_s=8)
            result["screenshot"] = bool(shot.get("data"))
        except Exception as exc:  # noqa: BLE001
            result["screenshot"] = f"failed: {exc}"
        try:
            # Today's unaddressed path must still find the original, focused tab.
            attached = pb.attach_page(client)
            chosen = attached[1] if isinstance(attached, tuple) else None
            result["unaddressedStillOriginal"] = chosen in first if chosen else "unknown (pre-Task-2 helper)"
        except Exception as exc:  # noqa: BLE001
            result["unaddressedStillOriginal"] = f"failed: {exc}"
        client.close()
        return result
    finally:
        browser.terminate()
        browser.wait(10)


for new_window in (False, True):
    print(json.dumps(trial(new_window)))
```

- [ ] **Step 2: Run it inside the computer image**

Run from the repo root, with `$SCRATCH` set to the scratchpad directory. Build the image first if `rakazo/computer:local` is missing, the way `docs/self-host.md` builds the computer image.

```bash
docker run --rm --user 1000:1000 \
  -v "$PWD/infra/sandboxes/computer/rakazo-page-browser:/probe/helper:ro" \
  -v "$SCRATCH/spike_hidden_tabs.py:/probe/spike.py:ro" \
  --entrypoint bash rakazo/computer:local -lc \
  'Xvfb :9 -screen 0 1280x800x24 >/dev/null 2>&1 & sleep 1; export DISPLAY=:9;
   (command -v fluxbox >/dev/null && fluxbox >/dev/null 2>&1 &) ; sleep 1;
   python3 -I /probe/spike.py /probe/helper'
```

Expected: two JSON lines. Run it once now, against today's helper. The `unaddressedStillOriginal` check is only meaningful after Task 2, so Task 2's Step 4 runs it again.

- [ ] **Step 3: Decide**

A row passes when all of these hold:
- `rafFrames > 30`;
- `timerTicks > 20`;
- `intersections >= 1`;
- `screenshot` is `true`.

Then choose:
- **The `newWindow: false` row passes:** `OPEN_IN_NEW_WINDOW = False`.
- **Only the `newWindow: true` row passes:** `OPEN_IN_NEW_WINDOW = True`.
- **Neither row passes:** stop and report both rows to the user. The design's fallback does not hold, and the spec needs revisiting before any other task.

Then read `activeWindowKept` from the chosen row. When it is `false`, Task 2's item 9 applies; when it is `true`, Task 2 skips item 9.

- [ ] **Step 4: Record the result**

Add one ledger row with the chosen value, the chosen row's `activeWindowKept`, and both JSON lines. Do not commit the script.

---

### Task 2: Helper — tab addressing and tab commands

**Files:**
- Modify: `infra/sandboxes/computer/rakazo-page-browser`
- Modify: `infra/sandboxes/computer/rakazo-browser` (the `FLAGS=` line)
- Modify: `packages/core/src/node/desktop-runtime.ts` (the `exec "$browser" …` line in `browserLauncherCommand`)
- Test: `infra/sandboxes/computer/test_page_browser.py`
- Test: `infra/sandboxes/supervisor/src/computer-spec.test.ts` (the flags assertions near `--hide-crash-restore-bubble`)
- Test: `packages/core/src/node/desktop-runtime.test.ts`
- Test: `apps/web/e2e/page-browser.spec.ts`

**Interfaces:**
- Consumes: `OPEN_IN_NEW_WINDOW` and `activeWindowKept` from Task 1.
- Produces, the helper's JSON protocol:
  - **`navigate`, `snapshot`, `screenshot`, `act`** take an optional `"target"` (a CDP target ID). Every reply carries `"target"`: the tab it ran in.
  - **`navigate` and `act`** replies also carry `"opened"`: target IDs of page tabs whose `openerId` is that tab and that did not exist before the call.
  - **`tabs` →** `{"ok": true, "tabs": [{"target", "title", "url", "openerId"?}]}`, at most 64.
  - **`open {"url"}` →** `{"ok", "url", "title", "target"}`. It opens in the background, and does not change the front tab.
  - **`activate {"target": str|null, "pin"?: bool}` →** `{"ok": true, "front": str|null, "pinned": str|null}`.
    - `pin` true: pins and activates.
    - `pin` false: unpins, then activates the target when one is given.
    - `pin` absent (a follow): activates unless a live pin is set.
  - **`close {"target"}` →** `{"ok": true}`, once the target is really gone (it polls for up to 2 s).
  - **The pin on every reply.** `navigate`, `snapshot`, `act`, `tabs` and `open` replies carry `"pinned"`: the live pinned target or `null`. The pin file stays the one source of truth, so a pin set from the UI is never undone by a stale copy.
  - **A failed `open`** closes the tab it created before reporting the error, so no tab leaks.
  - **Refs survive other snapshots.** A snapshot no longer clears the page's earlier refs. It drops only those whose element has left the page. So one agent reading a tab leaves the refs its owner is about to use working.
  - **Errors** use the existing `{"ok": false, "error", "fallback": "computer_act"}` shape. A closed or unknown target fails with `"That tab is closed."`. An unaddressable tab is not "uncertain": only a dispatched `act` is.

- [ ] **Step 1: Write the failing offline tests**

Append to `infra/sandboxes/computer/test_page_browser.py`, before `if __name__ == "__main__":`. Add `import shutil` and `import tempfile` at the top, with the other imports.

```python
class FakeTargets:
    """A CDP stand-in for browser-level target commands."""

    def __init__(self, infos):
        self.infos = infos
        self.calls = []

    def call(self, method, params=None, *, session_id=None, timeout_s=30.0):
        self.calls.append((method, params))
        if method == "Target.getTargets":
            return {"targetInfos": self.infos}
        if method in ("Target.activateTarget", "Page.enable"):
            return {}
        if method == "Target.closeTarget":
            return {"success": True}
        if method == "Target.createTarget":
            return {"targetId": "T-new"}
        if method == "Target.attachToTarget":
            return {"sessionId": f"S-{params['targetId']}"}
        raise AssertionError(f"unexpected CDP call: {method}")


def page(target, url="https://example.test/", title="Example", opener=None):
    info = {"targetId": target, "type": "page", "url": url, "title": title}
    if opener:
        info["openerId"] = opener
    return info


class TabCommandTest(unittest.TestCase):
    def setUp(self):
        self.pins = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.pins, True)
        patcher = patch.object(helper, "PIN_DIR", self.pins)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_lists_page_tabs_only(self):
        client = FakeTargets([
            page("A"), page("B", opener="A"),
            {"targetId": "W", "type": "service_worker", "url": "", "title": ""},
        ])
        self.assertEqual(helper.list_tabs(client), {"ok": True, "tabs": [
            {"target": "A", "title": "Example", "url": "https://example.test/"},
            {"target": "B", "title": "Example", "url": "https://example.test/", "openerId": "A"},
        ]})

    def test_attaching_a_closed_tab_fails_before_attaching(self):
        client = FakeTargets([page("A")])
        with self.assertRaisesRegex(RuntimeError, "That tab is closed."):
            helper.attach_target(client, "gone")
        self.assertNotIn("Target.attachToTarget", [method for method, _ in client.calls])

    def test_reports_only_new_tabs_opened_by_the_acted_tab(self):
        client = FakeTargets([page("A"), page("B", opener="A"), page("C", opener="A"),
                              page("D", opener="X")])
        self.assertEqual(helper.opened_by(client, "A", {"A", "B"}), ["C"])

    def test_follow_activates_when_nothing_is_pinned(self):
        client = FakeTargets([page("A"), page("B")])
        self.assertEqual(helper.activate(client, "B", None),
                         {"ok": True, "front": "B", "pinned": None})
        self.assertIn(("Target.activateTarget", {"targetId": "B"}), client.calls)

    def test_follow_does_not_move_a_pinned_view(self):
        client = FakeTargets([page("A"), page("B")])
        helper.activate(client, "A", True)
        client.calls.clear()
        self.assertEqual(helper.activate(client, "B", None),
                         {"ok": True, "front": None, "pinned": "A"})
        self.assertNotIn("Target.activateTarget", [method for method, _ in client.calls])

    def test_a_pin_on_a_closed_tab_counts_as_unpinned(self):
        helper.activate(FakeTargets([page("A"), page("B")]), "A", True)
        client = FakeTargets([page("B")])
        self.assertEqual(helper.activate(client, "B", None),
                         {"ok": True, "front": "B", "pinned": None})

    def test_unpin_without_a_target_changes_no_tab(self):
        helper.activate(FakeTargets([page("A")]), "A", True)
        client = FakeTargets([page("A")])
        self.assertEqual(helper.activate(client, None, False),
                         {"ok": True, "front": None, "pinned": None})
        self.assertNotIn("Target.activateTarget", [method for method, _ in client.calls])

    def test_pinning_needs_a_target(self):
        with self.assertRaisesRegex(RuntimeError, "target"):
            helper.activate(FakeTargets([page("A")]), None, True)

    def test_open_rejects_a_bad_url_before_creating_a_tab(self):
        client = FakeTargets([page("A")])
        with self.assertRaisesRegex(RuntimeError, "credentials"):
            helper.open_tab(client, "https://user:fake-password@example.test/")
        self.assertEqual(client.calls, [])

    def test_open_creates_a_background_tab_and_navigates_it(self):
        client = FakeTargets([page("A"), page("T-new", url="about:blank", title="")])
        with patch.object(helper, "ensure_world"), \
                patch.object(helper, "navigate", return_value={"ok": True, "url": "https://example.test/", "title": "Example"}) as go:
            result = helper.open_tab(client, "https://example.test/")
        self.assertEqual(result, {"ok": True, "url": "https://example.test/", "title": "Example",
                                  "target": "T-new"})
        self.assertIn(("Target.createTarget", {"url": "about:blank", "background": True,
                                               "newWindow": helper.OPEN_IN_NEW_WINDOW}), client.calls)
        go.assert_called_once_with(client, "S-T-new", "https://example.test/")

    def test_actions_run_as_a_user_gesture(self):
        # Without one, Chromium's popup blocker drops target=_blank links and window.open.
        with patch.object(helper, "ensure_helpers"), patch.object(helper, "snapshot", return_value={"ok": True}), \
                patch.object(helper, "eval_json") as evaluate:
            evaluate.side_effect = [True, {}]
            helper.act(Mock(), "session", [{"kind": "click", "ref": "e1"}])
        self.assertEqual(evaluate.call_args_list[1].kwargs, {"user_gesture": True})
        self.assertEqual(evaluate.call_args_list[0].kwargs, {})

    def test_close_waits_until_the_tab_is_gone(self):
        client = FakeTargets([page("A"), page("B")])
        original = client.call

        def closing(method, params=None, **kwargs):
            result = original(method, params, **kwargs)
            if method == "Target.closeTarget":
                client.infos = [page("A")]
            return result

        client.call = closing
        self.assertEqual(helper.close_tab(client, "B"), {"ok": True})
        self.assertIn(("Target.closeTarget", {"targetId": "B"}), client.calls)

    def test_closing_an_unknown_tab_reports_it_closed(self):
        with self.assertRaisesRegex(RuntimeError, "That tab is closed."):
            helper.close_tab(FakeTargets([page("A")]), "gone")

    def test_a_failed_open_closes_the_tab_it_created(self):
        client = FakeTargets([page("A"), page("T-new", url="about:blank", title="")])
        with patch.object(helper, "ensure_world"), \
                patch.object(helper, "navigate", side_effect=RuntimeError("net::ERR_NAME_NOT_RESOLVED")):
            with self.assertRaisesRegex(RuntimeError, "ERR_NAME_NOT_RESOLVED"):
                helper.open_tab(client, "https://example.test/")
        self.assertIn(("Target.closeTarget", {"targetId": "T-new"}), client.calls)

    def test_replies_carry_the_live_pin(self):
        helper.activate(FakeTargets([page("A"), page("B")]), "A", True)
        self.assertEqual(helper.with_pin(FakeTargets([page("A")]), {"ok": True}),
                         {"ok": True, "pinned": "A"})
        self.assertEqual(helper.with_pin(FakeTargets([page("B")]), {"ok": True}),
                         {"ok": True, "pinned": None})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `python3 infra/sandboxes/computer/test_page_browser.py`

Expected: errors with `AttributeError: module 'page_browser' has no attribute 'PIN_DIR'`, and the same for `list_tabs`, `attach_target` and the others.

- [ ] **Step 3: Implement the helper changes**

In `infra/sandboxes/computer/rakazo-page-browser`:

1. **Add the constants** right after `WORLD_NAME = "rakazo-page-browser"`:

```python
# Set by the hidden-tab spike: whether agent tabs open as their own windows, so
# Chromium keeps rendering them while another tab is in front.
OPEN_IN_NEW_WINDOW = False  # Task 1's result
# One pin per screen, written only by `activate` with a pin, by atomic rename.
PIN_DIR = "/tmp/rakazo"
CLOSED_TAB = "That tab is closed."
```

2. **Add the target helpers** above `def attach_page`:

```python
def page_targets(client: CdpClient) -> list[dict[str, Any]]:
    infos = client.call("Target.getTargets").get("targetInfos") or []
    return [t for t in infos if isinstance(t, dict) and t.get("type") == "page"]


def list_tabs(client: CdpClient) -> dict[str, Any]:
    tabs = []
    for target in page_targets(client)[:64]:
        tab = {"target": target["targetId"], "title": str(target.get("title") or "")[:200],
               "url": str(target.get("url") or "")[:2048]}
        if target.get("openerId"):
            tab["openerId"] = target["openerId"]
        tabs.append(tab)
    return {"ok": True, "tabs": tabs}


def attach_target(client: CdpClient, target: str) -> str:
    if not any(t.get("targetId") == target for t in page_targets(client)):
        raise RuntimeError(CLOSED_TAB)
    session_id = client.call("Target.attachToTarget", {"targetId": target, "flatten": True})["sessionId"]
    client.call("Page.enable", session_id=session_id)
    ensure_world(client, session_id)
    return session_id


def opened_by(client: CdpClient, target: str, before: set[str]) -> list[str]:
    return [t["targetId"] for t in page_targets(client)
            if t.get("openerId") == target and t["targetId"] not in before]


def pin_path() -> str:
    return os.path.join(PIN_DIR, f"pinned-{display_num()}")


def read_pin(live: set[str]) -> str | None:
    try:
        with open(pin_path(), encoding="utf-8") as handle:
            value = handle.read().strip()
    except OSError:
        return None
    return value if value in live else None


def write_pin(target: str | None) -> None:
    path = pin_path()
    if target is None:
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
        return
    os.makedirs(PIN_DIR, exist_ok=True)
    temporary = f"{path}.{os.getpid()}"
    with open(temporary, "w", encoding="utf-8") as handle:
        handle.write(target)
    os.replace(temporary, path)


def activate(client: CdpClient, target: str | None, pin: bool | None) -> dict[str, Any]:
    if pin is True and not target:
        raise RuntimeError("Pinning needs a target")
    live = {t["targetId"] for t in page_targets(client)}
    if target is not None and target not in live:
        raise RuntimeError(CLOSED_TAB)
    if pin is True:
        write_pin(target)
    elif pin is False:
        write_pin(None)
    pinned = read_pin(live)
    front = None
    if target is not None and (pin is True or pinned is None):
        client.call("Target.activateTarget", {"targetId": target})
        front = target
    return {"ok": True, "front": front, "pinned": pinned}


def close_tab(client: CdpClient, target: str) -> dict[str, Any]:
    if not any(t.get("targetId") == target for t in page_targets(client)):
        raise RuntimeError(CLOSED_TAB)
    if not client.call("Target.closeTarget", {"targetId": target}).get("success", True):
        raise RuntimeError("Could not close the tab")
    # closeTarget returns once closing starts; the tab is listed until it is gone.
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline:
        if not any(t.get("targetId") == target for t in page_targets(client)):
            break
        time.sleep(0.05)
    return {"ok": True}


def with_pin(client: CdpClient, result: dict[str, Any]) -> dict[str, Any]:
    """Add the live pin to a reply: the pin file is the only record of it."""
    return {**result, "pinned": read_pin({t["targetId"] for t in page_targets(client)})}
```

3. **Change `attach_page` so it returns `(session_id, target_id)`.** Keep each candidate's target ID next to its session:

```python
def attach_page(client: CdpClient) -> tuple[str, str]:
    candidates = []
    for page in page_targets(client)[:32]:
        attached = client.call("Target.attachToTarget", {
            "targetId": page["targetId"], "flatten": True,
        })
        session_id = attached["sessionId"]
        try:
            client.call("Page.enable", session_id=session_id)
            ensure_world(client, session_id)
            if eval_json(client, session_id, 'document.visibilityState === "visible"'):
                focused = eval_json(client, session_id, "document.hasFocus()")
                candidates.append((session_id, page["targetId"], focused))
        except Exception:
            continue
    focused = [(session, target) for session, target, focus in candidates if focus]
    if len(focused) == 1:
        selected = focused[0]
    elif len(candidates) == 1:
        selected = candidates[0][:2]
    else:
        raise RuntimeError("No unambiguous visible browser tab. Use desktop tools to select a tab.")
    ensure_world(client, selected[0])
    return selected
```

4. **Split the URL check out of `navigate`, and add `open_tab` below `navigate`.** Replace `navigate`'s first three lines (parse, reject, raise) with `check_url(url)`, and define:

```python
def check_url(url: str) -> None:
    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https") or parsed.username or parsed.password:
        raise RuntimeError("Only HTTP(S) URLs without embedded credentials are supported")


def open_tab(client: CdpClient, url: str) -> dict[str, Any]:
    check_url(url)
    target = client.call("Target.createTarget", {
        "url": "about:blank", "background": True, "newWindow": OPEN_IN_NEW_WINDOW,
    })["targetId"]
    try:
        session_id = attach_target(client, target)
        return {**navigate(client, session_id, url), "target": target}
    except Exception:
        # The caller never learns a failed tab's id; close it rather than leak it.
        client.call("Target.closeTarget", {"targetId": target})
        raise
```

5. **In `run`, replace the block from `session_id = attach_page(client)` through the unknown-command `return 2`:**

```python
            if command == "tabs":
                result = with_pin(client, list_tabs(client))
            elif command == "open":
                result = with_pin(client, open_tab(client, str(args.get("url") or "")))
            elif command == "activate":
                pin = args.get("pin")
                result = activate(client, args.get("target"), pin if isinstance(pin, bool) else None)
            elif command == "close":
                result = close_tab(client, str(args.get("target") or ""))
            elif command in ("navigate", "snapshot", "screenshot", "act"):
                requested = args.get("target")
                if isinstance(requested, str) and requested:
                    target = requested
                    session_id = attach_target(client, target)
                else:
                    session_id, target = attach_page(client)
                before = ({t["targetId"] for t in page_targets(client)}
                          if command in ("navigate", "act") else set())
                if command == "navigate":
                    result = navigate(client, session_id, str(args.get("url") or ""))
                elif command == "snapshot":
                    result = snapshot(client, session_id, bool(args.get("extended")))
                elif command == "screenshot":
                    result = screenshot(client, session_id)
                else:
                    actions = args.get("actions")
                    if not isinstance(actions, list):
                        raise RuntimeError("actions must be an array")
                    dispatched = True
                    result = act(client, session_id, actions)
                result["target"] = target
                if command in ("navigate", "act"):
                    try:
                        result["opened"] = opened_by(client, target, before)
                    except Exception:  # noqa: BLE001
                        result["opened"] = []
                if command != "screenshot":
                    result = with_pin(client, result)
            else:
                result = {
                    "ok": False,
                    "error": f"unknown command: {command}",
                    "fallback": "computer_act",
                }
                print(json.dumps(result))
                return 2
```

   Also, define `dispatched = False` just before `run`'s outer `try:`. In the outer `except`, replace `"uncertain": command == "act"` with `"uncertain": dispatched`. A tab that could not even be attached was never acted in.

6. **Make actions user gestures.** An agent's click is a deliberate click, and Chromium's popup blocker drops a `target=_blank` link or `window.open` that is not one, so a tab a click should open never appears. Give `eval_json` a keyword parameter, `user_gesture: bool = False`. When it is true, add `"userGesture": True` to the `Runtime.evaluate` params. In `act`, pass `user_gesture=True` only on the action evaluation: the `window.__rakazoPageBrowser.{kind}(…)` call, not the stale-ref preflight.

7. **Set `OPEN_IN_NEW_WINDOW` to Task 1's value.**

8. **Keep refs when the page is read again.** Any agent may read any tab, and today each snapshot clears the page's ref map. So the main agent reading a helper's tab would turn the helper's next click into "Stale element ref". In `EVAL_HELPERS`' `snapshot`, replace `refMap.clear();` with:

```js
      // Another agent's read of this tab must not invalidate the refs its owner holds.
      // Refs never repeat, and resolve() already refuses an element that left the page.
      for (const [ref, el] of refMap) if (!el.isConnected) refMap.delete(ref);
```

9. **Only when Task 1 recorded `activeWindowKept: false`:** put the active window back after opening. Otherwise skip this item and say so in the ledger.
   - Add `import subprocess` to the helper's imports.
   - Add above `open_tab`:

```python
def active_window() -> str | None:
    """The X window in front. The helper runs with the screen's DISPLAY."""
    try:
        done = subprocess.run(["xdotool", "getactivewindow"], capture_output=True, text=True, timeout=2)
    except (OSError, subprocess.SubprocessError):
        return None
    return done.stdout.strip() or None


def activate_window(window: str) -> None:
    try:
        subprocess.run(["xdotool", "windowactivate", window], capture_output=True, timeout=2)
    except (OSError, subprocess.SubprocessError):
        pass
```

   - In `open_tab`, take `before = active_window()` right after `check_url(url)`, and right after the `createTarget` call add `if before: activate_window(before)`, with the comment `# A new window takes focus here; give the screen back to the tab the user was watching.`
   - Add to the Step 1 tests:

```python
    def test_open_gives_the_screen_back(self):
        client = FakeTargets([page("A"), page("T-new", url="about:blank", title="")])
        with patch.object(helper, "active_window", return_value="42"), \
                patch.object(helper, "activate_window") as restore, \
                patch.object(helper, "navigate", return_value={"ok": True, "url": "https://example.test/", "title": "Example"}):
            helper.open_tab(client, "https://example.test/")
        restore.assert_called_once_with("42")
```

- [ ] **Step 4: Run the offline tests**

Run: `python3 infra/sandboxes/computer/test_page_browser.py`

Expected: every test passes, the existing ones included.

- [ ] **Step 5: Add the launch flags, test first**

1. **Write the flag assertions.**
   - In `infra/sandboxes/supervisor/src/computer-spec.test.ts`, after `expect(flags).toMatch(/--disable-session-crashed-bubble/);`, add:

     ```ts
     // Agents act in background tabs; hidden tabs must keep running at full speed.
     expect(flags).toMatch(/--disable-background-timer-throttling/);
     expect(flags).toMatch(/--disable-renderer-backgrounding/);
     expect(flags).toMatch(/--disable-backgrounding-occluded-windows/);
     ```

   - In `packages/core/src/node/desktop-runtime.test.ts`, inside `it("drops libnss_wrapper before the screen browser exec", …)`, after the `command -v rakazo-browser` assertion, add:

     ```ts
     expect(command).toContain(
       "--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows",
     );
     ```

2. **Run them and watch them fail.** Run: `pnpm vitest run infra/sandboxes/supervisor/src/computer-spec.test.ts packages/core/src/node/desktop-runtime.test.ts`. Expected: the new assertions fail.

3. **Add the flags at both launch sites.** In `infra/sandboxes/computer/rakazo-browser`'s `FLAGS=` line, and in the `exec "$browser" …` line of `browserLauncherCommand`, insert this right after `--hide-crash-restore-bubble`:

   ```
   --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows
   ```

   Above `FLAGS=` in `rakazo-browser`, add the comment `# Agents act in background tabs: hidden tabs keep running at full speed.`

4. **Re-run.** Same command. Expected: PASS.

- [ ] **Step 6: Real-Chromium coverage in the e2e helper test**

In `apps/web/e2e/page-browser.spec.ts`:

1. Change the fixture server so `/popup` serves a page with a new-tab link, and everything else keeps today's HTML:

```ts
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url?.startsWith("/popup")) {
      res.end(`<!doctype html><title>Popup source</title><a href="/opened" target="_blank">Open</a>`);
      return;
    }
    res.end(`<!doctype html><title>Fixture</title><p>Readable article content</p>
      <label>Name <input id="name"></label><input aria-label="Password" type="password" value="fake-test-password">
      <button id="save" onclick="this.dataset.clicks=Number(this.dataset.clicks||0)+1">Save</button>
      <label><input type="checkbox">Agree</label><button disabled>Disabled</button>
      <script>window.__rakazoPageBrowser={snapshot:()=>({title:'spoofed'})};</script>`);
  });
```

2. Before the test's `finally`, after its last existing assertion, add:

```ts
    // Tabs: addressed commands run in their own tab, whichever tab is in front.
    const listed = await command("tabs");
    expect(listed.ok).toBe(true);
    // An unnamed command runs in the focused tab and says which one it was.
    const first = snapshot.target as string;
    expect(listed.tabs.map((tab: { target: string }) => tab.target)).toContain(first);
    const opened = await command("open", { url: `http://127.0.0.1:${address.port}/popup` });
    expect(opened).toMatchObject({ ok: true, title: "Popup source", target: expect.any(String) });
    expect(opened.target).not.toBe(first);
    const source = await command("snapshot", { target: opened.target });
    expect(source).toMatchObject({ ok: true, target: opened.target, title: "Popup source" });
    const back = await command("snapshot", { target: first });
    expect(back).toMatchObject({ ok: true, target: first, title: "Fixture" });
    // Another agent reading the tab leaves the refs its owner holds working.
    await command("snapshot", { target: first });
    expect(
      await command("act", { target: first, actions: [{ kind: "click", ref: ref(back, "Agree") }] }),
    ).toMatchObject({ ok: true, completed: 1 });

    // A click that opens a tab reports it, attributed to the tab that opened it.
    const link = source.elements.find((element: { name: string }) => element.name === "Open");
    const clicked = await command("act", {
      target: opened.target,
      actions: [{ kind: "click", ref: link.ref }],
    });
    expect(clicked).toMatchObject({ ok: true, target: opened.target });
    await expect(async () => {
      const after = (await command("tabs")).tabs as Array<{ target: string; openerId?: string }>;
      expect(after.some((tab) => tab.openerId === opened.target)).toBe(true);
    }).toPass({ timeout: 5_000 });

    // Follow brings a tab to the front; a closed tab is refused, never replaced.
    expect(await command("activate", { target: opened.target })).toMatchObject({
      ok: true,
      front: opened.target,
    });
    expect(await command("close", { target: opened.target })).toMatchObject({ ok: true });
    expect(await command("snapshot", { target: opened.target })).toMatchObject({
      ok: false,
      error: "That tab is closed.",
    });
```

`clicked.opened` is not asserted to be non-empty. The popup can register a moment after the act returns, so the `toPass` block checks attribution instead. A popup that registers late shows up unowned on the next `tabs` read, and acting in it claims it.

3. Playwright launches Chromium with `--disable-popup-blocking`, which would hide whether the user-gesture change works. Add `ignoreDefaultArgs: ["--disable-popup-blocking"]` to this test's `chromium.launchPersistentContext(…)` options, so the popup above opens only because the click is a user gesture.

4. Run: `pnpm --filter @rakazo/web exec playwright test e2e/page-browser.spec.ts`

   Then rerun Task 1's probe, now against the updated helper, and record whether `unaddressedStillOriginal` is `true` with the chosen `OPEN_IN_NEW_WINDOW` in the ledger.

Expected: PASS. If Playwright's browser is missing, install it with `pnpm --filter @rakazo/web exec playwright install chromium-headless-shell`.

- [ ] **Step 7: Commit**

```bash
git add infra/sandboxes/computer/rakazo-page-browser infra/sandboxes/computer/test_page_browser.py \
  infra/sandboxes/computer/rakazo-browser infra/sandboxes/supervisor/src/computer-spec.test.ts \
  packages/core/src/node/desktop-runtime.ts packages/core/src/node/desktop-runtime.test.ts \
  apps/web/e2e/page-browser.spec.ts
git commit -m "feat(computer): address browser tabs by target in the page helper"
```

---

### Task 3: Adapter contract, supervisor route, and the live provider

**Files:**
- Modify: `packages/adapter-kit/src/types.ts`
- Modify: `packages/adapter-kit/src/interfaces.ts` (`BrowserProvider`)
- Modify: `infra/sandboxes/supervisor/src/index.ts` (the `/computers/:id/browser` schema)
- Modify: `packages/adapters/src/computer-browser.ts`
- Test: `infra/sandboxes/supervisor/src/page-browser-route.test.ts`
- Test: `packages/adapters/src/computer-browser.test.ts`

**Interfaces:**
- Consumes: Task 2's helper protocol.
- Produces, in `@rakazo/adapter-kit`:

```ts
export interface BrowserTabInfo {
  /** The computer's own id for the tab (a CDP target id). Never shown to the model. */
  target: string;
  title: string;
  url: string;
  /** The tab whose page opened this one, when a page opened it. */
  openerId?: string;
}
export interface BrowserTabsRequest { signal?: AbortSignal }
export interface BrowserTabsResult {
  tabs: BrowserTabInfo[];
  /** The viewer's pinned tab as the computer reports it; absent on images without tabs. */
  pinned?: string | null;
  fallback?: "computer_act";
  error?: string;
}
export interface BrowserOpenTabRequest { url: string; signal?: AbortSignal }
export interface BrowserActivateTabRequest {
  /** null only with `pin: false`, which unpins without changing the front tab. */
  target: string | null;
  /** true pins the view to `target`; false unpins; absent is a follow, skipped while pinned. */
  pin?: boolean;
  signal?: AbortSignal;
}
export interface BrowserActivateTabResult {
  front: string | null;
  pinned: string | null;
  fallback?: "computer_act";
  error?: string;
}
export interface BrowserCloseTabRequest { target: string; signal?: AbortSignal }
export interface BrowserCloseTabResult { ok: boolean; error?: string }
```

These existing types gain fields:
- `target?: string` on `BrowserNavigateRequest`, `BrowserSnapshotRequest`, `BrowserActRequest` and `BrowserScreenshotRequest`: the tab to use, defaulting to the focused one.
- `target?: string` on `BrowserNavigateResult`, `BrowserSnapshotResult` and `BrowserActResult`: the tab it ran in.
- `opened?: string[]` on `BrowserNavigateResult` and `BrowserActResult`.
- `pinned?: string | null` on `BrowserNavigateResult`, `BrowserSnapshotResult` and `BrowserActResult`: the computer's pin, mirrored by the run (Task 7).

`BrowserProvider` gains four optional methods: `tabs?`, `openTab?`, `activateTab?` and `closeTab?`. Their signatures are below.

- [ ] **Step 1: Write the failing supervisor route tests**

Append to `infra/sandboxes/supervisor/src/page-browser-route.test.ts`:

```ts
it("forwards tab commands and an addressed snapshot to the helper", async () => {
  for (const body of [
    { command: "snapshot", target: "T1" },
    { command: "tabs" },
    { command: "open", url: "https://example.test/" },
    { command: "activate", target: "T1", pin: true },
    { command: "activate", target: null, pin: false },
    { command: "close", target: "T1" },
  ]) {
    mock.stdin.length = 0;
    expect((await browser(body)).status).toBe(200);
    expect(mock.stdin.join("")).toBe(`${JSON.stringify(body)}\n`);
  }
});

it("refuses an open with credentials in the URL before the helper runs", async () => {
  mock.exec.mockClear();
  const response = await browser({ command: "open", url: "https://user:fake@example.test/" });
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(mock.exec).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run infra/sandboxes/supervisor/src/page-browser-route.test.ts`

Expected: FAIL. The schema strips `target` from the snapshot, so the echoed stdin differs, and rejects `tabs`/`open`/`activate`/`close`.

- [ ] **Step 3: Extend the route schema**

In `infra/sandboxes/supervisor/src/index.ts`, above `app.post("/computers/:id/browser"`, add:

```ts
/** An http(s) URL with no embedded credentials. */
const pageUrl = z
  .string()
  .url()
  .max(8192)
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password;
  });
/** A CDP target id naming one tab. */
const tabTarget = z.string().min(1).max(128);
```

Then change the union members to:

```ts
      z.object({ command: z.literal("navigate"), url: pageUrl, target: tabTarget.optional() }),
      z.object({
        command: z.literal("snapshot"),
        extended: z.boolean().optional(),
        target: tabTarget.optional(),
      }),
      z.object({ command: z.literal("screenshot"), target: tabTarget.optional() }),
      z.object({
        command: z.literal("act"),
        actions: /* unchanged */,
        target: tabTarget.optional(),
      }),
      z.object({ command: z.literal("tabs") }),
      z.object({ command: z.literal("open"), url: pageUrl }),
      z.object({
        command: z.literal("activate"),
        target: tabTarget.nullable(),
        pin: z.boolean().optional(),
      }),
      z.object({ command: z.literal("close"), target: tabTarget }),
```

Keep the `act` member's `actions` schema exactly as it is. Leave everything else in the route unchanged: the stdin and argv handling, the caps, and `uncertain: body.command === "act"`.

- [ ] **Step 4: Re-run the route tests**

Run: same command. Expected: PASS, along with every existing route test.

- [ ] **Step 5: Add the types**

1. In `packages/adapter-kit/src/types.ts`, add the `target`, `opened` and `pinned` fields listed under Interfaces to the existing request and result interfaces, each with a one-line doc comment.
2. Add the new interfaces right after `BrowserScreenshotResult`.
3. Replace `PageBrowserCommand` and `PageBrowserResult`:

```ts
export type PageBrowserCommand =
  | { command: "navigate"; url: string; target?: string }
  | { command: "snapshot"; extended?: boolean; target?: string }
  | { command: "screenshot"; target?: string }
  | { command: "act"; actions: BrowserActStep[]; target?: string }
  | { command: "tabs" }
  | { command: "open"; url: string }
  | { command: "activate"; target: string | null; pin?: boolean }
  | { command: "close"; target: string };

export type PageBrowserResult = Partial<
  BrowserSnapshotResult &
    BrowserActResult &
    BrowserScreenshotResult &
    BrowserTabsResult &
    BrowserActivateTabResult
> & { ok: boolean };
```

4. In `packages/adapter-kit/src/interfaces.ts`, add the new types to the existing `import type { … } from "./types.js"` list. Add these to `BrowserProvider` after `screenshot?`:

```ts
  /** The computer's page tabs. Optional: older computer images have no tab commands. */
  tabs?(
    computer: ComputerRef,
    request: BrowserTabsRequest,
    context: AdapterContext,
  ): Promise<BrowserTabsResult>;
  /** Open a background tab at a URL; the result's `target` names it. */
  openTab?(
    computer: ComputerRef,
    request: BrowserOpenTabRequest,
    context: AdapterContext,
  ): Promise<BrowserNavigateResult>;
  /** Bring a tab to the front for the viewer, or pin or unpin the view. */
  activateTab?(
    computer: ComputerRef,
    request: BrowserActivateTabRequest,
    context: AdapterContext,
  ): Promise<BrowserActivateTabResult>;
  closeTab?(
    computer: ComputerRef,
    request: BrowserCloseTabRequest,
    context: AdapterContext,
  ): Promise<BrowserCloseTabResult>;
```

5. Export the new types from `packages/adapter-kit/src/index.ts` if it lists types explicitly. If it re-exports `./types.js` wholesale, nothing changes.

- [ ] **Step 6: Write the failing live-provider tests**

Append inside `describe("computer browser provider", …)` in `packages/adapters/src/computer-browser.test.ts`:

```ts
  it("addresses a tab and reports where it ran and what it opened", async () => {
    const liveDriver = vi.fn(async (_c: ComputerRef, request: { command: string }) => {
      if (request.command === "act") {
        return {
          ok: true,
          completed: 1,
          url: "https://example.test/",
          title: "Live",
          tree: "",
          elements: [],
          target: "T2",
          // "" stands for a malformed entry; it must be dropped.
          opened: ["T3", ""],
          pinned: null,
        };
      }
      if (request.command === "tabs") {
        return {
          ok: true,
          pinned: "T2",
          tabs: [
            { target: "T2", title: "Live", url: "https://example.test/" },
            { target: 9, title: "Bad" } as never,
          ],
        };
      }
      if (request.command === "open") {
        return { ok: true, url: "https://example.test/", title: "Live", target: "T4" };
      }
      if (request.command === "activate") return { ok: true, front: "T2", pinned: null };
      if (request.command === "close") return { ok: true };
      return { ok: false, error: "unexpected" };
    });
    const provider = new ComputerBrowserProvider({ liveDriver });
    const computer: ComputerRef = { id: "c", botId: "b", kind: "docker", providerRef: "c" };
    const act = await provider.act(
      computer,
      { actions: [{ kind: "click", ref: "e1" }], target: "T2" },
      baseContext,
    );
    expect(liveDriver).toHaveBeenCalledWith(
      computer,
      { command: "act", actions: [{ kind: "click", ref: "e1" }], target: "T2" },
      baseContext,
    );
    expect(act).toMatchObject({ ok: true, target: "T2", opened: ["T3"], pinned: null });
    expect(await provider.tabs(computer, {}, baseContext)).toEqual({
      tabs: [{ target: "T2", title: "Live", url: "https://example.test/" }],
      pinned: "T2",
    });
    expect(
      await provider.openTab(computer, { url: "https://example.test/" }, baseContext),
    ).toMatchObject({ url: "https://example.test/", title: "Live", target: "T4" });
    expect(await provider.activateTab(computer, { target: "T2" }, baseContext)).toEqual({
      front: "T2",
      pinned: null,
    });
    expect(await provider.closeTab(computer, { target: "T2" }, baseContext)).toEqual({ ok: true });
  });

  it("reports an older computer image's missing tab commands as a fallback", async () => {
    const liveDriver = vi.fn(async () => ({
      ok: false,
      error: "unknown command: tabs",
      fallback: "computer_act" as const,
    }));
    const provider = new ComputerBrowserProvider({ liveDriver });
    const computer: ComputerRef = { id: "c", botId: "b", kind: "docker", providerRef: "c" };
    expect(await provider.tabs(computer, {}, baseContext)).toMatchObject({
      tabs: [],
      fallback: "computer_act",
    });
    expect(
      await provider.openTab(computer, { url: "https://example.test/" }, baseContext),
    ).toMatchObject({ fallback: "computer_act" });
  });
```

- [ ] **Step 7: Run them and watch them fail**

Run: `pnpm vitest run packages/adapters/src/computer-browser.test.ts`

Expected: FAIL. `provider.tabs` is not a function, and `act`'s reply drops `target` and `opened`.

- [ ] **Step 8: Implement in `ComputerBrowserProvider`**

In `packages/adapters/src/computer-browser.ts`:

1. **Pass the target on every command.** Change the four existing commands:
   - `{ command: "navigate", url: request.url, target: request.target }`
   - `{ command: "snapshot", extended: request.extended, target: request.target }`
   - `{ command: "screenshot", target: request.target }`
   - `{ command: "act", actions: request.actions, target: request.target }`

2. **Add these private helpers** below `formatTree`:

```ts
/** The tab a reply ran in, when the computer reported one. */
function targetOf(live: LivePayload): { target?: string } {
  return typeof live.target === "string" && live.target ? { target: live.target } : {};
}

/** Tabs a reply says the call opened; anything malformed is dropped. */
function openedOf(live: LivePayload): { opened?: string[] } {
  const opened = Array.isArray(live.opened)
    ? live.opened.filter((value): value is string => typeof value === "string" && value !== "")
    : [];
  return opened.length > 0 ? { opened } : {};
}

/** The computer's pin, when the reply reports one (a target, or null for none). */
function pinnedOf(live: LivePayload): { pinned?: string | null } {
  return typeof live.pinned === "string" || live.pinned === null ? { pinned: live.pinned } : {};
}

/** Listed tabs with a usable id, title and URL; anything else is dropped. */
function tabsOf(live: LivePayload): BrowserTabInfo[] {
  return (Array.isArray(live.tabs) ? live.tabs : []).filter(
    (tab): tab is BrowserTabInfo =>
      Boolean(tab) &&
      typeof tab.target === "string" &&
      tab.target !== "" &&
      typeof tab.title === "string" &&
      typeof tab.url === "string",
  );
}
```

3. **Spread them into the returns:**
   - `navigate` (success): `...targetOf(live), ...openedOf(live), ...pinnedOf(live)`;
   - `snapshot` (success): `...targetOf(live), ...pinnedOf(live)`;
   - `act` (success **and** failure): `...targetOf(live ?? {}), ...openedOf(live ?? {}), ...pinnedOf(live ?? {})`. A partial act can open a tab before a later step fails.

   Add `BrowserTabInfo` to the type import.

4. **Add the four methods** after `act`. Add `BrowserActivateTabRequest`, `BrowserActivateTabResult`, `BrowserCloseTabRequest`, `BrowserCloseTabResult`, `BrowserOpenTabRequest`, `BrowserTabsRequest` and `BrowserTabsResult` to the type import.

```ts
  async tabs(
    computer: ComputerRef,
    request: BrowserTabsRequest,
    context: AdapterContext,
  ): Promise<BrowserTabsResult> {
    if (this.canUseInProcess(computer)) return this.fake.tabs(computer, request, context);
    const live = await this.runLive(computer, { command: "tabs" }, context);
    if (live?.ok !== true || live.fallback === "computer_act" || !Array.isArray(live.tabs)) {
      return { tabs: [], fallback: "computer_act", error: live?.error || DETACHED_MESSAGE };
    }
    return { tabs: tabsOf(live), ...pinnedOf(live) };
  }

  async openTab(
    computer: ComputerRef,
    request: BrowserOpenTabRequest,
    context: AdapterContext,
  ): Promise<BrowserNavigateResult> {
    if (this.canUseInProcess(computer)) return this.fake.openTab(computer, request, context);
    const live = await this.runLive(computer, { command: "open", url: request.url }, context);
    if (live?.ok !== true || live.fallback === "computer_act" || typeof live.target !== "string") {
      return {
        url: request.url,
        title: "",
        fallback: "computer_act",
        error: live?.error || DETACHED_MESSAGE,
      };
    }
    return {
      url: typeof live.url === "string" ? live.url : request.url,
      title: typeof live.title === "string" ? live.title : "",
      target: live.target,
    };
  }

  async activateTab(
    computer: ComputerRef,
    request: BrowserActivateTabRequest,
    context: AdapterContext,
  ): Promise<BrowserActivateTabResult> {
    if (this.canUseInProcess(computer)) return this.fake.activateTab(computer, request, context);
    const live = await this.runLive(
      computer,
      // JSON drops an undefined pin, so a follow sends none.
      { command: "activate", target: request.target, pin: request.pin },
      context,
    );
    if (live?.ok !== true || live.fallback === "computer_act") {
      return {
        front: null,
        pinned: null,
        fallback: "computer_act",
        error: live?.error || DETACHED_MESSAGE,
      };
    }
    return {
      front: typeof live.front === "string" ? live.front : null,
      pinned: typeof live.pinned === "string" ? live.pinned : null,
    };
  }

  async closeTab(
    computer: ComputerRef,
    request: BrowserCloseTabRequest,
    context: AdapterContext,
  ): Promise<BrowserCloseTabResult> {
    if (this.canUseInProcess(computer)) return this.fake.closeTab(computer, request, context);
    const live = await this.runLive(computer, { command: "close", target: request.target }, context);
    return live?.ok === true ? { ok: true } : { ok: false, error: live?.error || DETACHED_MESSAGE };
  }
```

5. **In `runLive`, replace the `if (result?.ok === true) { … }` validation's first branch** so each command is checked for what it returns:

```ts
      if (result?.ok === true) {
        if (request.command === "screenshot") {
          if (typeof result.data !== "string") throw new Error("Incomplete page capture");
        } else if (request.command === "tabs") {
          if (!Array.isArray(result.tabs)) throw new Error("Incomplete tab list");
        } else if (request.command === "activate" || request.command === "close") {
          // ok alone is the whole reply.
        } else if (typeof result.url !== "string" || typeof result.title !== "string") {
          throw new Error("Incomplete page browser response");
        }
        if (request.command === "open" && typeof result.target !== "string") {
          throw new Error("Incomplete page browser response");
        }
```

   Keep the rest of the existing checks: `snapshot` needs `tree` and `elements`, and `act` needs all actions confirmed.

   `this.fake.tabs` and the other three fake methods come in Task 4. Until then, the TypeScript build fails on those four lines. **Do Task 4 before committing this one**, or commit Tasks 3 and 4 together. Mark it in the ledger.

- [ ] **Step 9: Re-run the provider tests**

Run: `pnpm vitest run packages/adapters/src/computer-browser.test.ts` (after Task 4's fake methods exist).

Expected: PASS.

- [ ] **Step 10: Commit (with Task 4)**

```bash
git add packages/adapter-kit/src/types.ts packages/adapter-kit/src/interfaces.ts packages/adapter-kit/src/index.ts \
  infra/sandboxes/supervisor/src/index.ts infra/sandboxes/supervisor/src/page-browser-route.test.ts \
  packages/adapters/src/computer-browser.ts packages/adapters/src/computer-browser.test.ts
git commit -m "feat(adapters): carry tab targets through the page browser contract"
```

---

### Task 4: Tabs in the offline fake browser

**Files:**
- Modify: `packages/adapters/src/fake-browser.ts`
- Modify: `packages/adapters/src/page-browser-session.ts` (refs that never repeat across tabs, kept across snapshots)
- Test: `packages/adapters/src/browser-conformance.test.ts`

**Interfaces:**
- Consumes: the Task 3 types.
- Produces:
  - **The fake's four tab methods.** `FakeBrowserProvider` implements `tabs`, `openTab`, `activateTab` and `closeTab`. Each bot's computer starts with one tab, `"fake-1"`, whose session is the existing `pageBrowserSessionKey(computer, context)` session, so every existing test keeps its page.
  - **Untargeted calls** go to the front tab.
  - **A popup test seam:** set `popupOnNextAct = "<url>"`, and the next successful `act` opens that URL in a new tab whose opener is the acted tab. It is reported in `opened`.
  - **Refs as the helper hands them out (Task 2 item 8).** Refs never repeat across tabs, and a snapshot keeps earlier refs whose element is still on the page. Task 7 routes an act by its refs, so the fake must not hand two tabs the same ref.
  - **`EmulatorBrowserProvider`** inherits all of this.

- [ ] **Step 1: Write the failing conformance cases**

Append inside `describe("browser provider conformance", …)` in `packages/adapters/src/browser-conformance.test.ts`:

```ts
  it("keeps each tab's page apart and reports the tab it used", async () => {
    const provider = new FakeBrowserProvider({
      pages: {
        ...seededPages,
        "https://example.test/second": { title: "Second", html: "<button>Go</button>" },
      },
    });
    const first = await provider.navigate(computer, { url: "https://example.test/form" }, context);
    expect(first.target).toBe("fake-1");
    const opened = await provider.openTab(
      computer,
      { url: "https://example.test/second" },
      context,
    );
    expect(opened).toMatchObject({ title: "Second", target: "fake-2" });
    // Opening is in the background: untargeted calls still use the front tab.
    expect((await provider.snapshot(computer, {}, context)).title).toBe("Signup");
    expect((await provider.snapshot(computer, { target: "fake-2" }, context)).title).toBe(
      "Second",
    );
    expect((await provider.tabs(computer, {}, context)).tabs).toEqual([
      { target: "fake-1", title: "Signup", url: "https://example.test/form" },
      { target: "fake-2", title: "Second", url: "https://example.test/second" },
    ]);
  });

  it("reports a tab a click opened, and refuses a closed tab", async () => {
    const provider = new FakeBrowserProvider({ pages: seededPages });
    await provider.navigate(computer, { url: "https://example.test/form" }, context);
    const snap = await provider.snapshot(computer, {}, context);
    const button = snap.elements.find((el) => el.name.toLowerCase().includes("continue"))!;
    provider.popupOnNextAct = "https://example.test/form";
    const acted = await provider.act(
      computer,
      { actions: [{ kind: "click", ref: button.ref }] },
      context,
    );
    expect(acted).toMatchObject({ ok: true, target: "fake-1", opened: ["fake-2"] });
    expect((await provider.tabs(computer, {}, context)).tabs[1]).toMatchObject({
      target: "fake-2",
      openerId: "fake-1",
    });
    expect(await provider.closeTab(computer, { target: "fake-2" }, context)).toEqual({ ok: true });
    expect(await provider.snapshot(computer, { target: "fake-2" }, context)).toMatchObject({
      fallback: "computer_act",
      error: "That tab is closed.",
    });
  });

  it("follows unless pinned, and a pin on a closed tab counts as unpinned", async () => {
    const provider = new FakeBrowserProvider({ pages: seededPages });
    await provider.openTab(computer, { url: "https://example.test/form" }, context);
    expect(await provider.activateTab(computer, { target: "fake-2" }, context)).toEqual({
      front: "fake-2",
      pinned: null,
    });
    expect(await provider.activateTab(computer, { target: "fake-1", pin: true }, context)).toEqual(
      { front: "fake-1", pinned: "fake-1" },
    );
    expect(await provider.activateTab(computer, { target: "fake-2" }, context)).toEqual({
      front: null,
      pinned: "fake-1",
    });
    await provider.closeTab(computer, { target: "fake-1" }, context);
    expect(await provider.activateTab(computer, { target: "fake-2" }, context)).toEqual({
      front: "fake-2",
      pinned: null,
    });
  });

  it("never hands two tabs the same ref, and a second read keeps the first read's refs", async () => {
    const provider = new FakeBrowserProvider({ pages: seededPages });
    await provider.navigate(computer, { url: "https://example.test/form" }, context);
    await provider.openTab(computer, { url: "https://example.test/form" }, context);
    const first = await provider.snapshot(computer, {}, context);
    const second = await provider.snapshot(computer, { target: "fake-2" }, context);
    const refs = (snap: { elements: Array<{ ref: string }> }) => snap.elements.map((el) => el.ref);
    expect(refs(second).some((ref) => refs(first).includes(ref))).toBe(false);
    // Another reader's snapshot of the same tab leaves the owner's refs working.
    await provider.snapshot(computer, {}, context);
    const button = first.elements.find((el) => el.name.toLowerCase().includes("continue"))!;
    expect(
      await provider.act(computer, { actions: [{ kind: "click", ref: button.ref }] }, context),
    ).toMatchObject({ ok: true, completed: 1 });
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run packages/adapters/src/browser-conformance.test.ts`

Expected: FAIL, with `provider.openTab is not a function`.

- [ ] **Step 3: Implement the fake's tabs**

In `packages/adapters/src/fake-browser.ts`:

1. **Add this type and the closed-tab message** above the class:

```ts
const CLOSED_TAB = "That tab is closed.";

type FakeTabs = {
  /** Open tabs in order. The first, "fake-1", uses the bot's original session. */
  order: string[];
  front: string;
  pinned: string | null;
  openers: Map<string, string>;
  next: number;
};
```

2. **Add these members and private helpers** to the class:

```ts
  private readonly tabState = new Map<string, FakeTabs>();
  /** Offline stand-in for a page opening a tab: the next successful act opens this URL. */
  popupOnNextAct?: string;

  private tabsOf(key: string): FakeTabs {
    let tabs = this.tabState.get(key);
    if (!tabs) {
      tabs = { order: ["fake-1"], front: "fake-1", pinned: null, openers: new Map(), next: 2 };
      this.tabState.set(key, tabs);
    }
    return tabs;
  }

  /**
   * The bot's first tab keeps its original session key and refs (e1, e2…), so existing
   * tests keep their page. Other tabs prefix their refs, so no two tabs share a ref.
   */
  private sessionFor(key: string, id: string): PageBrowserSession {
    if (id === "fake-1") return this.sessions.get(key);
    const session = this.sessions.get(`${key}#${id}`);
    session.refPrefix = `${id}:e`;
    return session;
  }

  /** The live pin, as the computer reports it on every reply. */
  private pinOf(key: string): { pinned: string | null } {
    const tabs = this.tabsOf(key);
    return { pinned: tabs.pinned && tabs.order.includes(tabs.pinned) ? tabs.pinned : null };
  }

  /** The session for a tab, or undefined when that tab is closed. Untargeted means the front tab. */
  private tabSession(computer: ComputerRef, context: AdapterContext, target?: string) {
    const key = pageBrowserSessionKey(computer, context);
    const tabs = this.tabsOf(key);
    const id = target ?? tabs.front;
    if (!tabs.order.includes(id)) return undefined;
    return { id, key, session: this.sessionFor(key, id) };
  }

  /** Load a URL into a session from the seeded pages, or the network when unseeded. */
  private async loadInto(
    session: PageBrowserSession,
    url: string,
    signal: AbortSignal | undefined,
    context: AdapterContext,
  ): Promise<BrowserNavigateResult> {
    const seeded = this.pages[url] ?? this.pages[stripHash(url)];
    if (seeded) {
      const html = seeded.title ? ensureTitle(seeded.html, seeded.title) : seeded.html;
      return session.load(url, html);
    }
    try {
      const { url: finalUrl, body } = await fetchSafeWebText(url, {
        fetch: this.fetchImpl,
        signal: signal ?? context.signal,
      });
      return session.load(finalUrl, body);
    } catch (error) {
      return {
        url,
        title: "",
        fallback: "computer_act",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private newTab(key: string, opener?: string): string {
    const tabs = this.tabsOf(key);
    const id = `fake-${tabs.next++}`;
    tabs.order.push(id);
    if (opener) tabs.openers.set(id, opener);
    return id;
  }
```

3. **Rewrite `navigate`, `snapshot` and `act`** to go through `tabSession`. Keep their existing `forceFallback`, injected-error and empty-input branches first, as they are.
   - In `navigate`, after the `!url` check:

     ```ts
     const tab = this.tabSession(computer, context, request.target);
     if (!tab) return { url, title: "", fallback: "computer_act", error: CLOSED_TAB };
     const loaded = await this.loadInto(tab.session, url, request.signal, context);
     return loaded.fallback ? loaded : { ...loaded, target: tab.id, ...this.pinOf(tab.key) };
     ```

   - In `snapshot`:

     ```ts
     const tab = this.tabSession(computer, context, request.target);
     if (!tab) {
       return { url: "", title: "", tree: "", elements: [], fallback: "computer_act", error: CLOSED_TAB };
     }
     return { ...tab.session.snapshot(request.extended), target: tab.id, ...this.pinOf(tab.key) };
     ```

   - In `act`, resolve `tab` the same way. When it is undefined, return `{ ok: false, completed: 0, url: "", title: "", fallback: "computer_act", error: CLOSED_TAB }`. The `!request.actions?.length` branch then reads `url` and `title` from `tab.session`. Then:

     ```ts
     const result = tab.session.act(request.actions);
     if (!result.ok || !this.popupOnNextAct) {
       return { ...result, target: tab.id, ...this.pinOf(tab.key) };
     }
     const popup = this.newTab(tab.key, tab.id);
     const url = this.popupOnNextAct;
     this.popupOnNextAct = undefined;
     await this.loadInto(this.sessionFor(tab.key, popup), url, request.signal, context);
     return { ...result, target: tab.id, opened: [popup], ...this.pinOf(tab.key) };
     ```

4. **Add the four tab methods:**

```ts
  async tabs(
    computer: ComputerRef,
    _request: BrowserTabsRequest,
    context: AdapterContext,
  ): Promise<BrowserTabsResult> {
    if (this.forceFallback) return { tabs: [], fallback: "computer_act", error: this.forceFallback };
    const key = pageBrowserSessionKey(computer, context);
    const tabs = this.tabsOf(key);
    return {
      ...this.pinOf(key),
      tabs: tabs.order.map((id) => {
        const session = this.sessionFor(key, id);
        const opener = tabs.openers.get(id);
        return {
          target: id,
          title: session.title,
          url: session.url,
          ...(opener ? { openerId: opener } : {}),
        };
      }),
    };
  }

  async openTab(
    computer: ComputerRef,
    request: BrowserOpenTabRequest,
    context: AdapterContext,
  ): Promise<BrowserNavigateResult> {
    if (this.forceFallback) {
      return { url: request.url, title: "", fallback: "computer_act", error: this.forceFallback };
    }
    const key = pageBrowserSessionKey(computer, context);
    const id = this.newTab(key);
    const loaded = await this.loadInto(
      this.sessionFor(key, id),
      request.url.trim(),
      request.signal,
      context,
    );
    if (loaded.fallback) {
      // Like the computer's helper: a tab that failed to open is closed, never leaked.
      await this.closeTab(computer, { target: id }, context);
      return loaded;
    }
    return { ...loaded, target: id, ...this.pinOf(key) };
  }

  async activateTab(
    computer: ComputerRef,
    request: BrowserActivateTabRequest,
    context: AdapterContext,
  ): Promise<BrowserActivateTabResult> {
    if (this.forceFallback) {
      return { front: null, pinned: null, fallback: "computer_act", error: this.forceFallback };
    }
    const tabs = this.tabsOf(pageBrowserSessionKey(computer, context));
    if (request.pin === true && request.target === null) {
      return { front: null, pinned: null, fallback: "computer_act", error: "Pinning needs a target" };
    }
    if (request.target !== null && !tabs.order.includes(request.target)) {
      return { front: null, pinned: null, fallback: "computer_act", error: CLOSED_TAB };
    }
    if (request.pin === true) tabs.pinned = request.target;
    if (request.pin === false) tabs.pinned = null;
    if (tabs.pinned && !tabs.order.includes(tabs.pinned)) tabs.pinned = null;
    if (request.target !== null && (request.pin === true || tabs.pinned === null)) {
      tabs.front = request.target;
      return { front: request.target, pinned: tabs.pinned };
    }
    return { front: null, pinned: tabs.pinned };
  }

  async closeTab(
    computer: ComputerRef,
    request: BrowserCloseTabRequest,
    context: AdapterContext,
  ): Promise<BrowserCloseTabResult> {
    if (this.forceFallback) return { ok: false, error: this.forceFallback };
    const key = pageBrowserSessionKey(computer, context);
    const tabs = this.tabsOf(key);
    if (!tabs.order.includes(request.target)) return { ok: false, error: CLOSED_TAB };
    tabs.order = tabs.order.filter((id) => id !== request.target);
    tabs.openers.delete(request.target);
    this.sessions.clear(request.target === "fake-1" ? key : `${key}#${request.target}`);
    if (tabs.front === request.target) tabs.front = tabs.order[0] ?? "fake-1";
    if (tabs.order.length === 0) tabs.order.push("fake-1");
    return { ok: true };
  }
```

Import the new request and result types, and `PageBrowserSession`, at the top with `import type`. `PageBrowserSessionStore` is already imported as a value.

5. **Refs that name their tab.** In `packages/adapters/src/page-browser-session.ts`:
   - Add a public field `refPrefix = "e";` next to `nextRef`, and build refs as `` `${this.refPrefix}${this.nextRef++}` ``.
   - In `buildSnapshot`, replace `this.refs.clear();` with:

```ts
    // Another reader's snapshot must not invalidate the refs a tab's owner holds,
    // as in the computer's helper; `load` still clears them for a new document.
    for (const [ref, node] of this.refs) if (!node.isConnected) this.refs.delete(ref);
```

   - Item 2's `sessionFor` sets each later tab's prefix.

- [ ] **Step 4: Run the conformance and provider tests**

Run: `pnpm vitest run packages/adapters/src/browser-conformance.test.ts packages/adapters/src/computer-browser.test.ts packages/adapters/src/browser-tools.test.ts packages/adapters/src/page-browser-login-fill.test.ts && pnpm --filter @rakazo/adapters check`

Expected: PASS, and no type errors. Fake results now carry `target: "fake-1"`. Update any existing test that uses `toEqual` on a fake navigate, snapshot or act result to include it, and record each one in the ledger. Model-facing results from the browser tools strip it again in Task 8.

- [ ] **Step 5: Commit (together with Task 3)**

```bash
git add packages/adapters/src/fake-browser.ts packages/adapters/src/page-browser-session.ts \
  packages/adapters/src/browser-conformance.test.ts
git commit -m "feat(adapters): model browser tabs in the offline page browser"
```

If Task 3 was not committed yet, add its files to this commit and use Task 3's message as the subject.

---

### Task 5: The shared tab-list contract

**Files:**
- Modify: `packages/contracts/src/domain.ts`
- Modify: `packages/contracts/src/events.ts` (`ProductEventType`)
- Create: `packages/core/src/browser-tabs.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/browser-tabs.test.ts`
- Test: `packages/contracts/src/index.test.ts` (if it lists event types; otherwise none)

**Interfaces:**
- Produces in `@rakazo/contracts`: `BrowserTabSchema`, `BrowserTabsSchema` and `type BrowserTabs`; `ComputerStatusSchema.browserTabs` (optional); and the event type `"computer.browser_tabs"`.
- Produces in `@rakazo/core`: `browserTabLabel(tab: BrowserTabs["tabs"][number]): string`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/browser-tabs.test.ts`:

```ts
import { BrowserTabsSchema, ComputerStatusSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { browserTabLabel } from "./browser-tabs.js";

describe("browser tab labels", () => {
  it("names the owner and what the tab is for, falling back to its title, then its URL", () => {
    expect(
      browserTabLabel({ target: "T", title: "Booking", url: "https://b.test/", owner: "Hotels", purpose: "hotels in Lisbon" }),
    ).toBe("Hotels · hotels in Lisbon");
    expect(browserTabLabel({ target: "T", title: "Booking", url: "https://b.test/" })).toBe("Booking");
    expect(browserTabLabel({ target: "T", title: "", url: "https://b.test/", owner: "Ada" })).toBe(
      "Ada · https://b.test/",
    );
  });

  it("accepts a tab list on the computer status and rejects an oversized one", () => {
    const tabs = { tabs: [{ target: "T", title: "A", url: "https://a.test/" }], front: "T", pinned: null };
    expect(BrowserTabsSchema.parse(tabs)).toEqual(tabs);
    expect(ComputerStatusSchema.shape.browserTabs.safeParse(undefined).success).toBe(true);
    expect(
      BrowserTabsSchema.safeParse({ ...tabs, tabs: Array.from({ length: 65 }, () => tabs.tabs[0]) })
        .success,
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/core/src/browser-tabs.test.ts`

Expected: FAIL. `browserTabLabel` and `BrowserTabsSchema` do not exist yet.

- [ ] **Step 3: Implement**

1. **Add the schemas** to `packages/contracts/src/domain.ts`, directly above `export const ComputerStatusSchema`:

```ts
/** One tab of a bot's browser as the user's tab strip shows it. */
export const BrowserTabSchema = z.object({
  /** The computer's id for the tab; used to pin it. */
  target: z.string().min(1).max(128),
  title: z.string().max(200),
  url: z.string().max(2048),
  /** Display name of the agent using the tab: the bot, or a helper's task label. */
  owner: z.string().max(80).optional(),
  purpose: z.string().max(120).optional(),
});
export const BrowserTabsSchema = z.object({
  tabs: z.array(BrowserTabSchema).max(64),
  /** The tab last brought to the front, as far as the run knows. */
  front: z.string().max(128).nullable(),
  /** The tab the viewer pinned; follow is off while one is. */
  pinned: z.string().max(128).nullable(),
});
export type BrowserTabs = z.infer<typeof BrowserTabsSchema>;
```

2. **Add the field to `ComputerStatusSchema`**, after `terminalAvailable`: `browserTabs: BrowserTabsSchema.optional(),`.

3. **Add `"computer.browser_tabs"`** to `ProductEventType` in `packages/contracts/src/events.ts`, after `"computer.command"`.

4. **Create `packages/core/src/browser-tabs.ts`:**

```ts
import type { BrowserTabs } from "@rakazo/contracts";

/** What a tab strip or menu calls a tab: who is using it, and what it is for. */
export function browserTabLabel(tab: BrowserTabs["tabs"][number]): string {
  return [tab.owner, tab.purpose || tab.title || tab.url].filter(Boolean).join(" · ");
}
```

5. **Add `export * from "./browser-tabs.js";`** to `packages/core/src/index.ts`, in alphabetical position.

- [ ] **Step 4: Run the test and the contract checks**

Run: `pnpm vitest run packages/core/src/browser-tabs.test.ts packages/contracts && pnpm --filter @rakazo/contracts check && pnpm --filter @rakazo/core check`

Expected: PASS. If a contracts test enumerates every `ProductEventType`, add `"computer.browser_tabs"` to its expected list.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/domain.ts packages/contracts/src/events.ts packages/core/src/browser-tabs.ts \
  packages/core/src/browser-tabs.test.ts packages/core/src/index.ts
git commit -m "feat(contracts): describe a bot's browser tabs for the computer view"
```

---

### Task 6: The per-run tab registry

Pure state, no I/O. It owns Review Focus items 3 and 6.

**Files:**
- Create: `packages/adapters/src/browser-tab-registry.ts`
- Test: `packages/adapters/src/browser-tab-registry.test.ts`

**Interfaces:**
- Produces:

```ts
export const MAX_RUN_TABS = 12;
export const FOLLOW_DWELL_MS = 1_500;
export const MAIN_AGENT = "main";
/** A helper's label when it has none; run_subagent's own default name. */
export const HELPER_LABEL = "helper";
export function tabHandle(target: string, length?: number): string; // "t" + base36 chars of a 32-bit FNV-1a hash
export function closedTabMessage(handle: string): string; // "<handle> is closed. Call browser_tabs."
export interface RegistryTab {
  handle: string; target: string; title: string; url: string;
  owner?: string; purpose?: string;
  /** Opened during this run, by an agent or a page; closed when the run ends. */
  opened: boolean;
  /** When this registry first saw the tab, in mark() units. */
  seen: number;
}
export type TabUse = { ok: true; tab: RegistryTab } | { ok: false; error: string };
export class BrowserTabRegistry {
  constructor(now?: () => number);
  front: string | null;
  pinned: string | null;
  mark(): number;
  sync(live: ReadonlyArray<{ target: string; title: string; url: string }>, since?: number): void;
  note(target: string, page?: { title?: string; url?: string }): RegistryTab;
  forget(target: string): void;
  list(): RegistryTab[];
  byHandle(handle: string): RegistryTab | undefined;
  byTarget(target: string): RegistryTab | undefined;
  lastTabOf(agent: string): RegistryTab | undefined;
  hasOwnedTabs(): boolean;
  ownedBy(agent: string): RegistryTab[];
  rememberRefs(target: string, refs: readonly string[]): void;
  /** The tab these refs came from; null when they span tabs, undefined when unknown. */
  tabOfRefs(refs: readonly string[]): RegistryTab | null | undefined;
  claim(agent: string, tab: RegistryTab): TabUse;
  adopt(agent: string, target: string, page?: { title?: string; url?: string }, purpose?: string): RegistryTab;
  adoptOpened(from: string, targets: readonly string[]): string[];
  canOpen(): boolean;
  reserveOpen(): boolean;
  releaseOpen(): void;
  label(agent: string, name: string): void;
  labelOf(agent: string): string;
  handBack(agent: string): void;
  ownerFor(owner: string | undefined, viewer: string): string | undefined;
  takeFollow(target: string): boolean;
  fronted(result: { front: string | null; pinned: string | null }): void;
  closable(): string[];
}
```

- [ ] **Step 1: Write the failing tests**

Create `packages/adapters/src/browser-tab-registry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  BrowserTabRegistry,
  closedTabMessage,
  FOLLOW_DWELL_MS,
  MAIN_AGENT,
  MAX_RUN_TABS,
  tabHandle,
} from "./browser-tab-registry.js";

const live = (...targets: string[]) =>
  targets.map((target) => ({ target, title: `Title ${target}`, url: `https://${target}.test/` }));

describe("browser tab registry", () => {
  it("derives a short handle from the tab's id, the same in every registry", () => {
    expect(tabHandle("A")).toMatch(/^t[0-9a-z]{4}$/);
    expect(tabHandle("A")).toBe(tabHandle("A"));
    expect(tabHandle("A")).not.toBe(tabHandle("B"));
    const first = new BrowserTabRegistry();
    const resumed = new BrowserTabRegistry();
    first.sync(live("A", "B"));
    resumed.sync(live("B", "A"));
    expect(resumed.byTarget("A")?.handle).toBe(first.byTarget("A")?.handle);
    expect(closedTabMessage("tabcd")).toBe("tabcd is closed. Call browser_tabs.");
  });

  it("drops closed tabs, but never one first seen after the listing was requested", () => {
    const registry = new BrowserTabRegistry();
    registry.sync(live("A", "B"));
    const mark = registry.mark();
    registry.adopt("helper-1", "NEW");
    registry.sync(live("B"), mark);
    expect(registry.list().map((tab) => tab.target)).toEqual(["B", "NEW"]);
    expect(registry.byHandle(tabHandle("A"))).toBeUndefined();
  });

  it("lets one agent claim an unowned tab and refuses another agent's", () => {
    const registry = new BrowserTabRegistry();
    registry.sync(live("A"));
    const tab = registry.byTarget("A")!;
    registry.label("helper-1", "Hotels");
    expect(registry.claim("helper-1", tab)).toMatchObject({ ok: true });
    // Two parallel claims cannot both win: the second sees the first's owner.
    expect(registry.claim(MAIN_AGENT, tab)).toEqual({
      ok: false,
      error: `${tab.handle} belongs to helper 'Hotels' until it finishes. Read it with browser_snapshot, or open your own tab with browser_navigate newTab.`,
    });
    registry.handBack("helper-1");
    expect(registry.claim("helper-2", tab)).toEqual({
      ok: false,
      error: `${tab.handle} belongs to the main agent. Read it with browser_snapshot, or open your own tab with browser_navigate newTab.`,
    });
    expect(registry.claim(MAIN_AGENT, tab)).toMatchObject({ ok: true });
  });

  it("describes owners from the asker's side", () => {
    const registry = new BrowserTabRegistry();
    registry.label("helper-1", "Hotels");
    expect(registry.ownerFor(undefined, MAIN_AGENT)).toBeUndefined();
    expect(registry.ownerFor(MAIN_AGENT, MAIN_AGENT)).toBe("you");
    expect(registry.ownerFor(MAIN_AGENT, "helper-1")).toBe("main");
    expect(registry.ownerFor("helper-1", MAIN_AGENT)).toBe("helper: Hotels");
    expect(registry.ownerFor("helper-2", MAIN_AGENT)).toBe("helper: helper");
  });

  it("remembers each agent's last tab and forgets it when the tab closes", () => {
    const registry = new BrowserTabRegistry();
    registry.adopt("helper-1", "A", { title: "A", url: "https://a.test/" }, "flights");
    expect(registry.lastTabOf("helper-1")).toMatchObject({ target: "A", purpose: "flights" });
    registry.forget("A");
    expect(registry.lastTabOf("helper-1")).toBeUndefined();
  });

  it("gives tabs a page opened to the owner of the tab that opened them", () => {
    const registry = new BrowserTabRegistry();
    registry.adopt("helper-1", "A");
    expect(registry.adoptOpened("A", ["B"])).toEqual([tabHandle("B")]);
    expect(registry.byTarget("B")).toMatchObject({ owner: "helper-1", opened: true });
    registry.sync(live("C"));
    registry.adoptOpened("C", ["D"]);
    expect(registry.byTarget("D")?.owner).toBeUndefined();
  });

  it("hands a finished helper's tabs to the main agent, named after the helper", () => {
    const registry = new BrowserTabRegistry();
    registry.label("helper-1", "Hotels");
    registry.adopt("helper-1", "A");
    registry.adopt("helper-1", "B", undefined, "hotel search");
    registry.handBack("helper-1");
    expect(registry.byTarget("A")).toMatchObject({ owner: MAIN_AGENT, purpose: "Hotels" });
    expect(registry.byTarget("B")).toMatchObject({ owner: MAIN_AGENT, purpose: "hotel search" });
    expect(registry.ownedBy(MAIN_AGENT).map((tab) => tab.target)).toEqual(["A", "B"]);
    expect(registry.lastTabOf("helper-1")).toBeUndefined();
  });

  it("knows which tab issued a ref, and that refs from two tabs name no one tab", () => {
    const registry = new BrowserTabRegistry();
    registry.sync(live("A", "B"));
    registry.rememberRefs("A", ["e1", "e2"]);
    registry.rememberRefs("B", ["e3"]);
    expect(registry.tabOfRefs(["e1", "e2"])?.target).toBe("A");
    expect(registry.tabOfRefs(["e1", "e3"])).toBeNull();
    expect(registry.tabOfRefs(["e9"])).toBeUndefined();
    // Another snapshot of the tab adds refs: the earlier ones still work there.
    registry.rememberRefs("A", ["e4"]);
    expect(registry.tabOfRefs(["e1"])?.target).toBe("A");
    // A closed tab's refs are gone.
    registry.forget("B");
    expect(registry.tabOfRefs(["e3"])).toBeUndefined();
  });

  it("caps the tabs one run opens, counting opens in flight and only tabs it opened", () => {
    const registry = new BrowserTabRegistry();
    registry.sync(live("user-1", "user-2"));
    for (let i = 0; i < MAX_RUN_TABS - 1; i++) registry.adopt(MAIN_AGENT, `opened-${i}`);
    expect(registry.reserveOpen()).toBe(true);
    expect(registry.canOpen()).toBe(false);
    expect(registry.reserveOpen()).toBe(false);
    registry.releaseOpen();
    expect(registry.canOpen()).toBe(true);
  });

  it("closes the run's tabs at the end, keeping the front, pinned and final ones, never every tab", () => {
    const registry = new BrowserTabRegistry();
    registry.sync(live("user"));
    registry.adopt(MAIN_AGENT, "A");
    // The main agent's current tab is where it finished: it stays for the user.
    registry.adopt(MAIN_AGENT, "M");
    registry.adopt("helper-1", "B");
    registry.adopt("helper-1", "C");
    registry.fronted({ front: "B", pinned: "C" });
    expect(registry.closable()).toEqual(["A"]);

    const allOpened = new BrowserTabRegistry();
    allOpened.adopt("helper-1", "A");
    allOpened.adopt("helper-1", "B");
    // Front unknown and every tab opened by the run: the first one stays.
    expect(allOpened.closable()).toEqual(["B"]);
  });

  it("follows at most once per dwell, counting attempts, and never to the tab in front", () => {
    let now = 10_000;
    const registry = new BrowserTabRegistry(() => now);
    expect(registry.takeFollow("A")).toBe(true);
    registry.fronted({ front: "A", pinned: null });
    expect(registry.takeFollow("A")).toBe(false);
    now += FOLLOW_DWELL_MS;
    expect(registry.takeFollow("B")).toBe(true);
    // A pinned view answers with no front; the attempt still counts toward the dwell.
    registry.fronted({ front: null, pinned: "A" });
    expect(registry.takeFollow("B")).toBe(false);
    expect(registry.pinned).toBe("A");
    expect(registry.front).toBe("A");
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `pnpm vitest run packages/adapters/src/browser-tab-registry.test.ts`

Expected: FAIL, because the module does not exist.

- [ ] **Step 3: Implement**

Create `packages/adapters/src/browser-tab-registry.ts`:

```ts
/** A run may open this many tabs; tabs it did not open never count. */
export const MAX_RUN_TABS = 12;
/** The screen follows a different tab at most this often, so parallel agents do not flicker it. */
export const FOLLOW_DWELL_MS = 1_500;
/** The run's own agent; helpers are named by their agent IDs. */
export const MAIN_AGENT = "main";
/** A helper's label when it has none; run_subagent's own default name. */
export const HELPER_LABEL = "helper";

/**
 * A short handle for a tab, from its computer id: the same in every registry, so
 * a paused run that resumes still means the same tab by the same handle.
 */
export function tabHandle(target: string, length = 4): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < target.length; index++) {
    hash ^= target.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `t${hash.toString(36).padStart(7, "0").slice(-length)}`;
}

export function closedTabMessage(handle: string): string {
  return `${handle} is closed. Call browser_tabs.`;
}

export interface RegistryTab {
  handle: string;
  target: string;
  title: string;
  url: string;
  owner?: string;
  purpose?: string;
  /** Opened during this run, by an agent or a page; closed when the run ends. */
  opened: boolean;
  /** When this registry first saw the tab, in mark() units. */
  seen: number;
}

export type TabUse = { ok: true; tab: RegistryTab } | { ok: false; error: string };

/**
 * Which agent of one run may act in which tab. Helpers run inside the run's own
 * process, so every claim goes through this one object and two cannot both win.
 * It coordinates a run's agents; it is not a boundary against the bot.
 */
export class BrowserTabRegistry {
  private readonly tabs = new Map<string, RegistryTab>();
  private readonly lastUsed = new Map<string, string>();
  private readonly labels = new Map<string, string>();
  /** Refs each tab's snapshots handed out. Refs never repeat, so a ref names its tab. */
  private readonly refs = new Map<string, Set<string>>();
  private clock = 0;
  private pendingOpens = 0;
  private lastFollowAt = Number.NEGATIVE_INFINITY;
  front: string | null = null;
  pinned: string | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** Taken before listing tabs, so the listing cannot drop a tab learned while it was in flight. */
  mark(): number {
    return ++this.clock;
  }

  /** Match the computer's live tabs: new ones are recorded, closed ones seen before `since` drop out. */
  sync(
    live: ReadonlyArray<{ target: string; title: string; url: string }>,
    since = Number.POSITIVE_INFINITY,
  ): void {
    const alive = new Set(live.map((tab) => tab.target));
    for (const tab of this.list()) {
      if (!alive.has(tab.target) && tab.seen < since) this.forget(tab.target);
    }
    for (const tab of live) this.note(tab.target, { title: tab.title, url: tab.url });
  }

  /** Record a tab, the first time with its handle, and what it now shows. */
  note(target: string, page: { title?: string; url?: string } = {}): RegistryTab {
    let tab = this.tabs.get(target);
    if (!tab) {
      // A 4-character clash is rare; the longer form keeps both distinct.
      const short = tabHandle(target);
      const handle = this.byHandle(short) ? tabHandle(target, 7) : short;
      tab = { handle, target, title: "", url: "", opened: false, seen: this.clock };
      this.tabs.set(target, tab);
    }
    if (page.title !== undefined) tab.title = page.title;
    if (page.url !== undefined) tab.url = page.url;
    return tab;
  }

  forget(target: string): void {
    this.tabs.delete(target);
    this.refs.delete(target);
    for (const [agent, used] of [...this.lastUsed]) if (used === target) this.lastUsed.delete(agent);
    if (this.front === target) this.front = null;
    if (this.pinned === target) this.pinned = null;
  }

  list(): RegistryTab[] {
    return [...this.tabs.values()];
  }

  byHandle(handle: string): RegistryTab | undefined {
    return this.list().find((tab) => tab.handle === handle);
  }

  byTarget(target: string): RegistryTab | undefined {
    return this.tabs.get(target);
  }

  lastTabOf(agent: string): RegistryTab | undefined {
    const target = this.lastUsed.get(agent);
    return target ? this.tabs.get(target) : undefined;
  }

  /** Whether any agent of this run has used a tab yet. */
  hasOwnedTabs(): boolean {
    return this.list().some((tab) => tab.owner);
  }

  ownedBy(agent: string): RegistryTab[] {
    return this.list().filter((tab) => tab.owner === agent);
  }

  /**
   * Record the refs a snapshot of `target` handed out. They add to earlier ones: another
   * agent's read must not orphan refs the owner still holds. A closed tab drops its set.
   */
  rememberRefs(target: string, refs: readonly string[]): void {
    if (!this.tabs.has(target)) return;
    const issued = this.refs.get(target) ?? new Set<string>();
    for (const ref of refs) issued.add(ref);
    this.refs.set(target, issued);
  }

  tabOfRefs(refs: readonly string[]): RegistryTab | null | undefined {
    const targets = [...this.refs]
      .filter(([, issued]) => refs.some((ref) => issued.has(ref)))
      .map(([target]) => target);
    if (targets.length > 1) return null;
    const [target] = targets;
    return target === undefined ? undefined : this.tabs.get(target);
  }

  /** Act in a tab: allowed when the agent owns it or nobody does, which claims it. */
  claim(agent: string, tab: RegistryTab): TabUse {
    if (tab.owner && tab.owner !== agent) {
      const who =
        tab.owner === MAIN_AGENT
          ? "the main agent"
          : `helper '${this.labelOf(tab.owner)}' until it finishes`;
      return {
        ok: false,
        error: `${tab.handle} belongs to ${who}. Read it with browser_snapshot, or open your own tab with browser_navigate newTab.`,
      };
    }
    tab.owner = agent;
    this.lastUsed.set(agent, tab.target);
    return { ok: true, tab };
  }

  /** A tab this run opened for an agent. */
  adopt(
    agent: string,
    target: string,
    page?: { title?: string; url?: string },
    purpose?: string,
  ): RegistryTab {
    const tab = this.note(target, page);
    tab.owner = agent;
    tab.opened = true;
    if (purpose) tab.purpose = purpose;
    this.lastUsed.set(agent, target);
    return tab;
  }

  /** Tabs a page opened from `from` belong to whoever owns `from`. Returns their handles. */
  adoptOpened(from: string, targets: readonly string[]): string[] {
    const owner = this.tabs.get(from)?.owner;
    return targets.map((target) => {
      const tab = this.note(target);
      tab.opened = true;
      if (owner) tab.owner = owner;
      return tab.handle;
    });
  }

  canOpen(): boolean {
    return this.list().filter((tab) => tab.opened).length + this.pendingOpens < MAX_RUN_TABS;
  }

  /** Hold a place under the cap for an open in flight; false when the run is at the cap. */
  reserveOpen(): boolean {
    if (!this.canOpen()) return false;
    this.pendingOpens++;
    return true;
  }

  releaseOpen(): void {
    this.pendingOpens = Math.max(0, this.pendingOpens - 1);
  }

  label(agent: string, name: string): void {
    this.labels.set(agent, name);
  }

  labelOf(agent: string): string {
    return this.labels.get(agent) ?? HELPER_LABEL;
  }

  /** A finished helper's tabs pass to the main agent and stay open. */
  handBack(agent: string): void {
    const label = this.labels.get(agent);
    for (const tab of this.tabs.values()) {
      if (tab.owner !== agent) continue;
      tab.owner = MAIN_AGENT;
      // The helper's name keeps telling the main agent and the user what the tab was for.
      if (!tab.purpose && label) tab.purpose = label;
    }
    this.lastUsed.delete(agent);
  }

  /** How browser_tabs names an owner to the agent asking. */
  ownerFor(owner: string | undefined, viewer: string): string | undefined {
    if (!owner) return undefined;
    if (owner === viewer) return "you";
    if (owner === MAIN_AGENT) return "main";
    return `helper: ${this.labelOf(owner)}`;
  }

  /** Whether to bring `target` forward now; a yes starts the dwell. The computer still honors a pin. */
  takeFollow(target: string): boolean {
    if (this.front === target) return false;
    if (this.now() - this.lastFollowAt < FOLLOW_DWELL_MS) return false;
    this.lastFollowAt = this.now();
    return true;
  }

  /** Record which tab is in front and which is pinned, from a reply or a page opening a tab. */
  fronted(result: { front: string | null; pinned: string | null }): void {
    if (result.front) this.front = result.front;
    this.pinned = result.pinned;
  }

  /**
   * Tabs to close when the run ends: the ones it opened, except the front and
   * pinned ones and the main agent's current tab, where it finished. Never every
   * tab, since a browser with no tab is gone.
   */
  closable(): string[] {
    const all = this.list();
    const keep = new Set([this.front, this.pinned, this.lastUsed.get(MAIN_AGENT) ?? null]);
    const close = all
      .filter((tab) => tab.opened && !keep.has(tab.target))
      .map((tab) => tab.target);
    return close.length === all.length ? close.slice(1) : close;
  }
}
```

- [ ] **Step 4: Format and run the tests**

Run: `pnpm exec biome check --write packages/adapters/src/browser-tab-registry.ts packages/adapters/src/browser-tab-registry.test.ts && pnpm vitest run packages/adapters/src/browser-tab-registry.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/browser-tab-registry.ts packages/adapters/src/browser-tab-registry.test.ts
git commit -m "feat(adapters): track which agent of a run owns which browser tab"
```

---

### Task 7: Run-scoped tab service

This connects the registry to the browser provider for one run. It owns Review Focus items 1, 2, 4 and 5.

**Files:**
- Create: `packages/adapters/src/run-browser-tabs.ts`
- Test: `packages/adapters/src/run-browser-tabs.test.ts`
- Modify: `packages/adapters/src/page-decision-chain.ts` (export a shared `normalizeText`; `normalizeGoal` uses it)

**Interfaces:**
- Consumes:
  - Task 6's `BrowserTabRegistry` (including `ownedBy`, `rememberRefs` and `tabOfRefs`), `RegistryTab`, `MAIN_AGENT`, `MAX_RUN_TABS`, `HELPER_LABEL`, `closedTabMessage` and `tabHandle`;
  - Task 3's provider methods;
  - the `pinned` reply field from Tasks 2–4;
  - Task 5's `BrowserTabs`.
- Produces:

```ts
export const TABS_NEED_UPDATE = "This computer's browser cannot address tabs. Leave out tab and newTab.";
export type TabPlace = { target?: string } | { open: true } | { error: string };
export interface PlacedTab { tab?: string; opened: string[]; error?: string }
type TabReply = {
  target?: string; opened?: string[]; pinned?: string | null;
  url?: string; title?: string; fallback?: "computer_act"; error?: string;
};
export class RunBrowserTabs {
  constructor(deps: {
    browser: BrowserProvider; computer: ComputerRef; context: AdapterContext;
    botName: string;
    publish: (view: BrowserTabs) => Promise<void>;
    now?: () => number;
  });
  readonly registry: BrowserTabRegistry;
  support(): Promise<boolean>;
  forNavigate(agent: string, args: Record<string, unknown>): Promise<TabPlace>;
  forRead(agent: string, args: Record<string, unknown>): Promise<TabPlace>;
  /** browser_act takes no tab: its refs name the tab they came from. */
  forAct(agent: string, args: Record<string, unknown>): Promise<TabPlace>;
  /** Note the refs a result handed the agent, so a later act finds their tab. */
  remember(target: string | undefined, result: { elements?: ReadonlyArray<{ ref: string }> }): void;
  /** Before a desktop action: one agent at a time holds the screen once there are tabs. */
  forDesktop(agent: string): Promise<{ error?: string }>;
  /** Run a browser call for a place; an unaddressed one pauses follow until it returns. */
  within<T>(place: TabPlace, call: () => Promise<T>): Promise<T>;
  open(agent: string, url: string, purpose: string | undefined): Promise<BrowserNavigateResult>;
  after(agent: string, result: TabReply, mode: "act" | "read", purpose?: string): Promise<PlacedTab>;
  adoptOpened(from: string, targets: readonly string[]): Promise<string[]>;
  list(agent: string): Promise<{ tabs: Array<{ tab: string; title: string; url: string; owner?: string; purpose?: string; current?: true }> } | { error: string }>;
  labelHelper(agent: string, name: string): void;
  handBack(agent: string): Promise<void>;
  closeOpened(signal: AbortSignal): Promise<void>;
  view(): BrowserTabs;
}
export function normalizePurpose(value: unknown): string | undefined; // normalizeText(value, 120)
```

and, in `page-decision-chain.ts`, `export function normalizeText(value: unknown, max: number): string | undefined`.

- [ ] **Step 1: Write the failing tests**

Create `packages/adapters/src/run-browser-tabs.test.ts`:

```ts
import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import type { BrowserTabs } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { MAIN_AGENT, tabHandle } from "./browser-tab-registry.js";
import { FakeBrowserProvider } from "./fake-browser.js";
import { RunBrowserTabs, TABS_NEED_UPDATE } from "./run-browser-tabs.js";

const context: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  botId: "bot-1",
  signal: new AbortController().signal,
};
const computer: ComputerRef = { id: "c", botId: "bot-1", kind: "fake", providerRef: "c" };
const pages = {
  "https://a.test/": { title: "A", html: "<button>Go</button>" },
  "https://b.test/": { title: "B", html: "<button>Go</button>" },
};
const [t1, t2, t3] = ["fake-1", "fake-2", "fake-3"].map((target) => tabHandle(target));

function setup(browser = new FakeBrowserProvider({ pages }), now = () => 0) {
  const published: BrowserTabs[] = [];
  const tabs = new RunBrowserTabs({
    browser,
    computer,
    context,
    botName: "Ada",
    publish: async (view) => {
      published.push(view);
    },
    // By default a fixed clock: the first follow happens, and any later one falls within the dwell.
    now,
  });
  return { browser, tabs, published };
}

/** A helper's tab, opened and recorded as browser_navigate would. */
async function helperTab(tabs: RunBrowserTabs, url = "https://a.test/", purpose = "hotels") {
  return tabs.after("helper-1", await tabs.open("helper-1", url, purpose), "act", purpose);
}

describe("run browser tabs", () => {
  it("leaves the main agent on the focused tab with no extra calls or events", async () => {
    const { browser, tabs, published } = setup();
    const listed = vi.spyOn(browser, "tabs");
    expect(await tabs.forNavigate(MAIN_AGENT, { url: "https://a.test/" })).toEqual({});
    const result = await browser.navigate(computer, { url: "https://a.test/" }, context);
    expect(await tabs.after(MAIN_AGENT, result, "act")).toEqual({ tab: t1, opened: [] });
    expect(await tabs.forAct(MAIN_AGENT, {})).toEqual({ target: "fake-1" });
    expect(listed).not.toHaveBeenCalled();
    expect(published).toEqual([]);
  });

  it("opens a helper's first tab and refuses a helper's act before it has one", async () => {
    const { tabs } = setup();
    expect(await tabs.forNavigate("helper-1", { url: "https://a.test/" })).toEqual({ open: true });
    expect(await tabs.forAct("helper-1", {})).toEqual({
      error: "Open a tab with browser_navigate first.",
    });
  });

  it("keeps the main agent off the focused tab once a helper browses", async () => {
    const { tabs } = setup();
    tabs.labelHelper("helper-1", "Hotels");
    // The helper's request alone ends the main agent's fast path, before any tab exists.
    const helperPlace = tabs.forNavigate("helper-1", { url: "https://a.test/" });
    expect(await tabs.forNavigate(MAIN_AGENT, { url: "https://b.test/" })).toEqual({ open: true });
    await helperPlace;
    await helperTab(tabs);
    expect(await tabs.forAct(MAIN_AGENT, {})).toEqual({
      error: "Take a browser_snapshot of the tab to act in first; its refs name the tab.",
    });
    expect(await tabs.forRead(MAIN_AGENT, { tab: t2 })).toEqual({ target: "fake-2" });
    // Refs from reading the helper's tab lead back to that tab, which is not the main agent's.
    tabs.remember("fake-2", { elements: [{ ref: "fake-2:e1" }] });
    expect(
      await tabs.forAct(MAIN_AGENT, { actions: [{ kind: "click", ref: "fake-2:e1" }] }),
    ).toEqual({
      error: `${t2} belongs to helper 'Hotels' until it finishes. Read it with browser_snapshot, or open your own tab with browser_navigate newTab.`,
    });
  });

  it("does not follow while an unaddressed command is in flight", async () => {
    const { browser, tabs } = setup();
    await tabs.support();
    const activate = vi.spyOn(browser, "activateTab");
    let release!: () => void;
    const unaddressed = tabs.within({}, () => new Promise<void>((done) => (release = done)));
    await helperTab(tabs);
    expect(activate).not.toHaveBeenCalled();
    release();
    await unaddressed;
  });

  it("keeps handles across a paused run's resume", async () => {
    const browser = new FakeBrowserProvider({ pages });
    const before = setup(browser).tabs;
    await before.support();
    expect((await helperTab(before)).tab).toBe(t2);
    const resumed = setup(browser).tabs;
    // Ownership resets with the run; the handle still names the same tab.
    expect(await resumed.forNavigate(MAIN_AGENT, { url: "https://a.test/", tab: t2 })).toEqual({
      target: "fake-2",
    });
  });

  it("lists tabs with handles, owners as the asker sees them, and purposes", async () => {
    const { tabs } = setup();
    await tabs.support();
    tabs.labelHelper("helper-1", "Hotels");
    await helperTab(tabs);
    expect(await tabs.list(MAIN_AGENT)).toEqual({
      tabs: [
        { tab: t1, title: "", url: "about:blank" },
        { tab: t2, title: "A", url: "https://a.test/", owner: "helper: Hotels", purpose: "hotels" },
      ],
    });
    // The asker's own current tab is marked, so it knows where unnamed calls go.
    expect(await tabs.list("helper-1")).toMatchObject({
      tabs: [{ tab: t1 }, { tab: t2, owner: "you", current: true }],
    });
  });

  it("reports a closed handle instead of acting in another tab", async () => {
    const { browser, tabs } = setup();
    await tabs.support();
    await helperTab(tabs);
    await browser.closeTab(computer, { target: "fake-2" }, context);
    expect(await tabs.forAct("helper-1", {})).toEqual({ target: "fake-2" });
    const result = await browser.act(
      computer,
      { actions: [{ kind: "click", ref: "e1" }], target: "fake-2" },
      context,
    );
    expect(await tabs.after("helper-1", { ...result, target: "fake-2" }, "act")).toEqual({
      opened: [],
      error: `${t2} is closed. Call browser_tabs.`,
    });
    expect(await tabs.forRead("helper-1", { tab: t2 })).toEqual({
      error: `${t2} is closed. Call browser_tabs.`,
    });
  });

  it("refuses tab arguments on a computer without tab commands and keeps unnamed calls working", async () => {
    const browser = new FakeBrowserProvider({ pages });
    browser.tabs = undefined as never;
    const { tabs } = setup(browser);
    expect(await tabs.support()).toBe(false);
    expect(await tabs.forNavigate(MAIN_AGENT, { url: "https://a.test/", newTab: true })).toEqual({
      error: TABS_NEED_UPDATE,
    });
    expect(await tabs.forRead(MAIN_AGENT, { tab: t1 })).toEqual({ error: TABS_NEED_UPDATE });
    // A helper on such a computer shares the focused tab, as before tabs existed.
    expect(await tabs.forNavigate("helper-1", { url: "https://a.test/" })).toEqual({});
    expect(await tabs.list(MAIN_AGENT)).toEqual({ error: TABS_NEED_UPDATE });
  });

  it("probes again after a passing failure, but not after an old image's answer", async () => {
    const browser = new FakeBrowserProvider({ pages });
    const listed = vi
      .spyOn(browser, "tabs")
      .mockResolvedValueOnce({ tabs: [], fallback: "computer_act", error: "CDP not ready" });
    const { tabs } = setup(browser);
    expect(await tabs.support()).toBe(false);
    expect(await tabs.support()).toBe(true);
    listed.mockClear();

    const old = new FakeBrowserProvider({ pages });
    const oldListed = vi.spyOn(old, "tabs").mockResolvedValue({
      tabs: [],
      fallback: "computer_act",
      error: "unknown command: tabs",
    });
    const oldTabs = setup(old).tabs;
    expect(await oldTabs.support()).toBe(false);
    expect(await oldTabs.support()).toBe(false);
    expect(oldListed).toHaveBeenCalledTimes(1);
  });

  it("caps tabs per run", async () => {
    const { tabs } = setup();
    await tabs.support();
    for (let i = 0; i < 12; i++) tabs.registry.adopt(MAIN_AGENT, `opened-${i}`);
    expect(await tabs.forNavigate(MAIN_AGENT, { url: "https://a.test/", newTab: true })).toEqual({
      error: expect.stringContaining("12 tabs open"),
    });
    expect(await tabs.open(MAIN_AGENT, "https://a.test/", undefined)).toMatchObject({
      error: expect.stringContaining("12 tabs open"),
    });
  });

  it("acts in the tab its refs came from, and refuses refs from two tabs", async () => {
    const { browser, tabs } = setup();
    await tabs.support();
    await helperTab(tabs);
    await tabs.after(MAIN_AGENT, await tabs.open(MAIN_AGENT, "https://b.test/", undefined), "act");
    const mine = await browser.snapshot(computer, { target: "fake-3" }, context);
    const theirs = await browser.snapshot(computer, { target: "fake-2" }, context);
    tabs.remember("fake-3", mine);
    tabs.remember("fake-2", theirs);
    const click = (ref: string) => ({ kind: "click", ref });
    expect(
      await tabs.forAct(MAIN_AGENT, { actions: [click(mine.elements[0]!.ref)] }),
    ).toEqual({ target: "fake-3" });
    expect(
      await tabs.forAct(MAIN_AGENT, {
        actions: [click(mine.elements[0]!.ref), click(theirs.elements[0]!.ref)],
      }),
    ).toEqual({ error: "These refs come from different tabs. Act in one tab per call." });
  });

  it("asks which tab to navigate once an agent has two, and accepts any handle's case", async () => {
    const { tabs } = setup();
    await tabs.support();
    await helperTab(tabs);
    await tabs.after("helper-1", await tabs.open("helper-1", "https://b.test/", undefined), "act");
    expect(await tabs.forNavigate("helper-1", { url: "https://a.test/" })).toEqual({
      error: `You have 2 tabs: ${t2}, ${t3}. Name one with tab, or use newTab.`,
    });
    expect(
      await tabs.forNavigate("helper-1", { url: "https://a.test/", tab: t2.toUpperCase() }),
    ).toEqual({ target: "fake-2" });
    expect(
      await tabs.forNavigate("helper-1", { url: "https://a.test/", tab: t2, newTab: true }),
    ).toEqual({ error: "Use tab or newTab, not both." });
  });

  it("makes a tab current when its owner reads it, never when another agent does", async () => {
    const { browser, tabs } = setup();
    await tabs.support();
    await helperTab(tabs);
    await tabs.after(MAIN_AGENT, await tabs.open(MAIN_AGENT, "https://b.test/", undefined), "act");
    await tabs.after(MAIN_AGENT, await tabs.open(MAIN_AGENT, "https://a.test/", undefined), "act");
    const read = (target: string) => browser.snapshot(computer, { target }, context);
    await tabs.after(MAIN_AGENT, await read("fake-3"), "read");
    expect(await tabs.forRead(MAIN_AGENT, {})).toEqual({ target: "fake-3" });
    await tabs.after(MAIN_AGENT, await read("fake-2"), "read");
    expect(await tabs.forRead(MAIN_AGENT, {})).toEqual({ target: "fake-3" });
  });

  it("lets one agent at a time use the desktop once there are tabs, and stops following", async () => {
    let clock = 0;
    const { browser, tabs } = setup(undefined, () => clock);
    await tabs.support();
    // One tab: desktop actions work as they do today, and hold nothing.
    expect(await tabs.forDesktop(MAIN_AGENT)).toEqual({});
    tabs.labelHelper("helper-1", "Hotels");
    await helperTab(tabs);
    expect(await tabs.forDesktop("helper-1")).toEqual({});
    expect(tabs.view().front).toBe("fake-2");
    expect(await tabs.forDesktop(MAIN_AGENT)).toEqual({
      error: "The screen is in use by helper 'Hotels'. Use page tools in your own tab.",
    });
    // Past the dwell, the main agent's act would be followed; the hold keeps the screen still.
    clock += 10_000;
    const activate = vi.spyOn(browser, "activateTab");
    await tabs.after(MAIN_AGENT, await tabs.open(MAIN_AGENT, "https://b.test/", undefined), "act");
    expect(activate).not.toHaveBeenCalled();
    await tabs.handBack("helper-1");
    expect(await tabs.forDesktop(MAIN_AGENT)).toEqual({});
    expect(tabs.view().front).toBe("fake-3");
  });

  it("refuses desktop actions to an agent with no tab while another agent's tab is in front", async () => {
    const { tabs } = setup();
    await tabs.support();
    // The helper's act is followed, so its tab is in front.
    await helperTab(tabs);
    expect(await tabs.forDesktop(MAIN_AGENT)).toEqual({
      error:
        "Another agent's tab is in front, so desktop actions would land in it. Open a tab with browser_navigate first.",
    });
  });

  it("still routes an owner's refs after another agent reads its tab", async () => {
    const { browser, tabs } = setup();
    await tabs.support();
    await helperTab(tabs);
    const before = await browser.snapshot(computer, { target: "fake-2" }, context);
    tabs.remember("fake-2", before);
    // The helper moves on to a second tab; then the main agent reads the first.
    await tabs.after("helper-1", await tabs.open("helper-1", "https://b.test/", undefined), "act");
    tabs.remember("fake-2", await browser.snapshot(computer, { target: "fake-2" }, context));
    const ref = before.elements[0]!.ref;
    expect(await tabs.forAct("helper-1", { actions: [{ kind: "click", ref }] })).toEqual({
      target: "fake-2",
    });
  });

  it("keeps desktop actions out of a tab the user pinned on screen", async () => {
    const { browser, tabs } = setup();
    await tabs.support();
    await helperTab(tabs);
    await browser.activateTab(computer, { target: "fake-1", pin: true }, context);
    expect(await tabs.forDesktop("helper-1")).toEqual({
      error: `The user pinned another tab on screen, so desktop actions would land in it. Use page tools in ${t2}, or have the user choose Follow.`,
    });
  });

  it("mirrors the computer's pin from every reply, so a pin set from the UI is never undone", async () => {
    const { browser, tabs, published } = setup();
    await tabs.support();
    await helperTab(tabs);
    // The viewer pins the user's own tab directly on the computer, as the API does.
    await browser.activateTab(computer, { target: "fake-1", pin: true }, context);
    const snap = await browser.snapshot(computer, { target: "fake-2" }, context);
    await tabs.after("helper-1", snap, "read");
    expect(published.at(-1)?.pinned).toBe("fake-1");
  });

  it("hands a helper's tabs back, publishes in order, and closes the run's background tabs", async () => {
    const { browser, tabs, published } = setup();
    await tabs.support();
    tabs.labelHelper("helper-1", "Hotels");
    await helperTab(tabs);
    expect(published.at(-1)?.tabs.find((tab) => tab.target === "fake-2")).toMatchObject({
      owner: "Hotels",
      purpose: "hotels",
    });
    // The first follow brings the helper's tab forward; the next falls within the dwell.
    expect(published.at(-1)?.front).toBe("fake-2");
    await tabs.after(MAIN_AGENT, await tabs.open(MAIN_AGENT, "https://b.test/", undefined), "act");
    await tabs.handBack("helper-1");
    expect(published.at(-1)?.tabs.find((tab) => tab.target === "fake-2")?.owner).toBe("Ada");
    await tabs.closeOpened(new AbortController().signal);
    // The main agent's final tab comes forward and stays, the helper's closes, and the
    // user's own tab is untouched.
    expect((await browser.tabs(computer, {}, context)).tabs.map((tab) => tab.target)).toEqual([
      "fake-1",
      "fake-3",
    ]);
    expect(published.at(-1)).toMatchObject({ front: "fake-3" });
    expect(published.at(-1)?.tabs.map((tab) => tab.target)).toEqual(["fake-1", "fake-3"]);
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `pnpm vitest run packages/adapters/src/run-browser-tabs.test.ts`

Expected: FAIL, because the module does not exist.

- [ ] **Step 3: Share the text normalizer**

In `packages/adapters/src/page-decision-chain.ts`, replace `normalizeGoal`'s body with a call to a new exported helper, and keep `normalizeGoal`'s signature:

```ts
/** A trimmed string cut to `max` characters, or undefined for anything unusable. */
export function normalizeText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/** Unusable goal means no goal: the decider never runs. */
export function normalizeGoal(value: unknown): string | undefined {
  return normalizeText(value, MAX_GOAL_CHARS);
}
```

- [ ] **Step 4: Implement the service**

Create `packages/adapters/src/run-browser-tabs.ts`:

```ts
import type {
  AdapterContext,
  BrowserNavigateResult,
  BrowserProvider,
  ComputerRef,
} from "@rakazo/adapter-kit";
import type { BrowserTabs } from "@rakazo/contracts";
import type { RegistryTab } from "./browser-tab-registry.js";
import {
  BrowserTabRegistry,
  closedTabMessage,
  HELPER_LABEL,
  MAIN_AGENT,
  MAX_RUN_TABS,
} from "./browser-tab-registry.js";
import { normalizeText } from "./page-decision-chain.js";

// Every refusal says what to do next, in the tools' own words.
export const TABS_NEED_UPDATE =
  "This computer's browser cannot address tabs. Leave out tab and newTab.";
const TAB_CAP_REACHED = `This run has ${MAX_RUN_TABS} tabs open, the most it can. Navigate one of yours with tab; browser_tabs lists them.`;
const OPEN_FIRST = "Open a tab with browser_navigate first.";
const SNAPSHOT_FIRST = "Take a browser_snapshot of the tab to act in first; its refs name the tab.";
const ONE_TAB_PER_ACT = "These refs come from different tabs. Act in one tab per call.";
const TAB_OR_NEW_TAB = "Use tab or newTab, not both.";
const FRONT_IS_ANOTHERS =
  "Another agent's tab is in front, so desktop actions would land in it. Open a tab with browser_navigate first.";
/** The computer's own wording when a target no longer exists. */
const COMPUTER_CLOSED_TAB = "That tab is closed.";
/** An image or supervisor that predates tabs answers this way; anything else may pass. */
const NO_TAB_COMMANDS = /unknown command/i;
const MAX_PURPOSE_CHARS = 120;
/** The strip's schema bounds (Task 5). */
const MAX_VIEW_TABS = 64;

export type TabPlace = { target?: string } | { open: true } | { error: string };
export interface PlacedTab {
  tab?: string;
  opened: string[];
  error?: string;
}
type TabReply = {
  target?: string;
  opened?: string[];
  pinned?: string | null;
  url?: string;
  title?: string;
  fallback?: "computer_act";
  error?: string;
};

export function normalizePurpose(value: unknown): string | undefined {
  return normalizeText(value, MAX_PURPOSE_CHARS);
}

/** A `tab` argument: a handle in any case, absent, or an error for anything else. */
function tabArg(value: unknown): string | undefined | { error: string } {
  if (value === undefined || value === null || value === "") return undefined;
  const handle = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^t[0-9a-z]{4,7}$/.test(handle)
    ? handle
    : { error: "tab must be a tab handle such as t4k2z, from a result or browser_tabs." };
}

/** The refs a browser_act call names. */
function actionRefs(actions: unknown): string[] {
  if (!Array.isArray(actions)) return [];
  return actions.flatMap((action: unknown) => {
    const ref = (action as { ref?: unknown } | null)?.ref;
    return typeof ref === "string" ? [ref] : [];
  });
}

function whichTab(own: RegistryTab[]): string {
  const handles = own.map((tab) => tab.handle).join(", ");
  return `You have ${own.length} tabs: ${handles}. Name one with tab, or use newTab.`;
}

/**
 * The browser tabs of one run: which agent may use which tab, what the user's
 * strip shows, and what the run leaves behind. Never throws: every refusal is a
 * message the model can act on.
 */
export class RunBrowserTabs {
  readonly registry: BrowserTabRegistry;
  private supported?: boolean;
  private probing?: Promise<boolean>;
  /** A helper has asked for a tab: the focused tab may now be someone else's. */
  private helpersBrowsing = false;
  private unaddressedCalls = 0;
  /** The agent whose desktop actions own the screen; nothing follows while one does. */
  private screenHolder?: string;
  private publishing: Promise<void> = Promise.resolve();
  private published = "";
  private publishedCount = 0;

  constructor(
    private readonly deps: {
      browser: BrowserProvider;
      computer: ComputerRef;
      context: AdapterContext;
      botName: string;
      publish: (view: BrowserTabs) => Promise<void>;
      now?: () => number;
    },
  ) {
    this.registry = new BrowserTabRegistry(deps.now);
  }

  /** Whether the computer addresses tabs. Only a definite answer is remembered for the run. */
  async support(): Promise<boolean> {
    if (this.supported !== undefined) return this.supported;
    const { browser } = this.deps;
    if (!browser.tabs || !browser.openTab || !browser.activateTab) {
      this.supported = false;
      return false;
    }
    this.probing ??= this.refresh(this.deps.context.signal).finally(() => {
      this.probing = undefined;
    });
    return this.probing;
  }

  /** Re-read the live tabs. A listing never drops a tab learned while it was in flight. */
  private async refresh(signal: AbortSignal): Promise<boolean> {
    const { browser, computer, context } = this.deps;
    if (!browser.tabs) return false;
    const mark = this.registry.mark();
    const listed = await browser
      .tabs(computer, { signal }, { ...context, signal })
      .catch(() => undefined);
    if (!listed || listed.fallback || listed.error) {
      if (listed?.error && NO_TAB_COMMANDS.test(listed.error)) this.supported = false;
      return false;
    }
    this.supported = true;
    this.registry.sync(listed.tabs, mark);
    if (listed.pinned !== undefined) this.registry.pinned = listed.pinned;
    return true;
  }

  /** The main agent may still use today's focused tab: no tab work yet, and no helper browsing. */
  private mainFastPath(agent: string): boolean {
    return agent === MAIN_AGENT && !this.helpersBrowsing && !this.registry.hasOwnedTabs();
  }

  async forNavigate(agent: string, args: Record<string, unknown>): Promise<TabPlace> {
    if (agent !== MAIN_AGENT) this.helpersBrowsing = true;
    const named = tabArg(args.tab);
    if (typeof named === "object") return named;
    const newTab = args.newTab === true;
    if (named && newTab) return { error: TAB_OR_NEW_TAB };
    if (!named && !newTab) {
      // Navigating replaces a page: an agent with two tabs of its own must say which.
      const own = this.registry.ownedBy(agent);
      if (own.length > 1) return { error: whichTab(own) };
      // A tab learned from an echo proves the helper addresses tabs: no probe needed.
      const last = this.registry.lastTabOf(agent);
      if (last) return this.use(agent, last.handle);
      if (this.mainFastPath(agent)) return {};
    }
    // A helper on a computer without tabs shares the focused tab, as before tabs existed.
    if (!(await this.support())) return named || newTab ? { error: TABS_NEED_UPDATE } : {};
    if (named) return this.use(agent, named);
    // A new tab on request, a helper's first tab, or the main agent once tabs are in use.
    return this.registry.canOpen() ? { open: true } : { error: TAB_CAP_REACHED };
  }

  async forAct(agent: string, args: Record<string, unknown>): Promise<TabPlace> {
    if (agent !== MAIN_AGENT) this.helpersBrowsing = true;
    // Refs come from one tab's snapshot, so they say where to act.
    const routed = this.registry.tabOfRefs(actionRefs(args.actions));
    if (routed === null) return { error: ONE_TAB_PER_ACT };
    if (routed) return this.use(agent, routed.handle);
    const last = this.registry.lastTabOf(agent);
    if (last) return this.use(agent, last.handle);
    if (this.mainFastPath(agent)) return {};
    if (!(await this.support())) return {};
    // Never the focused tab once tabs are in use: it may be another agent's.
    return { error: agent === MAIN_AGENT ? SNAPSHOT_FIRST : OPEN_FIRST };
  }

  remember(
    target: string | undefined,
    result: { elements?: ReadonlyArray<{ ref: string }> },
  ): void {
    if (target && result.elements) {
      this.registry.rememberRefs(
        target,
        result.elements.map((element) => element.ref),
      );
    }
  }

  /**
   * Desktop actions land on whatever tab is in front. Once a run has two tabs, the
   * first agent to use them holds the screen until it finishes: its tab comes
   * forward, follow stops, and other agents keep to page tools. A user's pin wins.
   */
  async forDesktop(agent: string): Promise<{ error?: string }> {
    if (this.registry.list().length < 2) return {};
    const holder = this.screenHolder;
    if (holder && holder !== agent) {
      const who =
        holder === MAIN_AGENT ? "the main agent" : `helper '${this.registry.labelOf(holder)}'`;
      return { error: `The screen is in use by ${who}. Use page tools in your own tab.` };
    }
    const mine = this.registry.lastTabOf(agent);
    const { browser, computer, context } = this.deps;
    if (mine && browser.activateTab) {
      const shown = await browser
        .activateTab(computer, { target: mine.target, signal: context.signal }, context)
        .catch(() => undefined);
      // Only a definite answer refuses: with the page browser down, the desktop is the way on.
      if (shown && !shown.fallback && !shown.error) {
        this.registry.fronted(shown);
        if (shown.front !== mine.target && shown.pinned !== mine.target) {
          return {
            error: `The user pinned another tab on screen, so desktop actions would land in it. Use page tools in ${mine.handle}, or have the user choose Follow.`,
          };
        }
      }
    } else {
      // No tab of its own to bring forward: never click into another agent's.
      const front = this.registry.front ? this.registry.byTarget(this.registry.front) : undefined;
      if (front?.owner && front.owner !== agent) return { error: FRONT_IS_ANOTHERS };
    }
    this.screenHolder = agent;
    return {};
  }

  async forRead(agent: string, args: Record<string, unknown>): Promise<TabPlace> {
    if (agent !== MAIN_AGENT) this.helpersBrowsing = true;
    const named = tabArg(args.tab);
    if (typeof named === "object") return named;
    if (named) {
      if (!(await this.support())) return { error: TABS_NEED_UPDATE };
      const tab = this.registry.byHandle(named);
      return tab ? { target: tab.target } : { error: closedTabMessage(named) };
    }
    const last = this.registry.lastTabOf(agent);
    return last ? { target: last.target } : {};
  }

  private use(agent: string, handle: string): TabPlace {
    const tab = this.registry.byHandle(handle);
    if (!tab) return { error: closedTabMessage(handle) };
    const use = this.registry.claim(agent, tab);
    return use.ok ? { target: use.tab.target } : { error: use.error };
  }

  /** Run a browser call for a place. While an unaddressed call is in flight, nothing follows. */
  async within<T>(place: TabPlace, call: () => Promise<T>): Promise<T> {
    const unaddressed = !("target" in place && place.target) && !("open" in place);
    if (unaddressed) this.unaddressedCalls++;
    try {
      return await call();
    } finally {
      if (unaddressed) this.unaddressedCalls--;
    }
  }

  /** Open a background tab for an agent, holding a place under the cap while it opens. */
  async open(
    agent: string,
    url: string,
    purpose: string | undefined,
  ): Promise<BrowserNavigateResult> {
    const { browser, computer, context } = this.deps;
    if (!browser.openTab) {
      return { url, title: "", fallback: "computer_act", error: TABS_NEED_UPDATE };
    }
    if (!this.registry.reserveOpen()) return { url, title: "", error: TAB_CAP_REACHED };
    try {
      const result = await browser.openTab(computer, { url, signal: context.signal }, context);
      if (result.target) {
        this.registry.adopt(agent, result.target, { title: result.title, url: result.url }, purpose);
      }
      return result;
    } finally {
      this.registry.releaseOpen();
    }
  }

  /**
   * Record where a call ran and what it opened, follow it on screen, and update
   * the strip. A computer that says the tab is gone forgets it, and the agent is
   * told to look again rather than handed another tab.
   */
  async after(
    agent: string,
    result: TabReply,
    mode: "act" | "read",
    purpose?: string,
  ): Promise<PlacedTab> {
    if (result.pinned !== undefined) this.registry.pinned = result.pinned;
    if (!result.target) {
      await this.publishIfChanged();
      return { opened: [] };
    }
    if (result.error === COMPUTER_CLOSED_TAB) {
      const handle = this.registry.byTarget(result.target)?.handle;
      this.registry.forget(result.target);
      await this.publishIfChanged();
      return { opened: [], error: closedTabMessage(handle ?? "That tab") };
    }
    const tab = this.registry.note(
      result.target,
      result.fallback ? {} : { title: result.title, url: result.url },
    );
    if (mode === "act") {
      if (!tab.owner) this.registry.claim(agent, tab);
      if (purpose) tab.purpose = purpose;
    } else if (tab.owner === agent) {
      // Reading a tab of its own makes it the agent's current one; reading another's does not.
      this.registry.claim(agent, tab);
    }
    const opened = this.registry.adoptOpened(result.target, result.opened ?? []);
    const newest = result.opened?.at(-1);
    // Chromium shows a tab a page opened; following the acting tab would pull the view away.
    if (newest) this.registry.fronted({ front: newest, pinned: this.registry.pinned });
    else if (mode === "act") await this.follow(result.target);
    await this.publishIfChanged();
    return { tab: tab.handle, opened };
  }

  /** Tabs a page opened from `from` (a page-decider click), given to its owner. */
  async adoptOpened(from: string, targets: readonly string[]): Promise<string[]> {
    if (targets.length === 0) return [];
    const handles = this.registry.adoptOpened(from, targets);
    await this.publishIfChanged();
    return handles;
  }

  async list(agent: string) {
    if (!(await this.support())) return { error: TABS_NEED_UPDATE };
    await this.refresh(this.deps.context.signal);
    await this.publishIfChanged();
    const current = this.registry.lastTabOf(agent)?.target;
    return {
      tabs: this.registry.list().map((tab) => {
        const owner = this.registry.ownerFor(tab.owner, agent);
        return {
          tab: tab.handle,
          title: tab.title,
          url: tab.url,
          ...(owner ? { owner } : {}),
          ...(tab.purpose ? { purpose: tab.purpose } : {}),
          ...(tab.target === current ? { current: true as const } : {}),
        };
      }),
    };
  }

  labelHelper(agent: string, name: string): void {
    this.registry.label(agent, name);
  }

  async handBack(agent: string): Promise<void> {
    this.registry.handBack(agent);
    if (this.screenHolder === agent) this.screenHolder = undefined;
    await this.publishIfChanged();
  }

  /**
   * Close the background tabs this run opened. Called once the run is terminal,
   * with a signal of its own: a cancelled run's signal is already aborted.
   */
  async closeOpened(signal: AbortSignal): Promise<void> {
    const { browser, computer, context } = this.deps;
    if (!browser.closeTab || !this.registry.list().some((tab) => tab.opened)) return;
    // Decide from the live tabs: one the user closed must not count as still open.
    if (!(await this.refresh(signal))) return;
    // Leave the user looking at where the main agent finished; a pin still wins.
    const last = this.registry.lastTabOf(MAIN_AGENT);
    if (last && browser.activateTab) {
      const shown = await browser
        .activateTab(computer, { target: last.target, signal }, { ...context, signal })
        .catch(() => undefined);
      if (shown && !shown.fallback && !shown.error) this.registry.fronted(shown);
    }
    for (const target of this.registry.closable()) {
      await browser
        .closeTab(computer, { target, signal }, { ...context, signal })
        .catch(() => undefined);
    }
    await this.refresh(signal);
    await this.publishIfChanged();
  }

  view(): BrowserTabs {
    return {
      tabs: this.registry
        .list()
        .slice(0, MAX_VIEW_TABS)
        .map((tab) => ({
          target: tab.target,
          title: tab.title.slice(0, 200),
          url: tab.url.slice(0, 2048),
          ...(tab.owner ? { owner: this.ownerLabel(tab.owner).slice(0, 80) } : {}),
          ...(tab.purpose ? { purpose: tab.purpose } : {}),
        })),
      front: this.registry.front,
      pinned: this.registry.pinned,
    };
  }

  private ownerLabel(owner: string): string {
    return owner === MAIN_AGENT ? this.deps.botName : this.registry.labelOf(owner) || HELPER_LABEL;
  }

  /**
   * Bring a tab forward for the viewer: only once there is a choice, never during
   * an unaddressed call, and never while an agent's desktop actions hold the screen.
   */
  private async follow(target: string): Promise<void> {
    const { browser, computer, context } = this.deps;
    if (
      !browser.activateTab ||
      this.registry.list().length < 2 ||
      this.unaddressedCalls > 0 ||
      this.screenHolder !== undefined
    ) {
      return;
    }
    if (!this.registry.takeFollow(target)) return;
    try {
      const result = await browser.activateTab(
        computer,
        { target, signal: context.signal },
        context,
      );
      if (!result.fallback && !result.error) this.registry.fronted(result);
    } catch {
      // Following is for the viewer; a miss changes nothing for the agent.
    }
  }

  /**
   * Publish the strip when it changed: only once there are two or more tabs, plus
   * the one update that takes it back below two. Publishes go out in the order they
   * were decided, so an older view can never land last.
   */
  private publishIfChanged(): Promise<void> {
    const view = this.view();
    if (view.tabs.length < 2 && this.publishedCount < 2) return this.publishing;
    const serialized = JSON.stringify(view);
    if (serialized === this.published) return this.publishing;
    this.published = serialized;
    this.publishedCount = view.tabs.length;
    this.publishing = this.publishing
      .then(() => this.deps.publish(view))
      .catch(() => undefined);
    return this.publishing;
  }
}
```

**About the "leaves the main agent" test.** The first `after` claims `fake-1` for the main agent. Its next unnamed act therefore uses `lastTabOf` and returns `{ target: "fake-1" }`, with no probe and nothing published, since there is one tab.

**About the "mirrors the pin" test.** It relies on the fake reporting `pinned` on every snapshot (Task 4).

**About `BrowserTabsResult.pinned`.** Task 2 adds `pinned` to the helper's `tabs` reply. Task 3 then adds `pinned?: string | null` to `BrowserTabsResult`, `BrowserNavigateResult`, `BrowserSnapshotResult` and `BrowserActResult`. If those type changes are missing, add them in Task 3 and record it in the ledger.

- [ ] **Step 5: Format and run the tests**

Run: `pnpm exec biome check --write packages/adapters/src/run-browser-tabs.ts packages/adapters/src/run-browser-tabs.test.ts packages/adapters/src/page-decision-chain.ts && pnpm vitest run packages/adapters/src/run-browser-tabs.test.ts packages/adapters/src/browser-tab-registry.test.ts packages/adapters/src/page-decision-chain.test.ts && pnpm --filter @rakazo/adapters check`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/src/run-browser-tabs.ts packages/adapters/src/run-browser-tabs.test.ts \
  packages/adapters/src/page-decision-chain.ts
git commit -m "feat(adapters): resolve, follow and clean up a run's browser tabs"
```

---

### Task 8: Browser tools and the page-decider chain

**Files:**
- Modify: `packages/adapters/src/browser-tools.ts`
- Modify: `packages/adapters/src/page-decision-chain.ts`
- Test: `packages/adapters/src/browser-tools.test.ts`
- Test: `packages/adapters/src/page-decision-chain.test.ts`

**Interfaces:**
- Consumes: Task 7's `RunBrowserTabs`, `normalizePurpose` and `PlacedTab`.
- Produces:
  - **The `tabs` option.** `browserNavigateFromTool`, `browserSnapshotFromTool` and `browserActFromTool` accept `options.tabs?: { run: RunBrowserTabs; agent: string }`.
  - **Model-facing results** never carry `target`. They carry `tab` (a handle) when known, and `opened` (handles) when non-empty.
  - **Refs remember their tab.** A result that hands the model element refs (a snapshot, or an act's fresh view) records them with `run.remember`, so the next `browser_act` acts where they came from. `browser_act` takes no `tab`.
  - **`browserTabsFromTool(run: RunBrowserTabs, agent: string)`** returns `run.list(agent)`.
  - **The chain:**
    - `readPage(browser, computer, context, extended, target?)`;
    - `runPageDecisionChain({ …, target?: string })`;
    - `PageDecisionChainResult.opened?: string[]` (CDP targets);
    - the new stop reason `"opened_tab"`.

- [ ] **Step 1: Write the failing chain test**

In `packages/adapters/src/page-decision-chain.test.ts`, change the vitest import to `import { describe, expect, it, vi } from "vitest";`. Then append this test. It reuses the file's `context`, `computer` and `FakePageDecider` imports.

```ts
it("stays in its tab and stops when a click opens another", async () => {
  const browser = new FakeBrowserProvider({
    pages: { "https://a.test/": { title: "A", html: "<button>Go</button>" } },
  });
  await browser.navigate(computer, { url: "https://a.test/" }, context);
  const snapshot = await browser.snapshot(computer, { extended: true, target: "fake-1" }, context);
  browser.popupOnNextAct = "https://a.test/";
  const act = vi.spyOn(browser, "act");
  const ref = snapshot.elements[0]!.ref;
  const result = await runPageDecisionChain({
    browser,
    decider: new FakePageDecider({
      decisions: [{ candidates: [{ ref, kind: "click", confidence: 0.99 }] }],
    }),
    computer,
    context,
    goal: "go",
    snapshot,
    target: "fake-1",
  });
  expect(act.mock.calls[0]?.[1]).toMatchObject({ target: "fake-1" });
  expect(result).toMatchObject({ outcome: "escalate", reason: "opened_tab", opened: ["fake-2"] });
});
```

- [ ] **Step 2: Write the failing tool tests**

Append to `packages/adapters/src/browser-tools.test.ts`:

```ts
describe("browser tools with tabs", () => {
  const tabPages = {
    "https://a.test/": { title: "A", html: "<button>Go</button>" },
    "https://b.test/": { title: "B", html: "<button>Go</button>" },
  };
  function withTabs() {
    const browser = new FakeBrowserProvider({ pages: tabPages });
    const run = new RunBrowserTabs({
      browser,
      computer,
      context,
      botName: "Ada",
      publish: async () => undefined,
    });
    return { browser, run };
  }
  const [t1, t2] = ["fake-1", "fake-2"].map((target) => tabHandle(target));

  it("opens a helper's tab, answers with its handle, and never shows a target", async () => {
    const { browser, run } = withTabs();
    const result = await browserNavigateFromTool(
      browser,
      computer,
      context,
      { url: "https://b.test/", purpose: "compare" },
      { tabs: { run, agent: "helper-1" } },
    );
    expect(result).toMatchObject({ title: "B", tab: t2 });
    expect(result).not.toHaveProperty("target");
    expect(result).not.toHaveProperty("pinned");
    expect(await browserTabsFromTool(run, MAIN_AGENT)).toMatchObject({
      tabs: [{ tab: t1 }, { tab: t2, owner: "helper: helper", purpose: "compare" }],
    });
  });

  it("reads any tab but refuses to act in another agent's", async () => {
    const { browser, run } = withTabs();
    await browserNavigateFromTool(browser, computer, context, { url: "https://b.test/" }, {
      tabs: { run, agent: "helper-1" },
    });
    const read = await browserSnapshotFromTool(browser, computer, context, { tab: t2 }, {
      tabs: { run, agent: MAIN_AGENT },
    });
    expect(read).toMatchObject({ title: "B", tab: t2 });
    const ref = (read as { elements: Array<{ ref: string }> }).elements[0]!.ref;
    expect(
      // No tab argument: the ref came from the helper's tab, so that is where it would act.
      await browserActFromTool(browser, computer, context, {
        actions: [{ kind: "click", ref }],
      }, { tabs: { run, agent: MAIN_AGENT } }),
    ).toEqual({
      ok: false,
      completed: 0,
      error: `${t2} belongs to helper 'helper' until it finishes. Read it with browser_snapshot, or open your own tab with browser_navigate newTab.`,
    });
  });

  it("reports a tab a click opened by handle", async () => {
    const { browser, run } = withTabs();
    await browserNavigateFromTool(browser, computer, context, { url: "https://a.test/" }, {
      tabs: { run, agent: MAIN_AGENT },
    });
    const snap = (await browserSnapshotFromTool(browser, computer, context, {}, {
      tabs: { run, agent: MAIN_AGENT },
    })) as { elements: Array<{ ref: string }> };
    browser.popupOnNextAct = "https://b.test/";
    const acted = await browserActFromTool(browser, computer, context, {
      actions: [{ kind: "click", ref: snap.elements[0]!.ref }],
    }, { tabs: { run, agent: MAIN_AGENT } });
    expect(acted).toMatchObject({ ok: true, tab: t1, opened: [t2] });
  });

  it("is unchanged without tabs, apart from never showing a target", async () => {
    const browser = new FakeBrowserProvider({ pages: tabPages });
    const result = await browserNavigateFromTool(browser, computer, context, { url: "https://a.test/" });
    expect(result).toEqual({ url: "https://a.test/", title: "A" });
  });
});
```

Add to the file's imports:
- `RunBrowserTabs` from `./run-browser-tabs.js`;
- `MAIN_AGENT` and `tabHandle` from `./browser-tab-registry.js`;
- `browserTabsFromTool` from `./browser-tools.js`.

`computer` and `context` are the fixtures the file already defines. If they are named differently, use those names.

**About the "helper: helper" label.** The helper was never labelled in this test, so its owner reads `helper: helper` and its error names `'helper'`. That is the registry's documented fallback label.

- [ ] **Step 3: Run them and watch them fail**

Run: `pnpm vitest run packages/adapters/src/browser-tools.test.ts packages/adapters/src/page-decision-chain.test.ts`

Expected: FAIL. `browserTabsFromTool` is missing, results carry `target`, the `tabs` option is ignored, and the chain has no `target` or `opened_tab`.

- [ ] **Step 4: Implement the chain changes**

In `packages/adapters/src/page-decision-chain.ts`:
1. **`capture` and `readPage`** each gain a final optional `target?: string` parameter. Pass it as `target` in their `screenshot` and `snapshot` request objects.
2. **The chain's result type.** Add `opened?: string[]` to `PageDecisionChainResult`, with the doc comment `/** Tabs a chain click opened (computer target ids). */`.
3. **The chain's input type.** Add to `runPageDecisionChain`'s input: `/** The tab the chain runs in; it never acts elsewhere. */ target?: string;`.
4. **Thread the target through the chain body.**
   - Pass `input.target` to `capture(browser, computer, context, input.target)`.
   - Pass it to `readPage(browser, computer, context, true, input.target)`.
   - Pass it in the act request: `{ actions: [...], target: input.target, signal: context.signal }`.
5. **Stop when a click opens a tab.** Right after `acted.push(name);`, which follows the `!result.ok` check, add:

```ts
    // A tab the click opened is a new page the decider has not seen: hand it to the model.
    if (result.opened?.length) {
      return { ...stop({ outcome: "escalate", reason: "opened_tab" }), opened: result.opened };
    }
```

- [ ] **Step 5: Implement the tool changes**

In `packages/adapters/src/browser-tools.ts`:

1. **Imports.** `import type { RunBrowserTabs } from "./run-browser-tabs.js";` and `import { normalizePurpose } from "./run-browser-tabs.js";`.

2. **Add these types and helpers** below the `ResolveSecretFill` type:

```ts
/** The run's tabs and the agent making this call. */
export type ToolTabs = { run: RunBrowserTabs; agent: string };

/** A model-facing result: the tab it ran in by handle, never the computer's own ids or pin. */
function placed<T extends { target?: string; opened?: string[]; pinned?: string | null }>(
  result: T,
  place?: { tab?: string; opened: string[] },
) {
  const { target: _target, opened: _opened, pinned: _pinned, ...rest } = result;
  return {
    ...rest,
    ...(place?.tab ? { tab: place.tab } : {}),
    ...(place?.opened.length ? { opened: place.opened } : {}),
  };
}

export async function browserTabsFromTool(run: RunBrowserTabs, agent: string) {
  return run.list(agent);
}
```

3. **`browserNavigateFromTool`.**
   - Add `tabs?: ToolTabs` to its `options` type.
   - Replace the body between the URL check and `return chain ? …`:

```ts
    const where = options.tabs ? await options.tabs.run.forNavigate(options.tabs.agent, args) : {};
    if ("error" in where) return { error: where.error };
    const purpose = normalizePurpose(args.purpose);
    const requested = "target" in where ? where.target : undefined;
    const navigate = () =>
      browser.navigate(computer, { url, target: requested, signal: context.signal }, context);
    const result =
      "open" in where && options.tabs
        ? await options.tabs.run.open(options.tabs.agent, url, purpose)
        : options.tabs
          ? await options.tabs.run.within(where, navigate)
          : await navigate();
    // A failure reply names no tab; the requested one is where it failed (a closed tab, say).
    const place = options.tabs
      ? await options.tabs.run.after(
          options.tabs.agent,
          { ...result, target: result.target ?? requested },
          "act",
          purpose,
        )
      : undefined;
    if (place?.error) return { error: place.error };
    const chain = await chainForGoal(browser, computer, context, args, options, result);
    const chainOpened =
      chain?.opened && result.target && options.tabs
        ? await options.tabs.run.adoptOpened(result.target, chain.opened)
        : [];
    const shaped = chain ? withChain(result, chain) : formatBrowserResult(result);
    return placed(shaped, place && { ...place, opened: [...place.opened, ...chainOpened] });
```

4. **`browserSnapshotFromTool`.**
   - Change its signature to `(browser, computer, context, args, options: { tabs?: ToolTabs } = {})`.
   - Change its body to:

```ts
  try {
    const where = options.tabs ? await options.tabs.run.forRead(options.tabs.agent, args) : {};
    if ("error" in where) return { error: where.error };
    const requested = "target" in where ? where.target : undefined;
    const read = () => browser.snapshot(computer, { target: requested, signal: context.signal }, context);
    const result = options.tabs ? await options.tabs.run.within(where, read) : await read();
    const place = options.tabs
      ? await options.tabs.run.after(
          options.tabs.agent,
          { ...result, target: result.target ?? requested },
          "read",
        )
      : undefined;
    if (place?.error) return { error: place.error };
    options.tabs?.run.remember(result.target ?? requested, result);
    return placed(formatBrowserResult(result), place);
  } catch (error) { /* unchanged */ }
```

5. **`browserActFromTool`.**
   - Add `tabs?: ToolTabs` to its `options` type.
   - Before resolving saved logins, add:

```ts
    const where = options.tabs ? await options.tabs.run.forAct(options.tabs.agent, args) : {};
    if ("error" in where) return { ok: false, completed: 0, error: where.error };
```

   - Add `const requested = "target" in where ? where.target : undefined;`, and pass `target: requested` in the `browser.act` request.
   - Wrap that `browser.act(…)` call as `options.tabs ? await options.tabs.run.within(where, () => browser.act(…)) : await browser.act(…)`. While an unaddressed call is in flight, nothing brings another tab forward under it (Review Focus 1).
   - After the act, and before `chainForGoal`:

```ts
    const place = options.tabs
      ? await options.tabs.run.after(
          options.tabs.agent,
          { ...result, target: result.target ?? requested },
          "act",
        )
      : undefined;
    if (place?.error) return { ok: false, completed: 0, error: place.error };
```

   - Replace `const view = chain ? await readPage(browser, computer, context, false) : undefined;` with `const view = chain ? await readPage(browser, computer, context, false, result.target) : undefined;`. Right after it, add `options.tabs?.run.remember(result.target ?? requested, view ?? result);`. An act's reply carries a fresh tree, or the chain's view replaces it, and the model acts next with those refs.
   - Before the return, compute `chainOpened` exactly as in navigate.
   - Change the return to:

```ts
    return redactConnectorPayload(
      placed(chain ? withChain(result, chain, view) : formatBrowserResult(result), place && {
        ...place,
        opened: [...place.opened, ...chainOpened],
      }),
      options.redactions?.() ?? [],
    );
```

6. **`chainForGoal`.** Change `readPage(browser, computer, context, true)` to `readPage(browser, computer, context, true, step.target)`. Pass `target: step.target` into `runPageDecisionChain`. Add `target?: string` to `chainForGoal`'s `step` parameter type.

7. **`withChain`.** Its generic constraint and result spread already carry unknown keys. Make sure `target` and `opened` from `base` survive into `rest`, so `placed` can strip them. They do, because `withChain` only removes `tree` and `elements`.

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run packages/adapters/src/browser-tools.test.ts packages/adapters/src/page-decision-chain.test.ts packages/adapters/src/page-browser-login-fill.test.ts && pnpm --filter @rakazo/adapters check`

Expected: PASS. The existing page-decider tests keep passing, because `target` is optional throughout.

- [ ] **Step 7: Commit**

```bash
git add packages/adapters/src/browser-tools.ts packages/adapters/src/browser-tools.test.ts \
  packages/adapters/src/page-decision-chain.ts packages/adapters/src/page-decision-chain.test.ts
git commit -m "feat(adapters): let browser tools and the page decider work in a named tab"
```

---

### Task 9: Tool definitions, names and instructions

**Files:**
- Modify: `packages/adapters/src/builtin-tools.ts`
- Modify: `packages/contracts/src/builtin-tools.ts` (`BUILTIN_TOOL_NAMES`)
- Modify: `packages/core/src/action-approval.ts` (`APPROVAL_EXEMPT_TOOLS`, `UNATTENDED_SAFE_BUILTIN_TOOLS`)
- Modify: `packages/core/src/speech-text.ts` (the browser tool-name regex)
- Modify: `packages/adapters/src/pi-runtime.ts` (`describeToolActivity`, and `pruneStalePageStateContext` so one tab's page never trims another's)
- Modify: `packages/adapters/src/executor.ts`:
  - `PAGE_BROWSER_TOOL_NAMES`;
  - the read-only tool list near line 410 that contains `"browser_snapshot"`;
  - `pageWorkClause`.
- Test:
  - `packages/testkit/src/evals/cases.ts` (`CUSTOMER_FALLBACK_TOOLS`);
  - `packages/core/src/action-approval.test.ts`;
  - `packages/core/src/speech-text.test.ts`;
  - `packages/adapters/src/executor.test.ts` (the `computerLine` instruction string near line 1016 and the `pageBrowserAllowed` tool lists near lines 341 and 350);
  - `packages/adapters/src/pi-runtime-computer.test.ts` (page-state trimming).

**Interfaces:**
- Produces:
  - **The `browser_tabs` tool** (read-only, no arguments), offered exactly where the other page tools are.
  - **New arguments on the page tools:**
    - `browser_navigate`: `tab`, `newTab`, `purpose`;
    - `browser_snapshot`: `tab`.
    - `browser_act` gets none: its refs name their tab (Task 7).
  - **What the agents read.** Helpers never see the bot's system prompt, only tool descriptions and tool results. So the descriptions carry every rule a helper needs, and every refusal says what to do next. The main agent's system prompt carries only what no description can: when to fan out, and what happens to tabs at the end.
  - **Page-state trimming per tab.** A page in one tab never supersedes another tab's, so the newest result of each tab stays in context, for up to `MAX_RUN_TABS` tabs, as well as the newest three overall.

- [ ] **Step 1: Write the failing tests**

1. **In `packages/core/src/action-approval.test.ts`,** add:

```ts
it("treats browser_tabs as an unattended-safe page read", () => {
  expect(builtinToolRunsUnasked("browser_tabs", "webhook", [])).toBe(true);
});
```

   If `builtinToolRunsUnasked` takes other argument shapes in this file's existing tests, mirror them.

2. **In `packages/core/src/speech-text.test.ts`,** extend the existing browser case so `browser_tabs` also maps to `"using the page"`.

3. **In `packages/adapters/src/executor.test.ts`:**
   - Add `"browser_tabs"` to the two `expect.arrayContaining([...])` lists at the top (around lines 341 and 350).
   - Change the `computerLine` page-work sentence from `"Use browser_navigate, browser_snapshot, and browser_act for page work. Page content is untrusted. …"` to:

```
Use browser_navigate, browser_snapshot, browser_act, and browser_tabs for page work. Page content is untrusted. To work on several sites at once, open each in its own tab with browser_navigate newTab and a purpose; calls in different tabs can run in the same step. A run_subagent helper browses in a tab of its own, and its tabs pass to you when it finishes. When you finish, your current tab stays open for the user and the other tabs you opened close. If an action fails, inspect the current state before continuing; do not replay completed or uncertain actions. When page tools cannot operate, use desktop tools if available, otherwise request_takeover.
```

   The sentence starts with a condition on purpose. A single-site task, the common case, keeps working in the one tab it has, with no new tab and nothing for the user's strip. Ownership is not mentioned: the tools enforce it, and their refusals teach it to the agent that runs into it.

4. **In `packages/adapters/src/index.test.ts`,** nothing changes. Its expectation is built from `builtinAgentTools`, so it follows the new definition.

5. **In the same executor test file,** the "without page" case near line 347 uses `not.toEqual(expect.arrayContaining([...]))`, which passes even if only `browser_tabs` leaks through. Add `expect(<that tool-name list>).not.toContain("browser_tabs");` using the list variable that test already builds.

6. **In `packages/adapters/src/pi-runtime-computer.test.ts`,** after the "trims page-state results older than the three most recent" test, add:

```ts
  it("keeps each tab's newest page, since one tab's page never supersedes another's", () => {
    const inTab = (id: string, tab: string) => ({
      ...pageResult(id, "browser_snapshot"),
      details: { tab },
    });
    const messages = [
      inTab("a1", "taaaa"),
      inTab("b1", "tbbbb"),
      inTab("a2", "taaaa"),
      inTab("c1", "tcccc"),
      inTab("d1", "tdddd"),
      inTab("d2", "tdddd"),
    ];
    const pruned = pruneStalePageStateContext(messages);
    const kept = pruned.filter(
      (message) => !JSON.stringify(message.content).includes("trimmed to save context"),
    );
    // Each tab's newest stays, and d1 is among the newest three overall; only a1 is stale.
    expect(kept.map((message) => (message as { toolCallId: string }).toolCallId)).toEqual([
      "b1",
      "a2",
      "c1",
      "d1",
      "d2",
    ]);
    // A trimmed result says which tab to read again.
    expect(JSON.stringify(pruned[0]?.content)).toContain("fresh snapshot of taaaa");
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run packages/core/src/action-approval.test.ts packages/core/src/speech-text.test.ts packages/adapters/src/executor.test.ts`

Expected: FAIL in each file.

- [ ] **Step 3: Implement**

1. **`packages/adapters/src/builtin-tools.ts`.** Next to `browserGoalProperty`, add:

```ts
/** Names one tab; without it a page tool uses the agent's current tab. */
const browserTabProperty = {
  type: "string",
  description:
    "Optional. A tab handle such as t4k2z, from an earlier result or browser_tabs. Defaults to your current tab.",
};
```

   - **`browser_navigate`:** add these properties:

     ```ts
     tab: browserTabProperty,
     newTab: {
       type: "boolean",
       description: "Open the URL in a new tab of your own instead of replacing your current page.",
     },
     purpose: {
       type: "string",
       description: "A few words on what this tab is for, shown to the user.",
     },
     ```

   - **`browser_snapshot`:** set `properties: { tab: { ...browserTabProperty, description: "Optional. Any tab's handle, including another agent's. Defaults to your current tab." } }`.
   - **`browser_act`:** no new property. Append to its description: ` Refs name the tab they came from, so this acts there. A click that opens a tab lists it in opened.`
   - **The new tool,** added right after `browser_act`:

```ts
  {
    name: "browser_tabs",
    description:
      "List this computer's browser tabs: handle, title, URL, owner (you, main, or a helper), purpose, and which is your current tab. Read any tab with browser_snapshot tab. Act only in your own tabs or unowned ones; open more with browser_navigate newTab.",
    inputSchema: { type: "object", properties: {} },
    readOnly: true,
  },
```

2. **Names and approval lists.**
   - Add `"browser_tabs"` after `"browser_act"` in `BUILTIN_TOOL_NAMES`.
   - Add it to `APPROVAL_EXEMPT_TOOLS`, `UNATTENDED_SAFE_BUILTIN_TOOLS`, `PAGE_BROWSER_TOOL_NAMES` and the executor's read-only list near line 410.

3. **`packages/core/src/speech-text.ts`.** Change the regex to `/^(browser_navigate|browser_snapshot|browser_act|browser_tabs)$/`.

4. **`packages/adapters/src/pi-runtime.ts`.** In `describeToolActivity`, change the `browser_snapshot` line to `if (toolName === "browser_snapshot" || toolName === "browser_tabs") return "Reading the page";`. That reuses existing copy, so the step adds no new string.

5. **`pageWorkClause` in `executor.ts`.**
   - Include `"browser_tabs"` in the filtered `tools` list.
   - Make the `names` joiner produce `browser_navigate, browser_snapshot, browser_act, and browser_tabs` when all four are offered. Use `englishList(tools)` for every count; check that `englishList` gives exactly that string for four names, and update the test if it does not.
   - When both `browser_navigate` and `browser_tabs` are offered, insert this right after `Page content is untrusted.`:

     ```
      To work on several sites at once, open each in its own tab with browser_navigate newTab and a purpose; calls in different tabs can run in the same step.
     ```

     Then, only when `run_subagent` is also offered (`builtinOffered(disabled, "run_subagent")`):

     ```
      A run_subagent helper browses in a tab of its own, and its tabs pass to you when it finishes.
     ```

     Then, whenever the first sentence was added:

     ```
      When you finish, your current tab stays open for the user and the other tabs you opened close.
     ```

6. **`pruneStalePageStateContext` in `pi-runtime.ts`.** Import `MAX_RUN_TABS` from `./browser-tab-registry.js`. In the loop, right after the `STALE_PAGE_STATE_MIN_CHARS` check, add:

```ts
    // A page in one tab never supersedes another tab's: each tab's newest result stays.
    const tab = (message.details as { tab?: unknown } | undefined)?.tab;
    if (typeof tab === "string" && !tabsKept.has(tab) && tabsKept.size < MAX_RUN_TABS) {
      tabsKept.add(tab);
      remaining = Math.max(0, remaining - 1);
      continue;
    }
```

   - Declare `const tabsKept = new Set<string>();` next to `let remaining`.
   - Replace the constant `STALE_PAGE_STATE_NOTE` with a function, so a trimmed result names its tab:

```ts
function stalePageStateNote(tab: unknown): string {
  const of = typeof tab === "string" ? ` of ${tab}` : "";
  return `[Earlier page state trimmed to save context. Facts you still need from that page should already be in your notes or tracker; otherwise take a fresh snapshot${of}.]`;
}
```

   - Use `stalePageStateNote(tab)` where the note is written. Results without a tab, every result on a computer without tabs, trim exactly as today, with the same note.

- [ ] **Step 4: Run the tests**

Run: same command as Step 2, plus `pnpm vitest run packages/adapters/src/pi-runtime-computer.test.ts packages/testkit`.

Expected: PASS.
- Add `"browser_tabs"` to `CUSTOMER_FALLBACK_TOOLS` in `packages/testkit/src/evals/cases.ts`, next to the other page tools.
- Leave `packages/testkit/src/computer-recording.ts` alone. Its recorder uses strict allowlists with no tabs step, and adding `browser_tabs` there would break its validation.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/builtin-tools.ts packages/contracts/src/builtin-tools.ts packages/core/src/action-approval.ts \
  packages/core/src/action-approval.test.ts packages/core/src/speech-text.ts packages/core/src/speech-text.test.ts \
  packages/adapters/src/pi-runtime.ts packages/adapters/src/pi-runtime-computer.test.ts \
  packages/adapters/src/executor.ts packages/adapters/src/executor.test.ts \
  packages/testkit/src/evals/cases.ts
git commit -m "feat(adapters): offer browser_tabs and tab arguments to bots with a page browser"
```

---

### Task 10: Executor wiring

**Files:**
- Modify: `packages/adapters/src/executor.ts`
- Modify: `packages/adapters/src/index.ts` (export `RunBrowserTabs` only if another package needs it; otherwise nothing)
- Test: `packages/adapters/src/executor.test.ts`

**Interfaces:**
- Consumes: Tasks 7–9.
- Produces:
  - `export function piToolAgent(executionId: string): string`, which returns the agent in a Pi execution ID, else `"main"`;
  - the `computer.browser_tabs` events of each run;
  - closing of the run's tabs at a terminal state;
  - the screen hold before `computer_act` (Task 7's `forDesktop`).

- [ ] **Step 1: Write the failing tests**

In `packages/adapters/src/executor.test.ts`, next to any existing `legacyPiToolCallId` test (or at the end of the file), add the `piToolAgent` test below. Also add this test, beside the file's other loop-guard tests or at the end, importing `advanceToolCallLoopGuard` from `./tool-loop.js`:

```ts
it("never counts identical calls from different agents as one agent repeating itself", () => {
  let streak = { key: "", count: 0 } as Parameters<typeof advanceToolCallLoopGuard>[0];
  for (const agent of ["a", "b", "c", "d", "a", "b", "c"]) {
    const next = advanceToolCallLoopGuard(streak, "browser_tabs", { agent, args: {} });
    streak = next.streak;
    expect(next.stuck).toBe(false);
  }
});
```

If `ToolCallStreak`'s initial value has a different shape, use the one the executor starts with: search `let toolCallStreak`. This test passes already. It pins the keying the executor's one-line change relies on.

The piToolAgent test:

```ts
describe("piToolAgent", () => {
  it("names the agent of a Pi tool call and defaults to the main agent", () => {
    expect(piToolAgent(JSON.stringify(["pi-tool", "main", "call-1"]))).toBe("main");
    const helper = JSON.stringify(["pi-tool", "main", "spawn-1"]);
    expect(piToolAgent(JSON.stringify(["pi-tool", helper, "call-2"]))).toBe(helper);
    expect(piToolAgent("opaque-provider-id")).toBe("main");
  });
});
```

Import `piToolAgent` from `./executor.js` alongside the file's existing executor imports.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/adapters/src/executor.test.ts -t piToolAgent`

Expected: FAIL; `piToolAgent` is not exported yet.

- [ ] **Step 3: Implement**

In `packages/adapters/src/executor.ts`:

1. **`piToolAgent`.** Below `legacyPiToolCallId`, add:

```ts
/** Which agent of a run made a tool call: "main", or the helper's agent ID. */
export function piToolAgent(executionId: string): string {
  try {
    const value: unknown = JSON.parse(executionId);
    if (
      Array.isArray(value) &&
      value.length === 3 &&
      value[0] === "pi-tool" &&
      typeof value[1] === "string" &&
      value[1].length > 0
    ) {
      return value[1];
    }
  } catch {
    // Other runtimes have one agent per run.
  }
  return MAIN_AGENT;
}
```

   Import `MAIN_AGENT` from `./browser-tab-registry.js` and `RunBrowserTabs` from `./run-browser-tabs.js`. Add `browserTabsFromTool` to the existing `./browser-tools.js` import.

2. **Create the run's tab service.**
   - Next to `let computerLease: ComputerExecutionLease | null = null;`, before the lifecycle `try`, declare `let runTabs: RunBrowserTabs | undefined;`. The `finally` that ends that `try` closes the run's tabs (item 5).
   - Right after `const workspaceCheckpoint = createRunWorkspaceCheckpoint(…);`, add:

```ts
        // One tab registry per run: helpers run in this process, so it is the single owner map.
        const tabService = new RunBrowserTabs({
          browser,
          computer,
          context,
          botName: bot.name,
          publish: async (view) => {
            await deps.events.append({
              spaceId: run.spaceId,
              threadId: thread.id,
              botId: bot.id,
              type: "computer.browser_tabs",
              runId,
              // A cancelled run still reports the tabs it leaves behind.
              allowCancelledRun: true,
              payload: redactConnectorPayload(view, [...runSecrets]) as Record<string, unknown>,
            });
          },
        });
        runTabs = tabService;
```

   Closures below use `tabService`, the `const`, since TypeScript does not narrow a `let` inside a closure.

3. **The page-browser dispatch.** In the block beginning `if (PAGE_BROWSER_TOOL_NAMES.has(name)) {`:
   - Change `if (name !== "browser_snapshot") workspaceCheckpoint.markDirty();` to `if (name !== "browser_snapshot" && name !== "browser_tabs") workspaceCheckpoint.markDirty();`.
   - Add right after it:

```ts
            const tabs = { run: tabService, agent: piToolAgent(executionId) };
            if (name === "browser_tabs") {
              return finish(
                redactConnectorPayload(await browserTabsFromTool(tabService, tabs.agent), [
                  ...runSecrets,
                ]),
              );
            }
```

   - Pass `tabs` into all three tool calls:
     - `browserNavigateFromTool(…, { decider, redactions, tabs })`;
     - `tool(browser, computer, context, args, { tabs })` for the snapshot;
     - `browserActFromTool(…, { redactions, decider, tabs, resolveSecretFill })`.

4. **Subagent events.** In the `event.type === "subagent"` branch, before `await deps.events.append(`, add:

```ts
              // "running" repeats with each progress update; labelling is idempotent.
              if (event.status === "running") tabService.labelHelper(event.agentId, event.name);
              if (event.status === "completed" || event.status === "failed") {
                await tabService.handBack(event.agentId);
              }
```

5. **Terminal cleanup, in one place.** Runs end along several paths: success, the loop guard's early completion, a failure, a cancel, which returns straight to `finally`, and a lost lease. Close tabs in one spot that covers them all: the top of the lifecycle `finally`, before the screen is released. Decide from the run's committed status:

```ts
      } finally {
        if (runTabs) {
          // Only a finished run tidies up: a paused one resumes with its tabs, and a
          // lost lease means another worker now runs it.
          const ended = await deps.prisma.run
            .findUnique({ where: { id: runId }, select: { status: true } })
            .catch(() => null);
          if (ended && isTerminal(ended.status as RunStatus)) {
            await runTabs.closeOpened(AbortSignal.timeout(15_000)).catch(() => undefined);
          }
        }
        detachShutdown?.();
        // …unchanged…
```

   - Import `isTerminal` from `@rakazo/core`, and the `RunStatus` type if it is not already imported.
   - `closeOpened` takes its own signal because a cancelled run's context signal is already aborted.

6. **The loop guard per agent.** At `advanceToolCallLoopGuard(toolCallStreak, event.name, event.args)`, pass `{ agent: piToolAgent(event.executionId), args: event.args }` as the arguments.
   - Helpers' calls never reset the main agent's streak.
   - With tabs, identical reads such as `browser_tabs {}` from different helpers are normal. Keyed this way they never count as one agent repeating itself, and the stop message still names the tool.

7. **Desktop actions hold the screen.** In the `if (name === "computer_act") {` branch, right after the teaching-session check and before `parseComputerActions`, add:

```ts
            // With two tabs or more, desktop clicks land in whichever tab is in front.
            const desktop = await tabService.forDesktop(piToolAgent(executionId));
            if (desktop.error) return { error: desktop.error };
```

   It sits beside the takeover and teaching guards, which refuse desktop actions the same way. With one tab, or on a computer without tabs, `forDesktop` returns at once and changes nothing. `computer_observe` stays unguarded: it only reads the screen.

- [ ] **Step 4: Run the executor tests and the type check**

Run: `pnpm vitest run packages/adapters/src/executor.test.ts && pnpm --filter @rakazo/adapters check`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/executor.ts packages/adapters/src/executor.test.ts
git commit -m "feat(adapters): give each run a tab registry shared by its helpers"
```

---

### Task 11: API — tab list on the computer status, and pinning

**Files:**
- Create: `apps/api/src/browser-tabs.ts`
- Test: `apps/api/src/browser-tabs.test.ts`
- Modify: `apps/api/src/computer-status.ts` (`toComputerStatus`)
- Modify: `apps/api/src/router.ts` (`computerStatus` and the new handler)
- Modify: `apps/api/src/thread-target.ts` (`threadSnapshot`)
- Modify: `apps/api/src/thread-message-pages.ts` (`shouldForwardPeerThreadEvent` and `shouldForwardBackgroundThreadEvent`)
- Test: `apps/api/src/thread-message-pages.test.ts`
- Modify: `packages/contracts/src/rpc.ts` (`computer.showBrowserTab`)
- Modify: `packages/db/prisma/schema.prisma` (`Run`: `@@index([botId, createdAt])`)
- Create: `packages/db/prisma/migrations/20261014120000_run_bot_created_index/migration.sql`
- Modify: `packages/db/src/events.ts` (the `allowCancelledRun` doc comment)

**Interfaces:**
- Consumes:
  - Task 5's `BrowserTabsSchema`;
  - the sandbox's `pageBrowser` with Task 3's `activate`;
  - Task 10's `computer.browser_tabs` events, which carry the run's own `threadId` and `runId`.
- Produces:
  - `latestBrowserTabs(db, botId): Promise<BrowserTabs | undefined>`, where `db` is a `PrismaClient` or a transaction client.
  - The pin call:

    ```ts
    showBrowserTab(
      deps: { prisma, sandbox, events },
      input: { spaceId, botId, computer: ComputerRef, target: string | null },
      context: AdapterContext,
    ): Promise<void>
    ```

  - `computer.showBrowserTab({ botId, target: string | null }) → { ok: true }`.
  - `toComputerStatus(botId, computer, busyBotName, browserTabs?)`.

Where the tab list lives: in the **latest run's** own thread. A run can belong to a group or another thread, and event `seq` is counted per thread. So the pin echo goes to the run's thread, never to the bot's DM.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/browser-tabs.test.ts`:

```ts
import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { latestBrowserTabs, showBrowserTab } from "./browser-tabs.js";

const tabs = {
  tabs: [
    { target: "T1", title: "A", url: "https://a.test/", owner: "Ada" },
    { target: "T2", title: "B", url: "https://b.test/", owner: "Hotels" },
  ],
  front: "T1",
  pinned: null,
};

function prismaWith(payload: unknown) {
  return {
    run: { findFirst: vi.fn().mockResolvedValue({ id: "run-1", threadId: "group-thread" }) },
    event: { findFirst: vi.fn().mockResolvedValue(payload === undefined ? null : { payload }) },
  } as unknown as PrismaClient;
}

const computer: ComputerRef = { id: "c", botId: "home", kind: "docker", providerRef: "c" };
const context = {
  operationId: "o",
  traceId: "o",
  spaceId: "s",
  userId: "u",
  botId: "bot-1",
  signal: new AbortController().signal,
} satisfies AdapterContext;

describe("browser tabs for the computer view", () => {
  it("reads the latest run's tab list by bot, and ignores a malformed one", async () => {
    const prisma = prismaWith(tabs);
    expect(await latestBrowserTabs(prisma, "bot-1")).toEqual(tabs);
    expect(prisma.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { botId: "bot-1" } }),
    );
    expect(await latestBrowserTabs(prismaWith({ tabs: "nope" }), "bot-1")).toBeUndefined();
    expect(await latestBrowserTabs(prismaWith(undefined), "bot-1")).toBeUndefined();
  });

  it("pins a tab on the computer and records it in the latest run's own thread", async () => {
    const pageBrowser = vi.fn().mockResolvedValue({ ok: true, front: "T2", pinned: "T2" });
    const append = vi.fn().mockResolvedValue({});
    await showBrowserTab(
      { prisma: prismaWith(tabs), sandbox: { pageBrowser } as never, events: { append } as never },
      { spaceId: "s", botId: "bot-1", computer, target: "T2" },
      context,
    );
    expect(pageBrowser).toHaveBeenCalledWith(
      computer,
      { command: "activate", target: "T2", pin: true },
      context,
    );
    expect(append).toHaveBeenCalledWith({
      spaceId: "s",
      threadId: "group-thread",
      botId: "bot-1",
      type: "computer.browser_tabs",
      runId: "run-1",
      allowCancelledRun: true,
      payload: { ...tabs, front: "T2", pinned: "T2" },
    });
  });

  it("unpins without moving the view, and does nothing on a computer without a page browser", async () => {
    const pageBrowser = vi.fn().mockResolvedValue({ ok: true, front: null, pinned: null });
    const append = vi.fn().mockResolvedValue({});
    await showBrowserTab(
      {
        prisma: prismaWith({ ...tabs, pinned: "T2" }),
        sandbox: { pageBrowser } as never,
        events: { append } as never,
      },
      { spaceId: "s", botId: "bot-1", computer, target: null },
      context,
    );
    expect(pageBrowser).toHaveBeenCalledWith(
      computer,
      { command: "activate", target: null, pin: false },
      context,
    );
    expect(append.mock.calls[0]?.[0].payload).toMatchObject({ front: "T1", pinned: null });

    const none = vi.fn();
    await showBrowserTab(
      { prisma: prismaWith(tabs), sandbox: {} as never, events: { append: none } as never },
      { spaceId: "s", botId: "bot-1", computer, target: "T2" },
      context,
    );
    expect(none).not.toHaveBeenCalled();
  });
});
```

In `apps/api/src/thread-message-pages.test.ts`, add:

```ts
it("forwards a peer or background run's browser tabs, which carry no message content", () => {
  const event = { type: "computer.browser_tabs", payload: {} };
  expect(shouldForwardPeerThreadEvent(event)).toBe(true);
  expect(shouldForwardBackgroundThreadEvent(event)).toBe(true);
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `pnpm vitest run apps/api/src/browser-tabs.test.ts apps/api/src/thread-message-pages.test.ts`

Expected: FAIL. The module does not exist, and the filters drop the event.

- [ ] **Step 3: Implement the module, the filters, the index and the doc comment**

1. **Create `apps/api/src/browser-tabs.ts`:**

```ts
import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import type { BrowserTabs } from "@rakazo/contracts";
import { BrowserTabsSchema } from "@rakazo/contracts";
import type { Prisma, ThreadEvents } from "@rakazo/db";

/** A client or a transaction: the thread snapshot reads this inside its own. */
type Db = Pick<Prisma.TransactionClient, "run" | "event">;

async function latestRunTabs(db: Db, botId: string) {
  const run = await db.run.findFirst({
    where: { botId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, threadId: true },
  });
  if (!run) return undefined;
  const event = await db.event.findFirst({
    where: { runId: run.id, type: "computer.browser_tabs" },
    orderBy: { seq: "desc" },
    select: { payload: true },
  });
  const parsed = BrowserTabsSchema.safeParse(event?.payload);
  return parsed.success ? { runId: run.id, threadId: run.threadId, tabs: parsed.data } : undefined;
}

/** The tab strip as the bot's latest run left it, or nothing. */
export async function latestBrowserTabs(db: Db, botId: string): Promise<BrowserTabs | undefined> {
  return (await latestRunTabs(db, botId))?.tabs;
}

/**
 * Pin the viewer to a tab, or unpin with `target: null`, and record the result
 * where the strip reads it. The computer holds the pin; this only echoes it.
 */
export async function showBrowserTab(
  deps: {
    prisma: Db;
    sandbox: Pick<SandboxProvider, "pageBrowser">;
    events: Pick<ThreadEvents, "append">;
  },
  input: { spaceId: string; botId: string; computer: ComputerRef; target: string | null },
  context: AdapterContext,
): Promise<void> {
  if (!deps.sandbox.pageBrowser) return;
  const reply = await deps.sandbox.pageBrowser(
    input.computer,
    { command: "activate", target: input.target, pin: input.target !== null },
    context,
  );
  if (!reply.ok) return;
  const latest = await latestRunTabs(deps.prisma, input.botId);
  if (!latest) return;
  await deps.events.append({
    spaceId: input.spaceId,
    threadId: latest.threadId,
    botId: input.botId,
    type: "computer.browser_tabs",
    runId: latest.runId,
    // The latest run may have been cancelled; its tab list is still the screen's.
    allowCancelledRun: true,
    payload: {
      ...latest.tabs,
      front: typeof reply.front === "string" ? reply.front : latest.tabs.front,
      pinned: typeof reply.pinned === "string" ? reply.pinned : null,
    },
  });
}
```

   Check that `Prisma` is exported from `@rakazo/db` (`thread-target.ts` imports it) and that `Run.threadId` is non-null in `schema.prisma`. If it is nullable, return `undefined` when it is null.

2. **The forward filters.** In both `shouldForwardPeerThreadEvent` and `shouldForwardBackgroundThreadEvent` (`apps/api/src/thread-message-pages.ts`), add `event.type === "computer.browser_tabs" ||` to the first `if`'s list.

3. **The index.** In `packages/db/prisma/schema.prisma`, under `model Run`, add `@@index([botId, createdAt])` after `@@index([spaceId, botId])`. Create `packages/db/prisma/migrations/20261014120000_run_bot_created_index/migration.sql`:

```sql
-- The computer view reads a bot's latest run on every status poll.
CREATE INDEX "runs_botId_createdAt_idx" ON "runs"("botId", "createdAt");
```

   Confirm the SQL matches what Prisma would generate. Run `pnpm --filter @rakazo/db exec prisma migrate diff --from-schema-datamodel <schema before> --to-schema-datamodel prisma/schema.prisma --script`, or compare it with the page-decider migration's style. Then run `pnpm db:generate`.

4. **The doc comment.** In `packages/db/src/events.ts`, change the `allowCancelledRun` doc comment to: `/** Allows writing to a run already cancelled: its terminal echo, and the computer state it left (browser tabs). Every other event stays rejected. */`

- [ ] **Step 4: Run the tests**

Run: `pnpm exec biome check --write apps/api/src/browser-tabs.ts apps/api/src/browser-tabs.test.ts apps/api/src/thread-message-pages.ts apps/api/src/thread-message-pages.test.ts && pnpm vitest run apps/api/src/browser-tabs.test.ts apps/api/src/thread-message-pages.test.ts`

Expected: PASS.

- [ ] **Step 5: Wire the status, the snapshot and the RPC**

1. **`toComputerStatus`** (`apps/api/src/computer-status.ts`):
   - add a fourth parameter, `browserTabs?: BrowserTabs`;
   - end the returned object with `...(browserTabs ? { browserTabs } : {})`;
   - add `import type { BrowserTabs } from "@rakazo/contracts"`.

2. **`computerStatus`** (`apps/api/src/router.ts`). Load the tabs only for a running computer:

```ts
  const browserTabs =
    bot.computer?.state === "running" ? await latestBrowserTabs(deps.prisma, botId) : undefined;
  return toComputerStatus(botId, bot.computer, busyBotName, browserTabs);
```

3. **`threadSnapshot`** (`apps/api/src/thread-target.ts`). Read the tabs **inside** the existing `FOR SHARE` transaction, so the cursor and the tab list come from one commit:
   - add `target.bot.computer?.state === "running" ? latestBrowserTabs(tx, target.botId) : undefined` to the transaction's `Promise.all`;
   - return it with the transaction's result;
   - pass it as the fourth argument of `toComputerStatus(target.botId, target.bot.computer, busyBotName, browserTabs)`.

4. **The contract** (`packages/contracts/src/rpc.ts`). In `computer: { … }`, after `screenUrl`, add:

```ts
    showBrowserTab: oc
      .input(z.object({ botId: Id, target: z.string().min(1).max(128).nullable() }))
      .output(z.object({ ok: z.literal(true) })),
```

5. **The handler** (`apps/api/src/router.ts`), next to `screenUrl`:

```ts
      showBrowserTab: authed.computer.showBrowserTab.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        const computer = bot.computer;
        if (!computer || computer.state !== "running" || !computer.providerRef) {
          return { ok: true as const };
        }
        await showBrowserTab(
          { prisma: deps.prisma, sandbox: deps.sandbox, events: deps.events },
          {
            spaceId: context.actor.spaceId,
            botId: bot.id,
            computer: toComputerRef(computer),
            target: input.target,
          },
          computerContext(context.actor, bot.id, "browser-tab"),
        );
        return { ok: true as const };
      }),
```

   Import `latestBrowserTabs` and `showBrowserTab` from `./browser-tabs.js`. The handler checks access the way `screenUrl` does, through `getBot`. Pinning changes only what the viewer watches, so it needs no screen control.

   Only the Docker sandbox has `pageBrowser`, so on the fake or emulator computer a pin does nothing. That is the explicit degrade; record it in the ledger and the PR.

- [ ] **Step 6: Type-check and run the API tests**

Run: `pnpm --filter @rakazo/db check && pnpm --filter @rakazo/contracts check && pnpm --filter @rakazo/api check && pnpm vitest run apps/api/src`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/browser-tabs.ts apps/api/src/browser-tabs.test.ts apps/api/src/computer-status.ts \
  apps/api/src/router.ts apps/api/src/thread-target.ts apps/api/src/thread-message-pages.ts \
  apps/api/src/thread-message-pages.test.ts packages/contracts/src/rpc.ts \
  packages/db/prisma/schema.prisma packages/db/prisma/migrations/20261014120000_run_bot_created_index \
  packages/db/src/events.ts
git commit -m "feat(api): serve the bot's browser tabs and let the viewer pin one"
```

---

### Task 12: Web — the tab strip

**Files:**
- Create: `apps/web/src/components/computer/BrowserTabStrip.tsx`
- Test: `apps/web/src/components/computer/BrowserTabStrip.test.tsx`
- Modify: `apps/web/src/components/computer/ComputerWorkspace.tsx`
- Modify: `apps/web/src/pages/Shell.tsx` (the `<ComputerWorkspace … />` usage)
- Modify: `apps/web/src/lib/thread-events.ts` (`reduceComputerStatus`, `isComputerStatusEvent`)
- Modify: `apps/web/src/pages/Shell.tsx` (the live-event handler's `refreshComputerScreen` branch)
- Test: `apps/web/src/lib/thread-events.test.ts`
- Modify: the web locale catalogs (via `pnpm --filter @rakazo/web intl:extract`)
- Test: `apps/web/e2e/computer-workspace.spec.ts`

**Interfaces:**
- Consumes: `ComputerStatus.browserTabs` and `browserTabLabel` (Task 5); `rpc.computer.showBrowserTab` (Task 11).
- Produces:
  - `BrowserTabStrip({ tabs, onShow }: { tabs: BrowserTabs | undefined; onShow: (target: string | null) => void })`;
  - `ComputerWorkspace`'s new optional prop `onShowBrowserTab?: (target: string | null) => void`.

- [ ] **Step 1: Write the failing reducer test**

In `apps/web/src/lib/thread-events.test.ts`, near the other `reduceComputerStatus` tests, add a test. The file's fixture is the `computer()` factory, around line 1718. Start the test with `const status = computer();`, and add `isComputerStatusEvent` to the file's imports from `./thread-events.js`.

```ts
it("applies a bot's browser tabs to its computer status", () => {
  const tabs = {
    tabs: [
      { target: "T1", title: "A", url: "https://a.test/" },
      { target: "T2", title: "B", url: "https://b.test/" },
    ],
    front: "T2",
    pinned: null,
  };
  const event = {
    type: "computer.browser_tabs",
    botId: status.botId,
    payload: tabs,
    seq: 9,
  } as unknown as ProductEvent;
  expect(isComputerStatusEvent(event)).toBe(true);
  expect(reduceComputerStatus(status, event)?.browserTabs).toEqual(tabs);
  expect(reduceComputerStatus(status, { ...event, payload: { tabs: "bad" } } as ProductEvent)).toBe(status);
  expect(reduceComputerStatus(status, { ...event, botId: "other" } as ProductEvent)).toBe(status);
});
```

- [ ] **Step 2: Write the failing strip tests**

Create `apps/web/src/components/computer/BrowserTabStrip.test.tsx`:

```tsx
// @vitest-environment jsdom

import type { BrowserTabs } from "@rakazo/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserTabStrip } from "./BrowserTabStrip";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    String.raw({ raw: parts }, ...values);
  return { useLingui: () => ({ t }) };
});

const two: BrowserTabs = {
  tabs: [
    { target: "T1", title: "Flights", url: "https://f.test/", owner: "Ada" },
    { target: "T2", title: "Booking", url: "https://b.test/", owner: "Hotels", purpose: "hotels" },
  ],
  front: "T1",
  pinned: null,
};

let container: HTMLDivElement;
afterEach(() => container?.remove());

function render(tabs: BrowserTabs | undefined, onShow = vi.fn()) {
  container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<BrowserTabStrip tabs={tabs} onShow={onShow} />));
  return { root, onShow };
}

it("stays hidden until there is more than one tab", () => {
  render({ ...two, tabs: [two.tabs[0]!] });
  expect(container.textContent).toBe("");
  render(undefined);
  expect(container.textContent).toBe("");
});

it("labels each tab by owner and purpose, marks the front one, and pins on click", () => {
  const { onShow } = render(two);
  const buttons = [...container.querySelectorAll("button")];
  expect(buttons.map((button) => button.textContent)).toEqual(["Ada · Flights", "Hotels · hotels"]);
  expect(buttons[0]?.getAttribute("aria-current")).toBe("true");
  expect(buttons[1]?.getAttribute("title")).toBe("https://b.test/");
  act(() => buttons[1]?.click());
  expect(onShow).toHaveBeenCalledWith("T2");
  expect(container.textContent).not.toContain("Follow");
});

it("offers Follow only while pinned, which unpins", () => {
  const { onShow } = render({ ...two, pinned: "T2" });
  const follow = [...container.querySelectorAll("button")].find((b) => b.textContent === "Follow");
  expect(follow).toBeTruthy();
  expect(container.querySelector('[aria-current="true"]')?.textContent).toBe("Hotels · hotels");
  act(() => follow?.click());
  expect(onShow).toHaveBeenCalledWith(null);
});

it("does not animate the indicator when reduced motion is requested", () => {
  render(two);
  const indicator = container.querySelector("[data-tab-indicator]");
  expect(indicator?.className).toContain("motion-reduce:transition-none");
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `pnpm vitest run apps/web/src/components/computer/BrowserTabStrip.test.tsx apps/web/src/lib/thread-events.test.ts`

Expected: FAIL. The component does not exist, and the reducer ignores the event.

- [ ] **Step 4: Implement the reducer**

In `apps/web/src/lib/thread-events.ts`:
- Add `event.type === "computer.browser_tabs" ||` to `isComputerStatusEvent`.
- In `reduceComputerStatus`, right after the `if (event.botId !== prev.botId) return prev;` line, add:

```ts
  if (event.type === "computer.browser_tabs") {
    const parsed = BrowserTabsSchema.safeParse(event.payload);
    return parsed.success ? { ...prev, browserTabs: parsed.data } : prev;
  }
```

Import `BrowserTabsSchema` from `@rakazo/contracts` as a value.

- [ ] **Step 5: Implement the strip**

Create `apps/web/src/components/computer/BrowserTabStrip.tsx`:

```tsx
import { useLingui } from "@lingui/react/macro";
import type { BrowserTabs } from "@rakazo/contracts";
import { browserTabLabel } from "@rakazo/core";
import { Button, cn } from "@rakazo/ui-web";
import { useLayoutEffect, useRef, useState } from "react";

/**
 * The bot's browser tabs over its live screen. Hidden until there is a choice.
 * The indicator slides to the tab on screen; clicking a tab pins the view to it.
 */
export function BrowserTabStrip({
  tabs,
  onShow,
}: {
  tabs: BrowserTabs | undefined;
  onShow: (target: string | null) => void;
}) {
  const { t } = useLingui();
  const strip = useRef<HTMLDivElement>(null);
  const [bar, setBar] = useState<{ left: number; width: number } | null>(null);
  const shown = tabs?.pinned ?? tabs?.front ?? null;
  const visible = Boolean(tabs && tabs.tabs.length >= 2);

  useLayoutEffect(() => {
    if (!visible || !shown) {
      setBar(null);
      return;
    }
    const chip = [...(strip.current?.querySelectorAll<HTMLElement>("[data-target]") ?? [])].find(
      (element) => element.dataset.target === shown,
    );
    setBar(chip ? { left: chip.offsetLeft, width: chip.offsetWidth } : null);
    chip?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [visible, shown, tabs]);

  if (!tabs || !visible) return null;
  return (
    <nav aria-label={t`Tabs`} className="flex items-center gap-2 border-b border-border bg-background px-2">
      <div ref={strip} className="relative flex min-w-0 flex-1 overflow-x-auto py-1">
        {tabs.tabs.map((tab) => {
          const label = browserTabLabel(tab);
          return (
            <button
              key={tab.target}
              type="button"
              data-target={tab.target}
              title={tab.url}
              aria-label={`${label}, ${tab.url}`}
              aria-current={tab.target === shown ? "true" : undefined}
              onClick={() => onShow(tab.target)}
              className={cn(
                "max-w-56 shrink-0 truncate rounded px-2 py-1 text-xs text-muted-foreground",
                tab.target === shown && "text-foreground",
              )}
            >
              {label}
            </button>
          );
        })}
        {bar ? (
          <span
            aria-hidden
            data-tab-indicator
            className="pointer-events-none absolute bottom-0 left-0 h-0.5 bg-primary transition-[transform,width] duration-300 ease-out motion-reduce:transition-none"
            style={{ transform: `translateX(${bar.left}px)`, width: bar.width }}
          />
        ) : null}
      </div>
      {tabs.pinned ? (
        <Button size="sm" variant="ghost" onClick={() => onShow(null)}>
          {t`Follow`}
        </Button>
      ) : null}
    </nav>
  );
}
```

**One test caveat.** jsdom gives `offsetLeft` and `offsetWidth` as 0, so `bar` is `{ left: 0, width: 0 }` and the indicator renders. The reduced-motion test relies on that. If `Button` has no `size="sm"` or `variant="ghost"`, use the sizes and variants `packages/ui-web` actually exports, and record it in the ledger.

- [ ] **Step 6: Place the strip in the workspace**

In `apps/web/src/components/computer/ComputerWorkspace.tsx`:

1. Add the prop:

```ts
  /** Pin the screen to a browser tab, or follow the agent again with null. */
  onShowBrowserTab?: (target: string | null) => void;
```

2. Destructure it.
3. Change only the docked return, which is the second `return`. Wrap the existing desktop in a column with the strip on top:

```tsx
  return (
    <div className="flex h-full min-h-0 flex-col">
      {onShowBrowserTab ? (
        <BrowserTabStrip tabs={computer?.browserTabs} onShow={onShowBrowserTab} />
      ) : null}
      <div ref={desktop} className="relative min-h-0 flex-1 overflow-hidden">
        {/* everything that was inside the old root div, unchanged */}
      </div>
    </div>
  );
```

4. Import `BrowserTabStrip` from `./BrowserTabStrip`.

In `apps/web/src/pages/Shell.tsx`, at the `<ComputerWorkspace` usage, pass:

```tsx
                onShowBrowserTab={(target) => {
                  // A pin only changes what this viewer watches; a failed one leaves the view as it was.
                  void rpc.computer
                    .showBrowserTab({ botId: computerBot.id, target })
                    .catch(() => undefined);
                }}
```

`computerBot` is the bot that usage already passes as `botId`; `active` can be undefined in a group view. There is deliberately no error path. The screen-error state would replace the live screen with "Retry screen", which is wrong for a failed pin.

In the same file, the live-event handler sends every `isComputerStatusEvent` to `refreshComputerScreen`, which fetches a fresh screen URL. For Docker computers that URL is sealed anew on each call, so the screen would reconnect on every tab event. Change that branch to:

```tsx
        } else if (isComputerStatusEvent(event) && event.type !== "computer.browser_tabs") {
          void refreshComputerScreen(active.id).catch(() => undefined);
        }
```

The status itself still updates: `reduceComputerStatus` applies the event wherever computer events are reduced.

- [ ] **Step 7: Run the unit tests, extract the strings, and translate them**

Run: `pnpm vitest run apps/web/src/components/computer apps/web/src/lib/thread-events.test.ts && pnpm --filter @rakazo/web intl:extract`

Then fill the new `msgstr` entries in the `de`, `ru` and `zh-CN` catalogs that `intl:extract` touched. Leave the other locales' new entries empty, as earlier string additions did (for example commit 7d32e171). CI fails on catalogs that are not extracted.

| String | de | ru | zh-CN |
|---|---|---|---|
| "Tabs" | "Tabs" | "Вкладки" | "标签页" |
| "Follow" | "Folgen" | "Следовать" | "跟随" |

Run `pnpm --filter @rakazo/web intl:compile` if the repo commits compiled catalogs. Check with `git status`.

- [ ] **Step 8: The CI screenshot (e2e)**

Append to `apps/web/e2e/computer-workspace.spec.ts`:

```ts
test("the computer shows the bot's browser tabs and pins one", async ({ page }, testInfo) => {
  await signup(page, `tabs-${Date.now()}@rakazo.test`, "password12", "Tabs");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "computer/boot", { botId });
  const browserTabs = {
    tabs: [
      { target: "T1", title: "United", url: "https://united.example/", owner: "Tabs", purpose: "flights" },
      { target: "T2", title: "Booking", url: "https://booking.example/", owner: "Hotels", purpose: "hotels in Lisbon" },
      { target: "T3", title: "Reddit", url: "https://reddit.example/", owner: "Reviews" },
    ],
    front: "T2",
    pinned: null as string | null,
  };
  for (const pattern of ["**/rpc/computer/status", "**/rpc/threads/get"]) {
    await page.route(pattern, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const target = pattern.endsWith("status") ? body.json : body.json?.computer;
      if (target) target.browserTabs = browserTabs;
      await route.fulfill({ response, json: body });
    });
  }
  await page.route("**/rpc/computer/showBrowserTab", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ json: { ok: true } }) }),
  );
  await openComputer(page);
  const strip = page.getByRole("navigation", { name: "Tabs" });
  await expect(strip.getByRole("button", { name: /Hotels · hotels in Lisbon/ })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await captureScreenshot(page, testInfo, "computer-browser-tabs");
  // Listen before clicking, or the request can be missed.
  const pinned = page.waitForRequest("**/rpc/computer/showBrowserTab");
  await strip.getByRole("button", { name: /Reviews · Reddit/ }).click();
  expect((await pinned).postDataJSON()).toMatchObject({ json: { target: "T3" } });
});
```

Use the helpers' real signatures: `captureScreenshot`'s parameter order is whatever the file's first test uses. A pinned state arrives through the event stream in production; this test checks the click and the request only.

Run: `pnpm --filter @rakazo/web exec playwright test e2e/computer-workspace.spec.ts -g "browser tabs"`

Expected: PASS. This needs the local web stack the e2e suite starts; follow `apps/web/playwright.config.ts`. If the stack cannot start in this environment, leave the test for CI, and say so in the ledger and the PR.

- [ ] **Step 9: Type check and commit**

Run: `pnpm --filter @rakazo/web check && pnpm lint`

```bash
git add apps/web/src/components/computer apps/web/src/pages/Shell.tsx apps/web/src/lib/thread-events.ts \
  apps/web/src/lib/thread-events.test.ts apps/web/src/locales apps/web/e2e/computer-workspace.spec.ts
git commit -m "feat(web): show the bot's browser tabs above its screen and pin one"
```

Adjust the `apps/web/src/locales` path to wherever `intl:extract` wrote the catalogs.

---

### Task 13: Mobile — the tabs menu

A native menu, built with the `MenuView` primitive the repo already uses: `components/menu-picker.tsx` and `computer-maintenance-actions.tsx`. The front tab carries the system checkmark.

**Files:**
- Create: `apps/mobile/lib/computer-tabs.ts`
- Test: `apps/mobile/lib/computer-tabs.test.ts`
- Modify: `apps/mobile/app/computer.tsx`
- Modify: `apps/mobile/lib/locales/de.ts`, `ru.ts`, `zh.ts`

**Interfaces:**
- Consumes:
  - `ComputerStatus.browserTabs` and `browserTabLabel` (Task 5);
  - `computer/showBrowserTab` (Task 11).
- Produces:
  - `browserTabMenu(tabs: BrowserTabs | undefined, follow: string): Array<{ id: string; title: string; state: "on" | "off" }>`;
  - `browserTabChoice(id: string): string | null | undefined`. It returns a target, `null` for Follow, or `undefined` for anything else.

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/lib/computer-tabs.test.ts`:

```ts
import type { BrowserTabs } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { browserTabChoice, browserTabMenu } from "./computer-tabs";

const tabs: BrowserTabs = {
  tabs: [
    { target: "T1", title: "Flights", url: "https://f.test/", owner: "Ada" },
    { target: "T2", title: "Booking", url: "https://b.test/", owner: "Hotels", purpose: "hotels" },
  ],
  front: "T1",
  pinned: null,
};

describe("browser tab menu", () => {
  it("is empty until there is more than one tab", () => {
    expect(browserTabMenu(undefined, "Follow")).toEqual([]);
    expect(browserTabMenu({ ...tabs, tabs: [tabs.tabs[0]!] }, "Follow")).toEqual([]);
  });

  it("lists tabs with the shown one checked", () => {
    expect(browserTabMenu(tabs, "Follow")).toEqual([
      { id: "tab:T1", title: "Ada · Flights", state: "on" },
      { id: "tab:T2", title: "Hotels · hotels", state: "off" },
    ]);
  });

  it("adds Follow while pinned, and maps choices back", () => {
    const menu = browserTabMenu({ ...tabs, pinned: "T2" }, "Follow");
    expect(menu.map((item) => [item.title, item.state])).toEqual([
      ["Ada · Flights", "off"],
      ["Hotels · hotels", "on"],
      ["Follow", "off"],
    ]);
    expect(browserTabChoice("tab:T2")).toBe("T2");
    expect(browserTabChoice("follow")).toBeNull();
    expect(browserTabChoice("other")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @rakazo/mobile test -- computer-tabs`

Expected: FAIL, because the module does not exist.

- [ ] **Step 3: Implement**

Create `apps/mobile/lib/computer-tabs.ts`:

```ts
import type { BrowserTabs } from "@rakazo/contracts";
import { browserTabLabel } from "@rakazo/core";

const TAB = "tab:";
const FOLLOW = "follow";

/** The native tabs menu: one item per tab, the shown one checked, and Follow while pinned. */
export function browserTabMenu(
  tabs: BrowserTabs | undefined,
  follow: string,
): Array<{ id: string; title: string; state: "on" | "off" }> {
  if (!tabs || tabs.tabs.length < 2) return [];
  const shown = tabs.pinned ?? tabs.front;
  return [
    ...tabs.tabs.map((tab) => ({
      id: `${TAB}${tab.target}`,
      title: browserTabLabel(tab),
      state: tab.target === shown ? ("on" as const) : ("off" as const),
    })),
    ...(tabs.pinned ? [{ id: FOLLOW, title: follow, state: "off" as const }] : []),
  ];
}

/** A chosen menu item: the tab to pin, null to follow again, undefined for anything else. */
export function browserTabChoice(id: string): string | null | undefined {
  if (id === FOLLOW) return null;
  return id.startsWith(TAB) ? id.slice(TAB.length) : undefined;
}
```

In `apps/mobile/app/computer.tsx`:

1. **Imports.**
   - `MenuView` from `@expo/ui/community/menu`;
   - `browserTabChoice` and `browserTabMenu` from `../lib/computer-tabs`;
   - add `useResolvedAppearance` to the `../lib/native` import.

2. **Component body.** Add:

```ts
  const colorScheme = useResolvedAppearance();
  const tabMenu = browserTabMenu(computer?.browserTabs, t("Follow"));
  const showTab = (target: string | null) => {
    if (!botId) return;
    // A pin only changes what this viewer watches; a failed one leaves the view as it was.
    void rpc("computer/showBrowserTab", { botId, target })
      .then(() => refresh())
      .catch(() => undefined);
  };
```

3. **The viewer's top bar.** In the right-hand control group, right before the "Close computer" `GlassIconButton`, add:

```tsx
                  {tabMenu.length > 0 ? (
                    <MenuView
                      actions={tabMenu}
                      colorScheme={colorScheme}
                      onPressAction={({ nativeEvent }) => {
                        const choice = browserTabChoice(nativeEvent.event);
                        if (choice !== undefined) showTab(choice);
                      }}
                      title={t("Tabs")}
                    >
                      <GlassIconButton
                        accessibilityLabel={t("Tabs")}
                        onPress={() => undefined}
                        ios="square.on.square"
                        android="copy-outline"
                        size={36}
                        iconSize={16}
                      />
                    </MenuView>
                  ) : null}
```

   `MenuView` opens on press of its child, as it does in `computer-maintenance-actions.tsx`. If the child's own `onPress` swallows the press on a platform, use the plain view that file wraps instead, and record it in the ledger.

4. **Catalogs.** Add `"Tabs"` and `"Follow"` to `apps/mobile/lib/locales/de.ts`, `ru.ts` and `zh.ts`:

| String | de | ru | zh |
|---|---|---|---|
| Tabs | Tabs | Вкладки | 标签页 |
| Follow | Folgen | Следовать | 跟随 |

- [ ] **Step 4: Run the mobile tests and checks**

Run: `pnpm exec biome check --write apps/mobile/lib/computer-tabs.ts apps/mobile/lib/computer-tabs.test.ts apps/mobile/app/computer.tsx && pnpm --filter @rakazo/mobile test && pnpm --filter @rakazo/mobile check`

Expected: PASS. `i18n.test.ts` requires every `t()` key to exist in the catalogs, and the step above adds them.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/lib/computer-tabs.ts apps/mobile/lib/computer-tabs.test.ts apps/mobile/app/computer.tsx \
  apps/mobile/lib/locales/de.ts apps/mobile/lib/locales/ru.ts apps/mobile/lib/locales/zh.ts
git commit -m "feat(mobile): pick which browser tab the computer view shows"
```

---

### Task 14: Whole-branch verification and docs

**Files:**
- Modify: `docs/superpowers/specs/2026-10-14-browser-tabs-design.md` (status line and a "Corrections from implementation" note, if anything changed)
- Modify: this plan's execution ledger

- [ ] **Step 1: Run the full suite**

Run: `pnpm lint && pnpm check && pnpm test && python3 infra/sandboxes/computer/test_page_browser.py && pnpm --filter @rakazo/web intl:extract && git diff --exit-code apps/web/src/locales`

Expected:
- Lint and types are clean.
- Every test passes, except the five files that already fail identically on `main` in this environment: `pr-digest`, the supervisor `browser-profile`, `computer-idle`, `desktop-runtime` and `playwright-artifact-publication`.

Confirm that any failure also fails on `main` before calling it pre-existing. Do not run `pnpm --filter @rakazo/desktop test:e2e` (AGENTS.md).

- [ ] **Step 2: Manual check on a real Docker computer**

Build the computer image and start the local stack the way `docs/self-host.md` describes. Then, with a bot on the Docker computer:
1. **Two helpers at once.** Ask the bot something that makes it start two helpers browsing different sites at the same time. Expect two tabs in the strip, each labelled with its helper. Each helper's actions stay in its own tab, and the screen switches between them no faster than about every 1.5 s.
2. **Pin and follow.** Click a chip. The view stays on that tab while the helpers keep working. Click Follow, and following resumes.
3. **Hand-back and cleanup.** When the run finishes, the screen shows the tab the bot finished in, that tab stays, and the helpers' other tabs close. Repeat with **Stop** pressed mid-run: the tabs still close.
4. **Pin while the run is active.** Pin a tab from the strip while helpers are browsing. The strip keeps showing Follow, and the screen stays put. Then click Follow, and following resumes.
5. **Pause and resume.** Have the bot ask you something mid-browsing. Answer it, and confirm the bot keeps working in the same tabs by the same handles.
6. **Hidden tabs.** Repeat Task 1's probe against the computer's own Chromium: `docker exec` into the container and run the probe against its CDP port. Confirm the background tab renders with the chosen `OPEN_IN_NEW_WINDOW` value.
7. **How the agents behave, not just the code.** Read the run's tool calls in the thread for checks 1 and 3, and record in the ledger:
   - whether a single-site request opened any new tab (it should not);
   - whether a helper ever met a refusal, and whether its next call followed the refusal's advice;
   - whether the main agent passed `tab` or `newTab` where it needed to without being refused first.

   A refusal an agent repeats, or advice it ignores, is a wording problem: fix the message or description and note it in the ledger.

Record what was seen in the ledger, without hostnames, paths or account names.

- [ ] **Step 3: Update the spec's status**

Set the spec's status line to `Status: implemented on <date> (branch feat/browser-tabs)`. If any task's ledger row changed behavior the spec describes, add a short "Corrections from implementation" list at its top, in the page-decider spec's style.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-10-14-browser-tabs-design.md docs/superpowers/plans/2026-10-14-browser-tabs.md
git commit -m "docs: record what implementing browser tabs changed in its spec and plan"
```

- [ ] **Step 5: Hand off**

Use superpowers:finishing-a-development-branch. Any PR description must:
- quote the new copy ("Tabs", "Follow") and justify each one;
- name the one schema change (the `runs(botId, createdAt)` index) and its reason;
- state the offline degrade: on the fake and emulator computers, pinning does nothing;
- link the CI screenshot `computer-browser-tabs`;
- say that the mobile menu is native-only and not captured by CI.
