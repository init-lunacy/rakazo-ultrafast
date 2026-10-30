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

  describe("usage", () => {
    type Usage = unknown;
    function withUsage(body: unknown, status = 200) {
      const usage: Usage[] = [];
      const decider = new SystemOnePageDecider({
        apiKey: "test-key",
        fetch: async () => new Response(JSON.stringify(body), { status }),
        onUsage: async (event) => {
          usage.push(event);
        },
      });
      return { metered: decider, usage };
    }

    it("records the tokens and cost TypeSafe reports for each decision", async () => {
      const { metered, usage } = withUsage({
        ...answers({ choice: "e2", confidence: 0.9 }),
        id: "req-1",
        usage: { input_tokens: 420, output_tokens: 6, cost: 0.0012 },
      });
      await metered.decide(computer, request, context);
      expect(usage).toEqual([
        expect.objectContaining({
          type: "usage",
          provider: "typesafe",
          model: "jev-latest",
          callId: expect.any(String),
          inputTokens: 420,
          outputTokens: 6,
          costUsd: 0.0012,
          costSource: "provider-reported",
          providerRequestId: "req-1",
          usageSource: "response",
          operationKind: "setup",
        }),
      ]);
    });

    it("records a call TypeSafe answered without usage as unknown, not free", async () => {
      const { metered, usage } = withUsage(answers({ choice: "e2", confidence: 0.9 }));
      await metered.decide(computer, request, context);
      expect(usage).toEqual([
        expect.objectContaining({ inputTokens: null, outputTokens: null, costUsd: null }),
      ]);
    });

    it("records a rejected request as costing nothing", async () => {
      const { metered, usage } = withUsage({ error: "bad request" }, 400);
      const decision = await metered.decide(computer, request, context);
      expect(decision.error).toBeDefined();
      expect(usage).toEqual([
        expect.objectContaining({ costUsd: 0, usageSource: "provider-rejected" }),
      ]);
    });

    it("records nothing when TypeSafe could not be reached", async () => {
      const usage: Usage[] = [];
      await new SystemOnePageDecider({
        apiKey: "test-key",
        fetch: async () => {
          throw new Error("offline");
        },
        onUsage: async (event) => {
          usage.push(event);
        },
      }).decide(computer, request, context);
      expect(usage).toEqual([]);
    });
  });
});
