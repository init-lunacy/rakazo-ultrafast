import { subscribe, unsubscribe } from "node:diagnostics_channel";

/** One outgoing HTTP request, in epoch milliseconds. */
export type RequestSpan = {
  kind: "model" | "computer" | "local";
  route: string;
  startMs: number;
  firstByteMs: number | null;
  endMs: number | null;
};

export type StepTimings = {
  model: { calls: number; ms: number; firstByteMs: number };
  computer: { calls: number; ms: number; byRoute: Record<string, { calls: number; ms: number }> };
  /** Task time spent in neither a model nor a computer request: the product's own work. */
  otherMs: number;
  /** Task time not spent waiting on the model, which the product cannot speed up. */
  engineMs: number;
  /** Each tool's calls and total run time, from the product's own completion records. */
  tools: Record<string, { calls: number; ms: number }>;
};

export type ToolCompletion = { name: string; durationMs: number };

type Window = { startMs: number; endMs: number };

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

export function classifyRequest(origin: string, path: string): Pick<RequestSpan, "kind" | "route"> {
  if (!LOOPBACK.test(origin)) return { kind: "model", route: new URL(origin).host };
  // The computer supervisor's routes are /computers/<id>/<action>.
  const computer = /^\/computers\/[^/]+\/([^/?]+)/.exec(path);
  if (computer) return { kind: "computer", route: computer[1]! };
  return { kind: "local", route: path.split("?")[0]! };
}

/** Records every request made through fetch until stopped. Trials run one at a time. */
export function recordRequests() {
  const spans: RequestSpan[] = [];
  const open = new Map<object, RequestSpan>();
  type Message = { request: { origin?: unknown; path?: unknown } };
  const onCreate = (message: unknown) => {
    const { request } = message as Message;
    const span: RequestSpan = {
      ...classifyRequest(String(request.origin ?? ""), String(request.path ?? "")),
      startMs: Date.now(),
      firstByteMs: null,
      endMs: null,
    };
    open.set(request, span);
    spans.push(span);
  };
  const onHeaders = (message: unknown) => {
    const span = open.get((message as Message).request);
    if (span) span.firstByteMs = Date.now();
  };
  const onEnd = (message: unknown) => {
    const { request } = message as Message;
    const span = open.get(request);
    if (span) span.endMs = Date.now();
    open.delete(request);
  };
  const channels = {
    "undici:request:create": onCreate,
    "undici:request:headers": onHeaders,
    "undici:request:trailers": onEnd,
    "undici:request:error": onEnd,
  };
  for (const [name, listener] of Object.entries(channels)) subscribe(name, listener);
  return {
    spans,
    stop() {
      for (const [name, listener] of Object.entries(channels)) unsubscribe(name, listener);
    },
  };
}

/** Total length of the intervals' union, counting only what falls inside the windows. */
function covered(intervals: readonly Window[], windows: readonly Window[]) {
  const clipped = intervals
    .flatMap((interval) =>
      windows.map((window) => ({
        startMs: Math.max(interval.startMs, window.startMs),
        endMs: Math.min(interval.endMs, window.endMs),
      })),
    )
    .filter((interval) => interval.endMs > interval.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  let total = 0;
  let reach = Number.NEGATIVE_INFINITY;
  for (const { startMs, endMs } of clipped) {
    if (endMs <= reach) continue;
    total += endMs - Math.max(startMs, reach);
    reach = endMs;
  }
  return total;
}

/** Splits the task's run time into model requests, computer requests and everything else. */
export function stepTimings(
  spans: readonly RequestSpan[],
  runs: readonly Window[],
  completions: readonly ToolCompletion[] = [],
): StepTimings {
  type Ended = RequestSpan & { endMs: number };
  const inTask = spans.filter((span): span is Ended => {
    const { startMs, endMs } = span;
    return endMs !== null && runs.some((run) => startMs < run.endMs && endMs > run.startMs);
  });
  const model: Ended[] = inTask.filter((span) => span.kind === "model");
  const computer: Ended[] = inTask.filter((span) => span.kind === "computer");
  const byRoute: StepTimings["computer"]["byRoute"] = {};
  for (const span of computer) {
    const entry = byRoute[span.route] ?? { calls: 0, ms: 0 };
    entry.calls += 1;
    entry.ms += span.endMs - span.startMs;
    byRoute[span.route] = entry;
  }
  const tools: StepTimings["tools"] = {};
  for (const { name, durationMs } of completions) {
    const entry = tools[name] ?? { calls: 0, ms: 0 };
    entry.calls += 1;
    entry.ms += durationMs;
    tools[name] = entry;
  }
  const taskMs = runs.reduce((total, run) => total + (run.endMs - run.startMs), 0);
  const modelMs = covered(model, runs);
  return {
    model: {
      calls: model.length,
      ms: modelMs,
      firstByteMs: model.reduce(
        (total, span) => total + ((span.firstByteMs ?? span.endMs) - span.startMs),
        0,
      ),
    },
    computer: { calls: computer.length, ms: covered(computer, runs), byRoute },
    otherMs: taskMs - covered([...model, ...computer], runs),
    engineMs: taskMs - modelMs,
    tools,
  };
}
