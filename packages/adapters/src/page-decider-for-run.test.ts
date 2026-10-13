import type { AgentRuntime } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
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
