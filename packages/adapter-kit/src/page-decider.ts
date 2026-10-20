import type {
  AdapterContext,
  AdapterDescriptor,
  BrowserActKind,
  BrowserSnapshotNode,
  ComputerRef,
} from "./types.js";

export interface PageDeciderCapabilities {
  /** True when the decider uses a screenshot. The chain captures one only then. */
  vision: boolean;
}

/** What a decider may do to an element. An upload needs files, which only the model can name. */
export type PageDecisionKind = Exclude<BrowserActKind, "upload">;

export interface PageDecisionAttempt {
  ref: string;
  kind: PageDecisionKind;
  /** Whether the page changed after this attempt. */
  changed: boolean;
}

export interface PageDecisionRequest {
  /** The current browser leg's goal, written by the bot's model. */
  goal: string;
  /** Candidates, verbatim from BrowserSnapshotResult.elements. */
  elements: readonly BrowserSnapshotNode[];
  /** Bounded visible page text. */
  excerpt: string;
  url: string;
  title: string;
  history: readonly PageDecisionAttempt[];
  /**
   * Base64 CDP viewport capture. `scale` is image pixels per CSS pixel, so a
   * point in the image divides by it to land in element-rect space.
   */
  screenshot?: { data: string; mimeType: "image/png"; scale: number };
  signal?: AbortSignal;
}

export interface PageDecisionCandidate {
  ref: string;
  kind: PageDecisionKind;
  confidence: number;
  /** How the candidate was found. Diagnostic only; the policy ignores it. */
  source?: "list" | "point";
}

export interface PageDecision {
  /** Ranked best first. Empty when the decider declines to pick. */
  candidates: readonly PageDecisionCandidate[];
  goalMet: number;
  stuck: number;
  blocked: number;
  error?: string;
}

/**
 * A fast decision for one browser step. Names a ref and a kind, never text to
 * type and never a coordinate; the caller's policy decides whether to trust it.
 */
export interface PageDecider {
  describe(): AdapterDescriptor<PageDeciderCapabilities>;
  decide(
    computer: ComputerRef,
    request: PageDecisionRequest,
    context: AdapterContext,
  ): Promise<PageDecision>;
}

/** Bounds every decision request is built within; deciders enforce them too. */
export const PAGE_DECISION_MAX_ELEMENTS = 240;
export const PAGE_DECISION_MAX_EXCERPT_CHARS = 4_000;
