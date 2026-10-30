import type { AgentRuntime, ComputerRef } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pageDeciderForRun } from "./page-decider-for-run.js";

const runtime = {} as AgentRuntime;
const run = { runId: "r1", botId: "b1", threadId: "t1" };
const resolveModel = async (provider: string, id: string) => ({ provider, id });

describe("pageDeciderForRun", () => {
  it("is off when the bot has no decider", async () => {
    expect(
      await pageDeciderForRun({ provider: null, modelId: null, resolveModel, runtime, run }),
    ).toBeUndefined();
  });

  it("builds the systemone decider for jev", async () => {
    const decider = await pageDeciderForRun({
      provider: "jev",
      modelId: "jev-latest",
      typesafeKey: "k",
      resolveModel,
      runtime,
      run,
    });
    expect(decider?.describe().id).toBe("systemone");
  });

  describe("jev usage", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("records each jev decision through the run's usage hook", async () => {
      vi.stubGlobal("fetch", async () =>
        Response.json({
          answers: { element: { type: "choice", choice: "e1", confidence: 1 } },
          usage: { input_tokens: 10, output_tokens: 1, cost: 0.001 },
        }),
      );
      const usage: unknown[] = [];
      const decider = await pageDeciderForRun({
        provider: "jev",
        modelId: "jev-latest",
        typesafeKey: "k",
        resolveModel,
        runtime,
        run,
        onUsage: async (event) => {
          usage.push(event);
        },
      });
      await decider?.decide(
        { id: "c1", botId: "b1", kind: "fake", providerRef: "c1" } satisfies ComputerRef,
        {
          goal: "Continue",
          elements: [{ ref: "e1", role: "button", name: "Continue" }],
          excerpt: "",
          url: "https://example.test/",
          title: "",
          history: [],
        },
        {
          operationId: "1",
          traceId: "1",
          spaceId: "w",
          userId: "u",
          signal: new AbortController().signal,
        },
      );
      expect(usage).toEqual([expect.objectContaining({ provider: "typesafe", costUsd: 0.001 })]);
    });
  });

  it("is off for jev when the deployment has no key", async () => {
    expect(
      await pageDeciderForRun({
        provider: "jev",
        modelId: "jev-latest",
        resolveModel,
        runtime,
        run,
      }),
    ).toBeUndefined();
  });

  it("builds a model decider through the run's resolver", async () => {
    const decider = await pageDeciderForRun({
      provider: "local",
      modelId: "Hcompany/Holo1.5-7B",
      resolveModel,
      runtime,
      run,
    });
    expect(decider?.describe().id).toBe("model");
  });

  it("gives a model the capture only when it accepts images", async () => {
    const seeing = await pageDeciderForRun({
      provider: "openai-compatible",
      modelId: "vision-model",
      resolveModel: async (provider, id) => ({ provider, id, acceptsImages: true }),
      runtime,
      run,
    });
    expect(seeing?.describe().capabilities.vision).toBe(true);
  });

  // An accelerator: a decider whose model went away must not fail the run.
  it("is off when the model can no longer be resolved", async () => {
    expect(
      await pageDeciderForRun({
        provider: "local",
        modelId: "gone",
        resolveModel: async () => {
          throw new Error("Connect that model provider first");
        },
        runtime,
        run,
      }),
    ).toBeUndefined();
  });
});
