import type {
  AdapterContext,
  BrowserSnapshotNode,
  ComputerRef,
  PageDecider,
} from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
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

/** Clicks Continue once, then reports the goal met. Picks by name, so it
 * survives the ref renumbering every snapshot does. */
const continueOnce: PageDecider = {
  describe: () => new FakePageDecider().describe(),
  decide: async (_computer, request) => {
    if (request.history.length > 0) return { candidates: [], goalMet: 0.99, stuck: 0, blocked: 0 };
    const target = request.elements.find((element) => /continue/i.test(element.name))!;
    return {
      candidates: [{ ref: target.ref, kind: "click", confidence: 0.95 }],
      goalMet: 0,
      stuck: 0,
      blocked: 0,
    };
  },
};

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
    expect(result).toMatchObject({ outcome: "done", acted: ["Continue"], goalMetConfidence: 0.99 });
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
    expect(result).toMatchObject({ outcome: "escalate", acted: [] });
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
    // A claim for the bot's model to act on, not a takeover in progress.
    expect(result).toMatchObject({ outcome: "takeover", blockedConfidence: 0.95, acted: [] });
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
    const result = await runPageDecisionChain({
      browser,
      decider: vision,
      computer,
      context,
      goal: "go",
      snapshot,
    });
    expect(result.outcome).toBe("done");
    expect(vision.requests[0]?.screenshot).toBeUndefined();
  });

  // The decider reads text the page controls; landing on another origin is a
  // trust boundary, so the bot's own model takes over there.
  it("hands back when a click leaves the starting origin", async () => {
    const { browser, snapshot, button } = await onForm();
    const read = browser.snapshot.bind(browser);
    browser.snapshot = async (...args) => ({
      ...(await read(...args)),
      url: "https://elsewhere.test/",
    });
    const click = { candidates: [{ ref: button.ref, kind: "click" as const, confidence: 0.95 }] };
    const decider = new FakePageDecider({ decisions: [click, click] });
    const result = await runPageDecisionChain({
      browser,
      decider,
      computer,
      context,
      goal: "go",
      snapshot,
    });
    expect(result).toMatchObject({
      outcome: "escalate",
      reason: "left_origin",
      acted: ["Continue"],
    });
    expect(decider.requests).toHaveLength(1);
  });

  // The decider is another recipient of the page, so it gets no more than the
  // model does: no element values, and the run's secrets scrubbed.
  it("never shows the decider an element value or a run secret", async () => {
    const browser = new FakeBrowserProvider({
      pages: {
        "https://example.test/token": {
          title: "Token fake-run-secret",
          html: `<!doctype html><html><head><title>Token fake-run-secret</title></head><body>
            <input aria-label="Token" value="fake-typed-value" />
            <button>Copy fake-run-secret</button>
          </body></html>`,
        },
      },
    });
    await browser.navigate(computer, { url: "https://example.test/token" }, context);
    const snapshot = await browser.snapshot(computer, { extended: true }, context);
    const decider = new FakePageDecider({ decisions: [{ goalMet: 0.99 }] });
    await runPageDecisionChain({
      browser,
      decider,
      computer,
      context,
      goal: "copy it",
      snapshot,
      redactions: () => ["fake-run-secret"],
    });
    const sent = JSON.stringify(decider.requests[0]);
    expect(sent).toContain("Token");
    expect(sent).not.toContain("fake-typed-value");
    expect(sent).not.toContain("fake-run-secret");
  });

  // Cutting the excerpt first would leave a secret's first half unmatched.
  it("scrubs a secret that straddles the excerpt's cut", async () => {
    const { browser } = await onForm();
    const decider = new FakePageDecider({ decisions: [{ goalMet: 0.99 }] });
    await runPageDecisionChain({
      browser,
      decider,
      computer,
      context,
      goal: "read it",
      snapshot: {
        url: "https://example.test/form",
        title: "Signup",
        tree: `${"x".repeat(3_990)}fake-run-secret`,
        elements: [],
      },
      redactions: () => ["fake-run-secret"],
    });
    expect(decider.requests[0]?.excerpt).not.toContain("fake-");
  });

  // Refs are renumbered on every snapshot, so "did not change the page" has to
  // be judged, and remembered, by what the element is rather than by its ref.
  it("stops clicking an element that does nothing", async () => {
    const browser = new FakeBrowserProvider({
      pages: {
        "https://example.test/noop": {
          title: "Noop",
          html: `<!doctype html><html><head><title>Noop</title></head><body>
            <button>Noop</button>
          </body></html>`,
        },
      },
    });
    await browser.navigate(computer, { url: "https://example.test/noop" }, context);
    const snapshot = await browser.snapshot(computer, { extended: true }, context);
    const pickNoop: PageDecider = {
      describe: () => new FakePageDecider().describe(),
      decide: async (_computer, request) => {
        const target = request.elements.find((element) => element.name === "Noop")!;
        return {
          candidates: [{ ref: target.ref, kind: "click", confidence: 0.95 }],
          goalMet: 0,
          stuck: 0,
          blocked: 0,
        };
      },
    };
    const result = await runPageDecisionChain({
      browser,
      decider: pickNoop,
      computer,
      context,
      goal: "go",
      snapshot,
    });
    expect(result).toMatchObject({ outcome: "escalate", reason: "no_candidates", acted: ["Noop"] });
  });

  // An accessible name is page-controlled and can end in ` value=`.
  it("never shows the decider a value, whatever the element is named", async () => {
    const browser = new FakeBrowserProvider({
      pages: {
        "https://example.test/card": {
          title: "Card",
          html: `<!doctype html><html><head><title>Card</title></head><body>
            <input aria-label='Card value=' value="4111 1111 1111 1111" />
          </body></html>`,
        },
      },
    });
    await browser.navigate(computer, { url: "https://example.test/card" }, context);
    const snapshot = await browser.snapshot(computer, { extended: true }, context);
    const decider = new FakePageDecider({ decisions: [{ goalMet: 0.99 }] });
    await runPageDecisionChain({ browser, decider, computer, context, goal: "pay", snapshot });
    expect(JSON.stringify(decider.requests[0])).not.toContain("4111");
  });

  it("treats a decider that throws as an escalation", async () => {
    const { browser, snapshot } = await onForm();
    const throwing: PageDecider = {
      describe: () => new FakePageDecider().describe(),
      decide: async () => {
        throw new Error("decider crashed");
      },
    };
    const result = await runPageDecisionChain({
      browser,
      decider: throwing,
      computer,
      context,
      goal: "go",
      snapshot,
    });
    expect(result).toMatchObject({ outcome: "escalate", acted: [] });
  });
});

