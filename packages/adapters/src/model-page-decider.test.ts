import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  ComputerRef,
} from "@rakazo/adapter-kit";
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
    expect(decision.candidates).toEqual([
      { ref: "e2", kind: "click", confidence: 0.9, source: "list" },
    ]);
  });

  it("tolerates a fenced JSON answer", async () => {
    const decision = await decider(
      `\`\`\`json\n${JSON.stringify({ ...empty, goalMet: 0.9 })}\n\`\`\``,
    ).decide(computer, request, context);
    expect(decision.goalMet).toBe(0.9);
  });

  // The point is in image pixels; scale 2 means it divides down to CSS pixels.
  it("maps a point through the capture's scale onto a ref", async () => {
    const decision = await decider({
      ...empty,
      point: { x: 120, y: 320, kind: "click", confidence: 0.8 },
    }).decide(computer, request, context);
    expect(decision.candidates).toEqual([
      { ref: "e2", kind: "click", confidence: 0.8, source: "point" },
    ]);
  });

  it("never lets a point override a named element", async () => {
    const decision = await decider({
      ...empty,
      candidates: [{ ref: "e3", kind: "fill", confidence: 0.9 }],
      point: { x: 120, y: 320, kind: "click", confidence: 0.99 },
    }).decide(computer, request, context);
    expect(decision.candidates).toEqual([
      { ref: "e3", kind: "fill", confidence: 0.9, source: "list" },
    ]);
  });

  it("sends the capture only to a model that can see", async () => {
    const seen: AgentRunRequest[] = [];
    await decider(empty, true, seen).decide(computer, request, context);
    await decider(empty, false, seen).decide(computer, request, context);
    expect(seen[0]?.currentTurnImages).toHaveLength(1);
    expect(seen[1]?.currentTurnImages).toBeUndefined();
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
        // Fails mid-stream, as a provider error does.
        async *run() {
          yield { type: "text", text: "" };
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
    const lone = [
      { ref: "e3", role: "textbox", name: "Email", rect: { x: 20, y: 60, width: 200, height: 24 } },
    ];
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
