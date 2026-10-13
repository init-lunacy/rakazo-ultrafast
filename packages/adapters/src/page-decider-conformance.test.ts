import type { AdapterContext, ComputerRef, PageDecider } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { FakePageDecider } from "./fake-page-decider.js";
import { ModelPageDecider } from "./model-page-decider.js";
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

  it("holds for systemone", async () => {
    await assertConformance(
      new SystemOnePageDecider({
        apiKey: "test-key",
        fetch: async () =>
          new Response(
            JSON.stringify({
              answers: {
                element: {
                  type: "choice",
                  choice: "e2",
                  confidence: 0.9,
                  probabilities: { e2: 0.9 },
                },
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
  it("reports a seeded error without throwing", async () => {
    const decision = await new FakePageDecider({ error: "seeded" }).decide(
      computer,
      request,
      context,
    );
    expect(decision).toMatchObject({ error: "seeded", candidates: [] });
  });
});
