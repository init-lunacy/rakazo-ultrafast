import { z } from "zod";
import { readBodyCapped } from "./web-ssrf.js";

const SYSTEMONE_URL = "https://api.typesafe.ai/v1/systemone";
const MAX_RESPONSE_BYTES = 64_000;

/** Answer shapes from the published contract, discriminated on `type`. */
const answerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities: z.record(z.string(), z.number()).optional(),
    // Out of range is malformed: Auto Review must never pass on it.
    confidence: z.number().min(0).max(1).optional(),
  }),
  z.object({ type: z.literal("noul"), noul: z.number() }),
  z.object({
    type: z.literal("score"),
    score: z.number(),
    legend: z.record(z.string(), z.string()).optional(),
    confidence: z.number().optional(),
  }),
]);

const responseSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  answers: z.record(z.string(), answerSchema),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative().optional(),
      output_tokens: z.number().int().nonnegative().optional(),
      cost: z.number().nonnegative().optional(),
    })
    .optional(),
});

export type SystemOneUsage = z.infer<typeof responseSchema>["usage"];

export type SystemOneAnswers = z.infer<typeof responseSchema>["answers"];

/** A failure kind, not a message: each caller keeps its own wording. */
export type SystemOneResult =
  | { ok: true; answers: SystemOneAnswers; model?: string; id?: string; usage?: SystemOneUsage }
  | { ok: false; failure: "transport" | "invalid" }
  | { ok: false; failure: "status"; status: number };

export async function postSystemOne(options: {
  apiKey: string;
  model: string;
  /** Passed through untouched: the protocol accepts a string, object or array. */
  state: unknown;
  questions: Record<string, unknown>;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
}): Promise<SystemOneResult> {
  let response: Response;
  try {
    response = await options.fetchImpl(SYSTEMONE_URL, {
      method: "POST",
      redirect: "error",
      signal: options.signal,
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: options.model,
        state: options.state,
        questions: options.questions,
      }),
    });
  } catch {
    return { ok: false, failure: "transport" };
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    return { ok: false, failure: "status", status: response.status };
  }
  try {
    const bytes = await readBodyCapped(response, MAX_RESPONSE_BYTES, options.signal);
    const parsed = responseSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    if (!parsed.success) return { ok: false, failure: "invalid" };
    const { answers, model, id, usage } = parsed.data;
    return { ok: true, answers, model, id, usage };
  } catch {
    return { ok: false, failure: "invalid" };
  }
}

/** Every scored option, best first, falling back to the winner alone. */
export function systemOneRanking(
  answers: SystemOneAnswers,
  key: string,
): Array<{ option: string; confidence: number }> {
  const answer = answers[key];
  if (answer?.type !== "choice") return [];
  const entries = Object.entries(answer.probabilities ?? {});
  if (entries.length === 0) return [{ option: answer.choice, confidence: answer.confidence ?? 0 }];
  return entries
    .map(([option, confidence]) => ({ option, confidence }))
    .sort((a, b) => b.confidence - a.confidence);
}

export function systemOneNoul(answers: SystemOneAnswers, key: string): number {
  const answer = answers[key];
  return answer?.type === "noul" ? answer.noul : 0;
}
