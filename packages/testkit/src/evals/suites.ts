import type { SandboxProvider } from "@rakazo/adapter-kit";
import {
  BROWSER_ONLY_TOOLS,
  BROWSING_EVAL_CASES,
  BROWSING_FIXTURE_VERSION,
} from "./browsing/cases.js";
import type { EvalCase } from "./cases.js";
import { EVAL_CASES, HISTORY_EVAL_CASES } from "./cases.js";
import { HISTORY_FIXTURE_VERSION } from "./history-fixtures.js";
import type { ComputerFixture } from "./runner.js";
import { SILENCE_EVAL_CASES, SILENCE_FIXTURE_VERSION } from "./silence.js";

export type EvalSuite = {
  cases: EvalCase[];
  fixtureVersion: string;
  /** Runs each trial on a real Docker bot computer, with this fixture installed in it. */
  computerFixture?: () => Promise<(sandbox: SandboxProvider) => ComputerFixture>;
  controls: { timeoutMs: number; maxToolCalls: number };
  fixtures: string;
  limitations: string[];
};

const COST_LIMITATION =
  "Cost uses provider-reported charges where available and explicit pricing estimates otherwise. Spend reservations are a guard, not a billing guarantee.";
const TRACE_LIMITATION =
  "Tool trace contains names and statuses only; raw requests and responses are omitted.";
const OFFLINE = {
  controls: { timeoutMs: 180_000, maxToolCalls: 30 },
  fixtures: "synthetic services, messaging and fake sandbox",
  limitations: [
    "Does not evaluate browser perception, native recording perception, or real external services.",
    "Silence cases observe routine chat, transient progress, and provider notification requests; native push delivery and UI pixels are outside the fixture.",
    "Deterministic fact checks are deliberately narrow; they do not grade overall writing quality.",
    COST_LIMITATION,
    TRACE_LIMITATION,
  ],
};

export const EVAL_SUITES = {
  product: { cases: EVAL_CASES, fixtureVersion: "product-v1", ...OFFLINE },
  history: { cases: HISTORY_EVAL_CASES, fixtureVersion: HISTORY_FIXTURE_VERSION, ...OFFLINE },
  silence: { cases: SILENCE_EVAL_CASES, fixtureVersion: SILENCE_FIXTURE_VERSION, ...OFFLINE },
  browsing: {
    cases: BROWSING_EVAL_CASES,
    fixtureVersion: BROWSING_FIXTURE_VERSION,
    // Deferred: the fixture loads the adapters, which --list must not import.
    computerFixture: async () => (await import("./browsing/install.js")).browsingComputerFixture,
    controls: { timeoutMs: 300_000, maxToolCalls: 60 },
    fixtures: "synthetic local websites served inside a real Docker bot computer",
    limitations: [
      `The bot's ${BROWSER_ONLY_TOOLS.join(", ")} tools are off. The desktop stays reachable through computer_act, so graders require the site requests to come from Chrome.`,
      "The sites are synthetic and local; real websites are slower and change.",
      "Each run uses one model connection; a few trials give a baseline, not a precise rate.",
      COST_LIMITATION,
      TRACE_LIMITATION,
    ],
  },
} satisfies Record<string, EvalSuite>;

export function resolveSuite(name: string): EvalSuite {
  if (!Object.hasOwn(EVAL_SUITES, name))
    throw new Error(`Unknown suite; use ${Object.keys(EVAL_SUITES).join(", ")}`);
  return EVAL_SUITES[name as keyof typeof EVAL_SUITES];
}

/** Explicit flags win; otherwise each suite's own limits apply. */
export function resolveControls(
  suite: EvalSuite,
  flags: { trials: string; timeoutMs?: string; maxToolCalls?: string },
) {
  return {
    trials: Number(flags.trials),
    timeoutMs: Number(flags.timeoutMs ?? suite.controls.timeoutMs),
    maxToolCalls: Number(flags.maxToolCalls ?? suite.controls.maxToolCalls),
  };
}