describe("decisionLogEvent", () => {
  it("records scores and origin, never page content", () => {
    const event = decisionLogEvent(
      {
        outcome: "done",
        acted: ["Continue"],
        snapshot: {
          url: "https://example.test/form?q=secret",
          title: "Signup",
          tree: "Email",
          elements: [],
        },
      },
      {
        candidates: [{ ref: "e2", kind: "click", confidence: 0.9 }],
        goalMet: 0.99,
        stuck: 0,
        blocked: 0,
      },
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
    for (const key of ["tree", "elements", "goalMet", "steps", "acted", "takeover"]) {
      expect(result).not.toHaveProperty(key);
    }
  });

  // The act's own tree is of the page before the chain clicked. The result must
  // carry the page it ended on, with refs that still resolve and no rects.
  it("returns the page the chain ended on, with live refs", async () => {
    const { browser, button } = await onForm();
    const result = (await browserActFromTool(
      browser,
      computer,
      context,
      { actions: [{ kind: "click", ref: button.ref }], goal: "press continue" },
      { decider: continueOnce },
    )) as { acted: string[]; elements: BrowserSnapshotNode[] };

    expect(result.acted).toEqual(["Continue"]);
    expect(result.elements.some((element) => element.rect)).toBe(false);
    const again = await browser.act(
      computer,
      { actions: [{ kind: "click", ref: result.elements[0]!.ref }] },
      context,
    );
    expect(again.ok).toBe(true);
  });

  // A failed or uncertain act may have half-happened; acting on top of it
  // would compound the damage the "never replay" rule exists to prevent.
  it("runs no chain after an act that failed or may have half-happened", async () => {
    const { browser, button } = await onForm();
    browser.act = async () => ({ ok: false, completed: 0, uncertain: true, url: "", title: "" });
    const decider = new FakePageDecider({ decisions: [{ goalMet: 0.99 }] });
    const result = await browserActFromTool(
      browser,
      computer,
      context,
      { actions: [{ kind: "click", ref: button.ref }], goal: "press continue" },
      { decider },
    );
    expect(decider.requests).toHaveLength(0);
    expect(result).not.toHaveProperty("goalMetConfidence");
  });

  // Nothing in the chain throws: a page it cannot read leaves the navigate as it was.
  it("keeps a successful navigate when the chain cannot read the page", async () => {
    const browser = new FakeBrowserProvider({ pages });
    browser.snapshotError = new Error("snapshot crashed");
    const decider = new FakePageDecider({ decisions: [{ goalMet: 0.99 }] });
    const url = { url: "https://example.test/form" };
    expect(
      await browserNavigateFromTool(
        browser,
        computer,
        context,
        { ...url, goal: "go" },
        { decider },
      ),
    ).toEqual(await browserNavigateFromTool(browser, computer, context, url));
  });

  // After a click the act's own tree describes a page the chain left. When the
  // fresh view cannot be read, no tree is better than the wrong one.
  it("drops the stale tree when the page it ended on cannot be read", async () => {
    const { browser, button } = await onForm();
    const read = browser.snapshot.bind(browser);
    browser.snapshot = async (target, request, ctx) =>
      request.extended
        ? read(target, request, ctx)
        : { url: "", title: "", tree: "", elements: [], fallback: "computer_act", error: "gone" };
    const result = await browserActFromTool(
      browser,
      computer,
      context,
      { actions: [{ kind: "click", ref: button.ref }], goal: "press continue" },
      { decider: continueOnce },
    );
    expect(result).toMatchObject({ acted: ["Continue"] });
    expect(result).not.toHaveProperty("tree");
    expect(result).not.toHaveProperty("elements");
  });

  it("scrubs the run's secrets from what browser_navigate shows the decider", async () => {
    const decider = new FakePageDecider({ decisions: [{ goalMet: 0.99 }] });
    await browserNavigateFromTool(
      new FakeBrowserProvider({ pages }),
      computer,
      context,
      { url: "https://example.test/form", goal: "sign up" },
      { decider, redactions: () => ["Signup"] },
    );
    expect(JSON.stringify(decider.requests[0])).not.toContain("Signup");
  });

  // Reading the page for the decider renumbers every ref, so even a chain that
  // clicked nothing must hand back refs that still resolve.
  it("returns live refs when the chain clicked nothing", async () => {
    const { browser, button } = await onForm();
    const result = (await browserActFromTool(
      browser,
      computer,
      context,
      { actions: [{ kind: "click", ref: button.ref }], goal: "press continue" },
      { decider: new FakePageDecider({ decisions: [{ candidates: [] }] }) },
    )) as { elements: BrowserSnapshotNode[] };
    const again = await browser.act(
      computer,
      { actions: [{ kind: "click", ref: result.elements[0]!.ref }] },
      context,
    );
    expect(again.ok).toBe(true);
  });

  // A click whose result was lost may have happened; the model must not replay it.
  it("warns against replaying a chain click that may have happened", async () => {
    const { browser, button } = await onForm();
    const act = browser.act.bind(browser);
    let calls = 0;
    browser.act = async (...args) => {
      const result = await act(...args);
      return calls++ === 0 ? result : { ...result, uncertain: true };
    };
    const result = await browserActFromTool(
      browser,
      computer,
      context,
      { actions: [{ kind: "click", ref: button.ref }], goal: "press continue" },
      { decider: continueOnce },
    );
    expect(result).toMatchObject({ uncertain: true, note: expect.stringMatching(/replay/i) });
  });

  it("still redacts when a chain runs", async () => {
    const { browser, button } = await onForm();
    const result = await browserActFromTool(
      browser,
      computer,
      context,
      { actions: [{ kind: "click", ref: button.ref }], goal: "press continue" },
      {
        decider: new FakePageDecider({ decisions: [{ goalMet: 0.99 }] }),
        redactions: () => ["Signup"],
      },
    );
    expect(JSON.stringify(result)).not.toContain("Signup");
  });

  // A successful browser mutation clears the desktop visual-loop streak, and
  // that reset reads `error`, `fallback` and `ok`. A chain must not disturb them.
  it("keeps the desktop loop guard's reset on success and failure", async () => {
    const { browser, button } = await onForm();
    const decider = () =>
      new FakePageDecider({
        decisions: [
          { candidates: [{ ref: button.ref, kind: "click", confidence: 0.95 }] },
          { goalMet: 0.99 },
        ],
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
