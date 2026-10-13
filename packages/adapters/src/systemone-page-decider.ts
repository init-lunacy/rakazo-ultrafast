import type {
  AdapterContext,
  AdapterDescriptor,
  BrowserActKind,
  BrowserSnapshotNode,
  ComputerRef,
  PageDecider,
  PageDeciderCapabilities,
  PageDecision,
  PageDecisionRequest,
} from "@rakazo/adapter-kit";
import { PAGE_DECISION_MAX_ELEMENTS, PAGE_DECISION_MAX_EXCERPT_CHARS } from "@rakazo/adapter-kit";
import { DEFAULT_JEV_MODEL } from "./auto-review.js";
import { postSystemOne, systemOneNoul, systemOneRanking } from "./systemone-client.js";

const MAX_LABEL_CHARS = 120;

const EMPTY: PageDecision = { candidates: [], goalMet: 0, stuck: 0, blocked: 0 };

/**
 * The one description of an element that leaves the process. `value` is never
 * part of it — it can hold a typed secret and the decider has no use for it.
 */
function labelFor(element: BrowserSnapshotNode): string {
  const tag = element.tag ? ` <${element.tag}>` : "";
  return `${element.role}${tag}: ${element.name}`.slice(0, MAX_LABEL_CHARS);
}

/** Jev names an element; what to do with it follows from what it is. */
function kindFor(element: BrowserSnapshotNode): BrowserActKind {
  const role = element.role.toLowerCase();
  return role === "textbox" || role === "searchbox" || element.tag === "textarea"
    ? "fill"
    : "click";
}

/** Hosted Jev: one parallel pass answering which element, done, stuck, blocked. */
export class SystemOnePageDecider implements PageDecider {
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly options: {
      apiKey: string;
      model?: string;
      timeoutMs?: number;
      fetch?: typeof fetch;
    },
  ) {
    this.model = options.model?.trim() || DEFAULT_JEV_MODEL;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  describe(): AdapterDescriptor<PageDeciderCapabilities> {
    return {
      id: "systemone",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { vision: false },
    };
  }

  async decide(
    _computer: ComputerRef,
    request: PageDecisionRequest,
    context: AdapterContext,
  ): Promise<PageDecision> {
    const caller = request.signal ?? context.signal;
    if (caller.aborted) return { ...EMPTY, error: "cancelled" };
    const elements = request.elements.slice(0, PAGE_DECISION_MAX_ELEMENTS);

    const result = await postSystemOne({
      apiKey: this.options.apiKey,
      model: this.model,
      signal: AbortSignal.any([caller, AbortSignal.timeout(this.timeoutMs)]),
      fetchImpl: this.fetchImpl,
      // The criteria already name every element, so the state does not repeat
      // them — sending both would double the payload on the hot path.
      state: {
        goal: request.goal,
        origin: new URL(request.url).origin,
        title: request.title,
        excerpt: request.excerpt.slice(0, PAGE_DECISION_MAX_EXCERPT_CHARS),
        history: request.history,
      },
      questions: {
        element: {
          type: "choice",
          instructions: "Which element should be acted on next to advance the goal?",
          criteria: Object.fromEntries(elements.map((element) => [element.ref, labelFor(element)])),
        },
        goalMet: { type: "noul", instructions: "Is the goal already satisfied on this page?" },
        stuck: { type: "noul", instructions: "Is there no listed element that can make progress?" },
        blocked: {
          type: "noul",
          instructions:
            "Is this page an interstitial needing a human, such as a bot check, two-factor prompt or payment confirmation?",
        },
      },
    });
    if (!result.ok) return { ...EMPTY, error: "The page decider did not answer." };

    const byRef = new Map(elements.map((element) => [element.ref, element]));
    return {
      candidates: systemOneRanking(result.answers, "element").flatMap(({ option, confidence }) => {
        const element = byRef.get(option);
        return element
          ? [{ ref: element.ref, kind: kindFor(element), confidence, source: "list" as const }]
          : [];
      }),
      goalMet: systemOneNoul(result.answers, "goalMet"),
      stuck: systemOneNoul(result.answers, "stuck"),
      blocked: systemOneNoul(result.answers, "blocked"),
    };
  }
}
