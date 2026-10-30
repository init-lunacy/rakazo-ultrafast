import type { AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type * as ActionOfferToolModule from "./action-offer-tool.js";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
import type * as GroupHandoffModule from "./group-handoff.js";
import { withModelRoles } from "./testing/model-roles.js";

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  acquireDedicatedScreenLeaseFence: async (
    _prisma: unknown,
    input: { computerId: string; botId: string; runId: string },
  ) => ({ ...input, fence: 7 }),
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
}));

// Card storage and the handoff write run against Postgres elsewhere; here only finalize is under test.
const offerActionsMock = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true as const, willShow: ["Book the hotel"], openCards: [] })),
);
vi.mock("./action-offer-tool.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ActionOfferToolModule>()),
  offerActionsFromTool: offerActionsMock,
}));
vi.mock("./group-handoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof GroupHandoffModule>()),
  loadGroupContext: async () => "You are in a group with Planner.",
  handoffToGroupBot: async () => ({ ok: true }),
}));

const offer = { offers: [{ label: "Book the hotel", task: "Book the hotel we compared." }] };

function fixture(script: (request: AgentRunRequest) => AsyncGenerator<unknown>) {
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: "user",
    sourceMessageId: null,
    leaseFence: 0,
  };
  const prisma = {
    user: { findUnique: async () => null },
    run: {
      findFirst: async () => null,
      findUnique: async () => run,
      findUniqueOrThrow: async () => run,
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      },
    },
    bot: {
      findUniqueOrThrow: async () => ({
        id: run.botId,
        name: "Assistant",
        title: "Assistant",
        description: "Test assistant",
        disabledBuiltinTools: [],
        computerId: "computer-1",
        computer: { id: "computer-1", scope: "dedicated" },
      }),
      findMany: async () => [],
      findUnique: async () => ({ fleetManagement: false }),
    },
    attempt: {
      create: async () => ({ id: "attempt-1" }),
      findMany: async () => [],
      update: vi.fn(),
      updateMany: async () => ({ count: 1 }),
    },
    thread: {
      findUniqueOrThrow: async () => ({ id: run.threadId, groupId: "group-1" }),
      update: async () => ({ nextMessageSeq: 2, nextEventSeq: 2 }),
    },
    message: {
      findFirst: async () => null,
      findUnique: async () => null,
      findMany: async () => [],
      create: async ({ data }: { data: Record<string, unknown> }) => ({
        id: "message-1",
        createdAt: new Date(),
        ...data,
      }),
    },
    event: {
      count: async () => 4,
      // Payloads are sealed at rest; the client hands them back decrypted.
      findMany: async () =>
        ["browser_navigate", "browser_snapshot", "offer_actions", "write_file"].map((name) => ({
          payload: { name },
        })),
      create: async ({ data }: { data: Record<string, unknown> }) => ({ id: "event-1", ...data }),
    },
    task: {
      findUniqueOrThrow: async () => ({ id: run.taskId, prompt: "Compare two hotels" }),
    },
    connection: { findMany: async () => [] },
    secret: { findMany: async () => [] },
    spaceModelPreference: { findFirst: async () => null },
    userModelCredential: { findFirst: async () => null },
    deploymentSettings: {
      findUnique: async () => ({ defaultModelProvider: "local", defaultModelId: "fixture-model" }),
    },
    taughtSkill: { findMany: async () => [] },
    chatGroup: { findMany: async () => [] },
    botSection: { findMany: async () => [] },
    vaultCredential: { findMany: async () => [] },
    agentSkill: { findMany: async () => [] },
    scratchpadItem: { findMany: async () => [] },
    spaceSettingOverride: { findUnique: async () => null },
    actionApprovalRule: { findMany: async () => [] },
    userActionApprovalRule: { findMany: async () => [] },
    actionAutoReviewPreference: { findUnique: async () => ({ enabled: false }) },
    userActionAutoReviewPreference: { findUnique: async () => ({ enabled: false }) },
    steeringMessage: { findFirst: async () => null },
    externalEffect: {
      findMany: async () => [],
      findUnique: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => ({ id: "effect-1", ...data }),
      update: async () => undefined,
      updateMany: async () => ({ count: 1 }),
    },
    usageRecord: { createMany: async () => ({ count: 1 }) },
    $queryRaw: async () => [],
  };
  const finalizeRun = vi.fn(async (_input: Record<string, unknown>) => ({
    continuationRunId: null,
  }));
  const runtime = {
    describe: () => ({ capabilities: { scripted: false } }),
    run: script,
  } as unknown as AgentRuntime;
  const executor = createRunExecutor({
    prisma: withModelRoles(
      Object.assign(prisma, {
        $transaction: async (action: (tx: typeof prisma) => unknown) => action(prisma),
      }),
    ),
    runtime,
    connector: { discoverTools: async () => [], resolveCall: async () => undefined },
    sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    events: {
      append: async () => undefined,
      notify: async () => undefined,
      claimSteering: async () => [],
      finalizeRun,
    },
    jobs: { enqueue: async () => undefined },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  return { finalizeRun, run: () => executor.continueRun(run.id, "worker-1") };
}

describe("cards from a run that does not end with its own reply", () => {
  it("keeps the offered cards held when the run hands off to another bot", async () => {
    const results: unknown[] = [];
    const f = fixture(async function* (request) {
      results.push(await request.executeTool!("offer_actions", offer, "call-1"));
      results.push(
        await request.executeTool!(
          "handoff_to_bot",
          { bot_id: "bot-2", message: "Planner, take it from here." },
          "call-2",
        ),
      );
      yield { type: "done" as const, text: "Handing over." };
    });
    await f.run();
    expect(offerActionsMock).toHaveBeenCalledOnce();
    expect(results).toEqual([expect.objectContaining({ ok: true }), { ok: true }]);
    expect(f.finalizeRun).toHaveBeenCalledOnce();
    expect(f.finalizeRun.mock.calls[0]![0]).toMatchObject({
      outcome: "completed",
      publishOffers: false,
    });
  });

  it("keeps the offered cards held when the loop guard stops the run", async () => {
    offerActionsMock.mockClear();
    const f = fixture(async function* (request) {
      await request.executeTool!("offer_actions", offer, "call-1");
      for (let index = 0; index < 6; index++) {
        yield {
          type: "tool" as const,
          name: "browser_snapshot",
          args: {},
          executionId: `snapshot-${index}`,
        };
      }
      yield { type: "done" as const, text: "Never reached." };
    });
    await f.run();
    expect(offerActionsMock).toHaveBeenCalledOnce();
    expect(f.finalizeRun).toHaveBeenCalledOnce();
    expect(f.finalizeRun.mock.calls[0]![0]).toMatchObject({
      outcome: "completed",
      publishOffers: false,
      blocks: [{ kind: "text", text: expect.stringContaining("I got stuck calling") }],
    });
  });

  it("publishes the offered cards when the run ends with its own reply", async () => {
    const f = fixture(async function* (request) {
      await request.executeTool!("offer_actions", offer, "call-1");
      yield { type: "done" as const, text: "The second hotel is cheaper." };
    });
    await f.run();
    // The steps toward a save-skill offer leave out offer_actions itself.
    expect((offerActionsMock.mock.lastCall as unknown[] | undefined)?.[1]).toMatchObject({
      stepCount: 3,
    });
    expect(f.finalizeRun.mock.calls[0]![0]).toMatchObject({
      outcome: "completed",
      publishOffers: true,
    });
  });
});
