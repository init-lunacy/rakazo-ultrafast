import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import type { RequestSpan } from "./step-timings.js";
import { classifyRequest, recordRequests, stepTimings } from "./step-timings.js";

it("tells model, computer and other requests apart", () => {
  expect(classifyRequest("https://api.example.test", "/v1/messages")).toEqual({
    kind: "model",
    route: "api.example.test",
  });
  expect(classifyRequest("http://127.0.0.1:4100", "/computers/c1/browser")).toEqual({
    kind: "computer",
    route: "browser",
  });
  expect(classifyRequest("https://supervisor.example.test", "/computers/c1/exec")).toEqual({
    kind: "computer",
    route: "exec",
  });
  expect(classifyRequest("http://localhost:3100", "/health?x=1")).toEqual({
    kind: "other",
    route: "localhost:3100",
  });
  expect(classifyRequest("", "/")).toEqual({ kind: "model", route: "" });
});

it("counts only the model's own origin as model time when it is known", () => {
  const model = "http://127.0.0.1:11434";
  expect(classifyRequest(model, "/v1/chat/completions", model).kind).toBe("model");
  expect(classifyRequest("https://search.example.test", "/q", model)).toEqual({
    kind: "other",
    route: "search.example.test",
  });
});

it("counts time shared by overlapping runs once", () => {
  const timings = stepTimings(
    [],
    [
      { startMs: 0, endMs: 100 },
      { startMs: 50, endMs: 150 },
    ],
  );
  expect(timings.otherMs).toBe(150);
  expect(timings.engineMs).toBe(150);
});

it("splits task time into model, computer and the rest, inside the runs only", () => {
  const span = (kind: RequestSpan["kind"], route: string, startMs: number, endMs: number) => ({
    kind,
    route,
    startMs,
    firstByteMs: startMs + 1,
    endMs,
  });
  const timings = stepTimings(
    [
      // Before the run: setup, ignored.
      span("computer", "exec", 0, 50),
      // Starts before the run, so only its last 10 ms count.
      span("model", "api.example.test", 90, 110),
      span("computer", "browser", 120, 150),
      span("computer", "browser", 160, 170),
      // Overlaps the previous model call; the overlap counts once.
      span("model", "api.example.test", 175, 200),
      span("model", "api.example.test", 190, 210),
      { ...span("model", "api.example.test", 205, 0), endMs: null },
    ],
    [{ startMs: 100, endMs: 300 }],
    [
      { name: "browser_snapshot", durationMs: 30 },
      { name: "browser_act", durationMs: 12 },
      { name: "browser_snapshot", durationMs: 10 },
    ],
  );
  expect(timings.model).toEqual({ calls: 3, ms: 10 + 35, firstByteMs: 3 });
  expect(timings.computer).toEqual({
    calls: 2,
    ms: 40,
    byRoute: { browser: { calls: 2, ms: 40 } },
  });
  expect(timings.otherMs).toBe(200 - 45 - 40);
  expect(timings.engineMs).toBe(200 - 45);
  expect(timings.tools).toEqual({
    browser_snapshot: { calls: 2, ms: 40 },
    browser_act: { calls: 1, ms: 12 },
  });
});

it("records requests made through fetch", async () => {
  const server = createServer((_request, response) => response.end("ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const recorder = recordRequests();
  try {
    await (await fetch(`http://127.0.0.1:${port}/computers/c1/exec`)).text();
  } finally {
    recorder.stop();
    server.close();
  }
  expect(recorder.spans).toEqual([
    expect.objectContaining({ kind: "computer", route: "exec", endMs: expect.any(Number) }),
  ]);
  const [span] = recorder.spans;
  expect(span!.firstByteMs).toBeGreaterThanOrEqual(span!.startMs);
  expect(span!.endMs).toBeGreaterThanOrEqual(span!.firstByteMs!);
});
