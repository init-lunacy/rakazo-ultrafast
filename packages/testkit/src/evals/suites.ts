import type { SandboxProvider } from "@rakazo/adapter-kit";
import {
  BROWSER_ONLY_TOOLS,
  BROWSING_EVAL_CASES,
  BROWSING_FIXTURE_VERSION,
} from "./browsing/cases.js";
import type { EvalCase } from "./cases.js";
import { EVAL_CASES, HISTORY_EVAL_CASES } from "./cases.js";
import {
  DELIBERATION_EVAL_CASES,
  DELIBERATION_FIXTURE_VERSION,
  DELIBERATION_JUDGE_CALIBRATION,
  DELIBERATION_JUDGE_VERSION,
} from "./deliberation.js";
import {
  GROUP_EVAL_CASES,
  GROUP_FIXTURE_VERSION,
  GROUP_JUDGE_CALIBRATION,
  GROUP_JUDGE_VERSION,
} from "./group.js";
import { HISTORY_FIXTURE_VERSION } from "./history-fixtures.js";
import {
  INITIATIVE_EVAL_CASES,
  INITIATIVE_FIXTURE_VERSION,
  INITIATIVE_JUDGE_CALIBRATION,
  INITIATIVE_JUDGE_VERSION,
} from "./initiative.js";
import type { JudgeInput } from "./judge.js";
import {
  MEMORY_EVAL_CASES,
  MEMORY_FIXTURE_VERSION,
  MEMORY_JUDGE_CALIBRATION,
  MEMORY_JUDGE_VERSION,
} from "./memory.js";
import type { ComputerFixture } from "./runner.js";
import {
  SILENCE_EVAL_CASES,
  SILENCE_FIXTURE_VERSION,
  SILENCE_JUDGE_CALIBRATION,
  SILENCE_JUDGE_VERSION,
} from "./silence.js";
import { TOOL_CHOICE_FIXTURE_VERSION } from "./tool-choice.js";
import { TOOL_CHOICE_CASES } from "./tool-choice-cases.js";

export type EvalSuite = {
  cases: EvalCase[];
  fixtureVersion: string;
  judge?: { version: string; calibration: Array<{ input: JudgeInput; pass: boolean }> };
  /** Runs each trial on a real Docker bot computer, with this fixture installed in it. */
  computerFixture?: () => Promise<(sandbox: SandboxProvider) => ComputerFixture>;
  controls: { timeoutMs: number; maxToolCalls: number };
  fixtures: string;
  limitations: string[];
};

const COST_LIMITATION =
  "Cost uses provider-reported charges where available and explicit pricing estimates otherwise. Spend reservations are a guard, not a billing guarantee.";
const TRACE_LIMITATION =
  "Tool trace contains names and statuses only; raw requests and responses are omitted. The tool-calls artifact keeps model-supplied arguments, with only configured secrets redacted.";
const OFFLINE = {
  controls: { timeoutMs: 180_000, maxToolCalls: 30 },
  fixtures: "synthetic services, messaging and fake sandbox",
  limitations: [
    "Does not evaluate browser perception, native recording perception, or real external services.",
    "Silence cases observe routine chat, transient progress, and provider notification requests; native push delivery and UI pixels are outside the fixture.",
    "Silence replies and memory contents are graded by meaning with a calibrated LLM judge; other suites retain their existing task-specific graders.",
    COST_LIMITATION,
    TRACE_LIMITATION,
  ],
};

export const EVAL_SUITES = {
  product: { cases: EVAL_CASES, fixtureVersion: "product-v1", ...OFFLINE },
  history: { cases: HISTORY_EVAL_CASES, fixtureVersion: HISTORY_FIXTURE_VERSION, ...OFFLINE },
  group: {
    cases: GROUP_EVAL_CASES,
    fixtureVersion: GROUP_FIXTURE_VERSION,
    judge: { version: GROUP_JUDGE_VERSION, calibration: GROUP_JUDGE_CALIBRATION },
    ...OFFLINE,
  },
  silence: {
    cases: SILENCE_EVAL_CASES,
    fixtureVersion: SILENCE_FIXTURE_VERSION,
    judge: { version: SILENCE_JUDGE_VERSION, calibration: SILENCE_JUDGE_CALIBRATION },
    ...OFFLINE,
  },
  initiative: {
    cases: INITIATIVE_EVAL_CASES,
    fixtureVersion: INITIATIVE_FIXTURE_VERSION,
    judge: { version: INITIATIVE_JUDGE_VERSION, calibration: INITIATIVE_JUDGE_CALIBRATION },
    ...OFFLINE,
  },
  deliberation: {
    cases: DELIBERATION_EVAL_CASES,
    fixtureVersion: DELIBERATION_FIXTURE_VERSION,
    judge: { version: DELIBERATION_JUDGE_VERSION, calibration: DELIBERATION_JUDGE_CALIBRATION },
    ...OFFLINE,
  },
  memory: {
    cases: MEMORY_EVAL_CASES,
    fixtureVersion: MEMORY_FIXTURE_VERSION,
    judge: { version: MEMORY_JUDGE_VERSION, calibration: MEMORY_JUDGE_CALIBRATION },
    ...OFFLINE,
  },
  "tool-choice": {
    cases: TOOL_CHOICE_CASES,
    fixtureVersion: TOOL_CHOICE_FIXTURE_VERSION,
    ...OFFLINE,
  },
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
    throw new Error(`Unknown suite; use ${Object.keys(EVAL_SUITES).join(", ")}, or approval`);
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
