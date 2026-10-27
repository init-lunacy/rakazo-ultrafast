import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "./generated/prisma/client.js";
import { recordUsage } from "./usage.js";

function client(createMany: ReturnType<typeof vi.fn>, transaction = vi.fn()) {
  const tx = { usageRecord: { createMany }, modelCreditEntry: { findUnique: async () => null } };
  return {
    ...tx,
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      transaction();
      return work(tx);
    },
  } as unknown as Parameters<typeof recordUsage>[0];
}

describe("usage ledger", () => {
  it("retains charged usage arriving after its run was deleted", async () => {
    const createMany = vi.fn(async (_args: { data: Prisma.UsageRecordCreateManyInput[] }) => ({
      count: 1,
    }));
    const prisma = client(createMany);
    await recordUsage(
      prisma,
      {
        type: "usage",
        provider: "fixture",
        model: "test",
        callId: "late-call",
        inputTokens: 10,
        outputTokens: 2,
      },
      { spaceId: "space-fixture", userId: "user-fixture", runId: "deleted-run" },
    );
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany.mock.calls[0]?.[0]).toMatchObject({
      data: [
        expect.objectContaining({
          runId: "deleted-run",
          parentRunId: "deleted-run",
          inputTokens: 10,
        }),
      ],
    });
  });
  it("persists every reported bucket and durable operation attribution idempotently", async () => {
    const createMany = vi.fn(async (_args: { data: Prisma.UsageRecordCreateManyInput[] }) => ({
      count: 1,
    }));
    const prisma = client(createMany);
    const event = {
      type: "usage" as const,
      provider: "fixture",
      model: "test",
      callId: "call-fixture",
      inputTokens: 60,
      outputTokens: 30,
      cacheReadTokens: 40,
      cacheWriteTokens: 0,
      reasoningTokens: 10,
      totalTokens: 130,
      costUsd: 0.001,
      costSource: "fixture",
      pricingVersion: "v1",
      operationKind: "subagent" as const,
      agentId: "agent-fixture",
    };
    await recordUsage(prisma, event, {
      spaceId: "space-fixture",
      userId: "user-fixture",
      botId: "bot-fixture",
      parentRunId: "run-fixture",
      operationId: "operation-fixture",
    });
    expect(createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          callId: event.callId,
          inputTokens: 60,
          outputTokens: 30,
          cacheReadTokens: 40,
          reasoningTokens: 10,
          operationKind: "subagent",
          agentId: "agent-fixture",
          parentRunId: "run-fixture",
          cacheWriteTokens: 0,
        }),
      ],
      skipDuplicates: true,
    });
  });
  it("keeps unknown usage null and never invents a foreground run for background work", async () => {
    const createMany = vi.fn(async (_args: { data: Prisma.UsageRecordCreateManyInput[] }) => ({
      count: 1,
    }));
    const prisma = client(createMany);
    await recordUsage(
      prisma,
      { type: "usage", provider: "fixture", model: "test", inputTokens: null, outputTokens: null },
      {
        spaceId: "space-fixture",
        userId: "user-fixture",
        operationKind: "compaction",
        operationId: "job-fixture",
      },
    );
    const data = createMany.mock.calls[0]?.[0].data[0];
    expect(data).toMatchObject({
      operationKind: "compaction",
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      costUsd: null,
    });
    expect(data?.runId).toBeUndefined();
  });
  it("records usage without a transaction when the call reserved no credits", async () => {
    const createMany = vi.fn(async () => ({ count: 1 }));
    const transaction = vi.fn();
    const prisma = client(createMany, transaction);
    const usage = { type: "usage" as const, provider: "fixture", model: "test" };
    await recordUsage(prisma, { ...usage, callId: "byok-call", inputTokens: 1, outputTokens: 1 }, {
      spaceId: "space-fixture",
      userId: "user-fixture",
    });
    await recordUsage(prisma, { ...usage, inputTokens: 1, outputTokens: 1 }, {
      spaceId: "space-fixture",
      userId: "user-fixture",
    });
    expect(createMany).toHaveBeenCalledTimes(2);
    expect(transaction).not.toHaveBeenCalled();
  });
});
