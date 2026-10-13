import type {
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  PageDecider,
} from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import { JEV_AUTO_REVIEW_PROVIDER } from "./auto-review.js";
import { ModelPageDecider } from "./model-page-decider.js";
import { modelAcceptsImageInput } from "./model-vision.js";
import { SystemOnePageDecider } from "./systemone-page-decider.js";

/**
 * The bot's decider for one run, or undefined to behave exactly as before.
 * Never throws: a decider that cannot be built is an accelerator lost, not a
 * run failed.
 */
export async function pageDeciderForRun(input: {
  provider: string | null;
  modelId: string | null;
  /** The run's own resolver, as used for backup and helper models. */
  resolveModel: (provider: string, modelId: string) => Promise<AgentRunRequest["model"]>;
  runtime: AgentRuntime;
  run: { runId: string; botId: string; threadId: string };
  typesafeKey?: string;
  onUsage?: (event: Extract<AgentRuntimeEvent, { type: "usage" }>) => Promise<unknown>;
}): Promise<PageDecider | undefined> {
  const { provider, modelId } = input;
  if (!provider || !modelId) return undefined;

  if (provider === JEV_AUTO_REVIEW_PROVIDER) {
    if (input.typesafeKey)
      return new SystemOnePageDecider({ apiKey: input.typesafeKey, model: modelId });
    // The picker only offers Jev when the API has a key, so this worker lacks one.
    getLogger().warn("page decider unavailable for this run", {
      event: "page_decider.unavailable",
      provider,
      reason: "TYPESAFE_API_KEY is not set for the worker",
    });
    return undefined;
  }

  try {
    const model = await input.resolveModel(provider, modelId);
    return new ModelPageDecider({
      runtime: input.runtime,
      model,
      sees: modelAcceptsImageInput(model.provider, model.id, model.acceptsImages),
      run: input.run,
      onUsage: input.onUsage,
    });
  } catch (error) {
    // The repo logger takes the message first, then bindings.
    getLogger().warn("page decider unavailable for this run", {
      event: "page_decider.unavailable",
      provider,
      reason: (error as Error).message,
    });
    return undefined;
  }
}
