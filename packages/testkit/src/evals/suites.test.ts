import { describe, expect, it } from "vitest";
import { BROWSING_EVAL_CASES } from "./browsing/cases.js";
import { browsingComputerFixture } from "./browsing/install.js";
import { EVAL_SUITES, resolveControls, resolveSuite } from "./suites.js";

describe("eval suites", () => {
  it("runs the offline suites in the fake sandbox with their usual limits", () => {
    for (const name of ["product", "history", "silence"] as const) {
      const suite = EVAL_SUITES[name];
      expect(suite).not.toHaveProperty("computerFixture");
      expect(resolveControls(suite, { trials: "3" })).toEqual({
        trials: 3,
        timeoutMs: 180_000,
        maxToolCalls: 30,
      });
    }
  });

  it("runs browsing on a real computer with its sites and more room per task", async () => {
    const suite = resolveSuite("browsing");
    expect(suite.cases).toBe(BROWSING_EVAL_CASES);
    expect(await suite.computerFixture?.()).toBe(browsingComputerFixture);
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
