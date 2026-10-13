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
    { ref: "e1", role: "textbox", name: "Email", tag: "input" },
    { ref: "e2", role: "button", name: "Continue", tag: "button" },
  ],
  excerpt: "Signup",
  url: "https://example.test/form",
  title: "Signup",
  history: [],
};

const answers = (element: Record<string, unknown>) => ({
  model: "jev-latest",
  answers: {
    element: { type: "choice", ...element },
    goalMet: { type: "noul", noul: 0.05 },
    stuck: { type: "noul", noul: 0.02 },
    blocked: { type: "noul", noul: 0.01 },
  },
});

function decider(body: unknown, status = 200, capture?: (body: string) => void) {
  return new SystemOnePageDecider({
    apiKey: "test-key",
    fetch: async (_url, init) => {
      capture?.(String(init?.body ?? ""));
      return new Response(JSON.stringify(body), { status });
    },
  });
}

describe("SystemOnePageDecider", () => {
  // The whole ranking, not just the winner: the policy falls through to the
  // next candidate when the top one already failed to change the page.
  it("returns every option ranked by probability", async () => {
    const decision = await decider(
      answers({ choice: "e2", confidence: 0.7, probabilities: { e1: 0.3, e2: 0.7 } }),
    ).decide(computer, request, context);
    expect(decision.candidates).toEqual([
      { ref: "e2", kind: "click", confidence: 0.7, source: "list" },
      { ref: "e1", kind: "fill", confidence: 0.3, source: "list" },
    ]);
    expect(decision.goalMet).toBe(0.05);
  });

  it("drops an option naming an element it was not given", async () => {
    const decision = await decider(
      answers({ choice: "e9", confidence: 0.99, probabilities: { e9: 0.99 } }),
    ).decide(computer, request, context);
    expect(decision.candidates).toEqual([]);
  });

  it("reports an error on a non-OK status", async () => {
    const decision = await decider({}, 401).decide(computer, request, context);
    expect(decision.error).toBeTruthy();
    expect(decision.candidates).toEqual([]);
  });

  // Review Focus 4: a hung endpoint becomes an escalation, not a stuck run.
  it("reports an error when the request times out", async () => {
    const hung = new SystemOnePageDecider({
      apiKey: "test-key",
      timeoutMs: 5,
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    expect((await hung.decide(computer, request, context)).error).toBeTruthy();
  });

  it("never sends an element value", async () => {
    let sent = "";
    await decider(answers({ choice: "e1" }), 200, (body) => {
      sent = body;
    }).decide(
      computer,
      {
        ...request,
        elements: [{ ref: "e1", role: "textbox", name: "Password", value: "hunter2" }],
      },
      context,
    );
    expect(sent).not.toContain("hunter2");
  });
});
