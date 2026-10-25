import type {
  AdapterContext,
  AdapterDescriptor,
  AutoReviewCapabilities,
  AutoReviewProvider,
  AutoReviewRequest,
  AutoReviewResult,
} from "@rakazo/adapter-kit";
import {
  autoReviewMinConfidence,
  autoReviewTimeoutMs,
  DEFAULT_JEV_MODEL,
  MAX_OWNER_WORDS_CHARS,
  sanitizeAutoReviewReason,
} from "./auto-review.js";
import { postSystemOne } from "./systemone-client.js";

const MAX_TASK_CHARS = 400;
const MAX_BOT_CHARS = 240;
const MAX_ARGS_CHARS = 1_200;

export interface JevAutoReviewOptions {
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  model?: string;
  minConfidence?: number;
}

function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function boundArgs(args: Record<string, unknown>): Record<string, unknown> {
  try {
    const serialized = JSON.stringify(args);
    if (serialized !== undefined && serialized.length <= MAX_ARGS_CHARS) return args;
    return { _truncated: truncate(serialized ?? "", MAX_ARGS_CHARS) };
  } catch {
    return { _unserializable: true };
  }
}

function errorResult(model: string, reason: string): AutoReviewResult {
  return {
    decision: "error",
    reason: sanitizeAutoReviewReason(reason),
    model,
  };
}

/** TypeSafe Jev over HTTP. No SDK. Failures map to the existing Auto Review error decision. */
export class JevAutoReviewProvider implements AutoReviewProvider {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly model: string;
  private readonly minConfidence: number;

  constructor(options: JevAutoReviewOptions) {
    this.apiKey = options.apiKey.trim();
    if (!this.apiKey) throw new Error("TYPESAFE_API_KEY is required");
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? autoReviewTimeoutMs();
    this.model = options.model?.trim() || DEFAULT_JEV_MODEL;
    this.minConfidence = options.minConfidence ?? autoReviewMinConfidence();
  }

  describe(): AdapterDescriptor<AutoReviewCapabilities> {
    return {
      id: "jev",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { offline: false, keyless: false },
    };
  }

  async review(request: AutoReviewRequest, context: AdapterContext): Promise<AutoReviewResult> {
    const modelLabel = `jev/${this.model}`;
    const boundedSignal = AbortSignal.any([context.signal, AbortSignal.timeout(this.timeoutMs)]);
    const result = await postSystemOne({
      apiKey: this.apiKey,
      model: this.model,
      signal: boundedSignal,
      fetchImpl: this.fetchImpl,
      state: {
        toolName: request.toolName,
        connectorKind: request.connectorKind,
        // A new site is judged on the whole URL, since any part of it can carry data out.
        args: request.newSite ? request.args : boundArgs(request.args),
        userTask: truncate(
          request.userTask,
          request.newSite ? MAX_OWNER_WORDS_CHARS : MAX_TASK_CHARS,
        ),
        botDescription: truncate(request.botDescription, MAX_BOT_CHARS),
        matchingRules: request.matchingRules.map((rule) => ({
          effect: rule.effect,
          matchKind: rule.matchKind,
          matchValue: rule.matchValue,
        })),
        ...(request.newSite ? { newSite: true } : {}),
      },
      questions: {
        decision: {
          type: "choice",
          instructions: "Should this bot tool call auto-pass or ask the user to approve?",
          criteria: request.newSite
            ? {
                pass: "The owner's words or the bot's role clearly call for this site, and the URL carries nothing beyond what that needs",
                ask: "The site does not fit, or the URL's path or query holds data that looks taken from private context. Ask the user",
              }
            : {
                pass: "Clearly fits the user task and looks low risk",
                ask: "Unexpected, high risk, or outside the task. Ask the user",
              },
        },
      },
    });
    if (!result.ok) {
      if (result.failure === "status") {
        return errorResult(modelLabel, reasonForStatus(result.status));
      }
      return errorResult(
        modelLabel,
        result.failure === "transport"
          ? "Checker timed out or failed."
          : "Checker returned no decision.",
      );
    }
    const answer = result.answers.decision;
    if (answer?.type !== "choice") return errorResult(modelLabel, "Checker returned no decision.");
    const model = result.model ? `jev/${result.model}` : modelLabel;
    if (answer.choice === "ask") {
      return { decision: "ask", model };
    }
    if (answer.choice === "pass") {
      if (typeof answer.confidence !== "number" || answer.confidence < this.minConfidence) {
        return {
          decision: "ask",
          reason: sanitizeAutoReviewReason("Checker is unsure."),
          model,
        };
      }
      return { decision: "pass", model };
    }
    return errorResult(model, "Checker returned no decision.");
  }
}

function reasonForStatus(status: number): string {
  if (status === 401 || status === 403) return "Checker could not authenticate.";
  if (status === 422) return "Checker request was invalid.";
  if (status === 429 || status === 529) return "Checker is busy.";
  return "Checker timed out or failed.";
}
