import type {
  AdapterContext,
  AdapterDescriptor,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  BrowserSnapshotNode,
  ComputerRef,
  PageDecider,
  PageDeciderCapabilities,
  PageDecision,
  PageDecisionCandidate,
  PageDecisionRequest,
} from "@rakazo/adapter-kit";
import { PAGE_DECISION_MAX_ELEMENTS, PAGE_DECISION_MAX_EXCERPT_CHARS } from "@rakazo/adapter-kit";
import { z } from "zod";

const POINT_TOLERANCE_PX = 12;
const EMPTY: PageDecision = { candidates: [], goalMet: 0, stuck: 0, blocked: 0 };

const kind = z.enum(["click", "fill", "type"]);
const answerSchema = z.object({
  candidates: z.array(z.object({ ref: z.string(), kind, confidence: z.number() })).default([]),
  point: z.object({ x: z.number(), y: z.number(), kind, confidence: z.number() }).optional(),
  goalMet: z.number().default(0),
  stuck: z.number().default(0),
  blocked: z.number().default(0),
});

const INSTRUCTIONS = [
  "You choose the next action on a web page from a numbered list of elements.",
  "Output strict JSON only, no markdown: {candidates:[{ref,kind,confidence}],goalMet,stuck,blocked}.",
  "kind is click, fill or type. Never invent a ref and never write text to type.",
  "goalMet: probability the goal is already satisfied. stuck: probability no element can progress.",
  "blocked: probability this is an interstitial needing a human, such as a bot check,",
  "two-factor prompt or payment confirmation.",
].join(" ");

const POINT_INSTRUCTION =
  "If no listed element fits, you may instead set point:{x,y,kind,confidence} to the screenshot pixel you would click.";

/**
 * The smallest element containing the point, else the nearest within a few
 * pixels. Smallest first because elements nest: a point inside a button inside
 * a card means the button.
 */
export function elementAtPoint(
  elements: readonly BrowserSnapshotNode[],
  x: number,
  y: number,
): BrowserSnapshotNode | undefined {
  let best: { element: BrowserSnapshotNode; area: number; distance: number } | undefined;
  for (const element of elements) {
    const r = element.rect;
    if (!r) continue;
    const dx = Math.max(r.x - x, 0, x - (r.x + r.width));
    const dy = Math.max(r.y - y, 0, y - (r.y + r.height));
    const distance = Math.hypot(dx, dy);
    if (distance > POINT_TOLERANCE_PX) continue;
    const area = r.width * r.height;
    const better =
      !best || distance < best.distance || (distance === best.distance && area < best.area);
    if (better) best = { element, area, distance };
  }
  return best?.element;
}

/**
 * Any connected model, run like Auto Review's checker: no tools, no history,
 * JSON only. Coordinates never leave this class — a point is mapped to a ref
 * before the policy sees it.
 */
export class ModelPageDecider implements PageDecider {
  constructor(
    private readonly options: {
      runtime: AgentRuntime;
      model: AgentRunRequest["model"];
      /** Whether the model accepts images; decides if it gets the capture. */
      sees: boolean;
      run: { runId: string; botId: string; threadId: string };
      onUsage?: (event: Extract<AgentRuntimeEvent, { type: "usage" }>) => Promise<unknown>;
      timeoutMs?: number;
    },
  ) {}

  describe(): AdapterDescriptor<PageDeciderCapabilities> {
    return {
      id: "model",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { vision: this.options.sees },
    };
  }

  async decide(
    _computer: ComputerRef,
    request: PageDecisionRequest,
    context: AdapterContext,
  ): Promise<PageDecision> {
    const caller = request.signal ?? context.signal;
    if (caller.aborted) return { ...EMPTY, error: "cancelled" };
    const signal = AbortSignal.any([caller, AbortSignal.timeout(this.options.timeoutMs ?? 20_000)]);
    const elements = request.elements.slice(0, PAGE_DECISION_MAX_ELEMENTS);
    const capture = this.options.sees ? request.screenshot : undefined;
    const { runId, botId, threadId } = this.options.run;

    let text = "";
    try {
      for await (const event of this.options.runtime.run(
        {
          botId,
          threadId,
          runId: `${runId}:page-decider`,
          usageOperationKind: "setup",
          onUsage: async (usage) => {
            await this.options.onUsage?.(usage);
          },
          // Rects and values stay here: the model needs neither, and a value can
          // hold a typed secret.
          prompt: JSON.stringify({
            goal: request.goal,
            origin: new URL(request.url).origin,
            title: request.title,
            excerpt: request.excerpt.slice(0, PAGE_DECISION_MAX_EXCERPT_CHARS),
            elements: elements.map(({ ref, role, name, tag }) => ({ ref, role, name, tag })),
            history: request.history,
          }),
          instructions: capture ? `${INSTRUCTIONS} ${POINT_INSTRUCTION}` : INSTRUCTIONS,
          currentTurnImages: capture
            ? [
                {
                  name: "page.png",
                  mimeType: "image/png",
                  data: Buffer.from(capture.data, "base64"),
                },
              ]
            : undefined,
          history: [],
          tools: [],
          model: this.options.model,
        },
        { ...context, operationId: `page-decider:${runId}`, signal },
      )) {
        if (event.type === "usage" && !event.accounted) await this.options.onUsage?.(event);
        // A runtime failure arrives as prose ("I hit a problem: …"), which is
        // never valid JSON, so the parse below rejects it without a text match.
        if (event.type === "done" && event.text) text = event.text.trim();
      }
    } catch {
      return { ...EMPTY, error: "The page decider did not answer." };
    }

    let parsed: z.infer<typeof answerSchema>;
    try {
      const json = text.replace(/^```(?:json)?\s*|\s*```$/g, "");
      const result = answerSchema.safeParse(JSON.parse(json));
      if (!result.success) throw new Error("invalid");
      parsed = result.data;
    } catch {
      return { ...EMPTY, error: "The page decider returned no decision." };
    }

    const offered = new Set(elements.map((element) => element.ref));
    const candidates: PageDecisionCandidate[] = parsed.candidates
      .filter((candidate) => offered.has(candidate.ref))
      .map((candidate) => ({ ...candidate, source: "list" as const }));

    // A point only counts when the list gave nothing and the model saw the
    // page; it maps through the capture's scale onto a ref, or yields nothing.
    if (candidates.length === 0 && parsed.point && capture) {
      const hit = elementAtPoint(
        elements,
        parsed.point.x / capture.scale,
        parsed.point.y / capture.scale,
      );
      if (hit) {
        candidates.push({
          ref: hit.ref,
          kind: parsed.point.kind,
          confidence: parsed.point.confidence,
          source: "point",
        });
      }
    }

    return {
      candidates,
      goalMet: parsed.goalMet,
      stuck: parsed.stuck,
      blocked: parsed.blocked,
    };
  }
}
