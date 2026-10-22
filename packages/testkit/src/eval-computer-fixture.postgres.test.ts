import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BROWSING_EVAL_CASES } from "./evals/browsing/cases.js";
import type { ComputerFixture } from "./evals/runner.js";
import { runTrial } from "./evals/runner.js";
import { EvalSandboxProvider } from "./evals/sandbox.js";
import { startModelEmulator } from "./model-emulator.js";

const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const scenario = BROWSING_EVAL_CASES.find((candidate) => candidate.id === "browse-hard-page")!;

async function runWithFixture(fixture: ComputerFixture, timeoutMs: number) {
  const fixtureKey = "offline-computer-fixture-key";
  const model = await startModelEmulator({
    apiKey: fixtureKey,
    steps: [
      {
        expect: () => undefined,
        response: { type: "text", text: "I could not open the article." },
      },
    ],
  });
  const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-fixture-eval-"));
  try {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    return await runTrial(scenario, 1, {
      connection: {
        provider: model.model.provider,
        modelId: model.model.id,
        baseUrl: model.baseUrl,
        apiKey: fixtureKey,
        contextWindow: 160_000,
        maxTokens: 4096,
      },
      timeoutMs,
      maxToolCalls: 8,
      computerFixture: fixture,
      createApp: (composio, messaging) =>
        createApp({
          sandbox: new EvalSandboxProvider(),
          databaseUrl: process.env.DATABASE_URL!,
          realtimeDatabaseUrl: process.env.DATABASE_URL!,
          authUrl: "http://127.0.0.1:5173",
          webOrigin: "http://127.0.0.1:5173",
          dataDir,
          sandboxProvider: "fake",
          agentRuntime: "pi",
          wakeupDriver: "memory",
          signupsEnabled: "true",
          composio,
          messaging,
          messagingOpenSignup: false,
          cloudAgentProvider: "none",
          encryptionKey: "offline-computer-fixture-encryption-key",
        }),
    });
  } finally {
    try {
      await model.close();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }
}

describe.skipIf(!databaseAvailable)("eval computer fixture", () => {
  it("gives the task its whole time limit however long the computer takes to boot", async () => {
    const result = await runWithFixture(
      {
        install: () => new Promise((resolve) => setTimeout(resolve, 6_000)),
        siteRequests: async () => [],
      },
      5_000,
    );
    // The model answered without the file, so the trial fails on the agent, not the clock.
    expect(result).toMatchObject({ status: "failed", category: "agent" });
    expect(result.timings?.bootMs).toBeGreaterThanOrEqual(6_000);
    expect(result.timings?.taskMs).toEqual(expect.any(Number));
  }, 60_000);

  it("blames the harness, not the model, when the site log cannot be read", async () => {
    const result = await runWithFixture(
      {
        install: async () => undefined,
        siteRequests: async () => {
          throw new Error("cat: requests.jsonl: No such file or directory");
        },
      },
      20_000,
    );
    expect(result).toMatchObject({ status: "failed", category: "harness" });
    expect(result.reason).toContain("Reading the site log failed");
  }, 60_000);
});
