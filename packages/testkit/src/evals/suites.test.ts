import { describe, expect, it } from "vitest";
import { EVAL_SUITES, resolveControls, resolveSuite } from "./suites.js";

// Today's values for the offline suites, copied from cli/evals.ts before this change.
const OFFLINE_FIXTURES = "synthetic services, messaging and fake sandbox";
const OFFLINE_LIMITATIONS = [
  "Does not evaluate browser perception, native recording perception, or real external services.",
  "Silence cases observe routine chat, transient progress, and provider notification requests; native push delivery and UI pixels are outside the fixture.",
  "Deterministic fact checks are deliberately narrow; they do not grade overall writing quality.",
  "Cost uses provider-reported charges where available and explicit pricing estimates otherwise. Spend reservations are a guard, not a billing guarantee.",
  "Tool trace contains names and statuses only; raw requests and responses are omitted.",
];

describe("eval suites", () => {
  it("keeps the offline suites exactly as they were", () => {
    for (const name of ["product", "history", "silence"] as const) {
      const suite = EVAL_SUITES[name];
      expect(suite).not.toHaveProperty("computer");
      expect(suite.fixtures).toBe(OFFLINE_FIXTURES);
      expect(suite.limitations).toEqual(OFFLINE_LIMITATIONS);
      expect(resolveControls(suite, { trials: "3" })).toEqual({
        trials: 3,
        timeoutMs: 180_000,
        maxToolCalls: 30,
      });
    }
  });

  it("runs browsing on a real computer with more room per task", () => {
    const suite = resolveSuite("browsing");
    expect(suite.computer).toBe("docker");
    expect(suite.cases.map((c) => c.id)).toEqual([
      "browse-compare-cheapest",
      "browse-form-checkout",
      "browse-extract-csv",
      "browse-hard-page",
    ]);
    expect(resolveControls(suite, { trials: "1" })).toEqual({
      trials: 1,
      timeoutMs: 300_000,
      maxToolCalls: 60,
    });
  });

  it("lets explicit flags override a suite's controls", () => {
    expect(
      resolveControls(resolveSuite("browsing"), {
        trials: "2",
        timeoutMs: "1000",
        maxToolCalls: "5",
      }),
    ).toEqual({ trials: 2, timeoutMs: 1000, maxToolCalls: 5 });
  });

  it("names every suite when one is unknown", () => {
    expect(() => resolveSuite("nope")).toThrow(
      "Unknown suite; use product, history, silence, browsing",
    );
  });
});
