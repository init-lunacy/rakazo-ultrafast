import type {
  AdapterContext,
  AdapterDescriptor,
  ComputerRef,
  PageDecider,
  PageDeciderCapabilities,
  PageDecision,
  PageDecisionRequest,
} from "@rakazo/adapter-kit";

export interface FakePageDeciderOptions {
  /** Returned in order; the last repeats once drained. */
  decisions?: ReadonlyArray<Partial<PageDecision>>;
  /** Reported on every call, with no candidates. */
  error?: string;
  /** Declare that this decider wants a screenshot. */
  vision?: boolean;
}

const EMPTY: PageDecision = { candidates: [], goalMet: 0, stuck: 0, blocked: 0 };

/** Replays seeded decisions so the policy and chain test offline. */
export class FakePageDecider implements PageDecider {
  readonly requests: PageDecisionRequest[] = [];
  private cursor = 0;

  constructor(private readonly options: FakePageDeciderOptions = {}) {}

  describe(): AdapterDescriptor<PageDeciderCapabilities> {
    return {
      id: "fake",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { vision: this.options.vision ?? false },
    };
  }

  async decide(
    _computer: ComputerRef,
    request: PageDecisionRequest,
    context: AdapterContext,
  ): Promise<PageDecision> {
    this.requests.push(request);
    if ((request.signal ?? context.signal).aborted) return { ...EMPTY, error: "cancelled" };
    if (this.options.error) return { ...EMPTY, error: this.options.error };
    const decisions = this.options.decisions ?? [];
    if (decisions.length === 0) return EMPTY;
    const next = decisions[Math.min(this.cursor++, decisions.length - 1)];
    return { ...EMPTY, ...next };
  }
}
