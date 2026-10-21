import type { SandboxProvider } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  createDb,
  createThreadEvents,
  createThreadMessage,
  finalizeRun,
  provisionMessagingIdentity,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { takeActionOffer } from "./action-offers.js";
import { resolveThreadTarget, stopThreadRuns } from "./thread-target.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe.sequential : describe.skip;
const ACTIVE = ["queued", "leased", "running", "waiting_input", "waiting_takeover"];

describePostgres("taking an action card (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let ids: { userId: string; spaceId: string; botId: string; threadId: string };
  let actor: Actor;
  const address = `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;
  const deps = () => ({
    prisma,
    events: createThreadEvents(prisma),
    jobs: { enqueue: async () => undefined },
  });

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      try {
        await db.prisma.$disconnect();
      } finally {
        await db.pool.end();
      }
    };
    const identity = await provisionMessagingIdentity(
      prisma,
      { provider: "sendblue", address },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    );
    ids = {
      userId: identity.userId,
      spaceId: identity.spaceId,
      botId: identity.botId,
      threadId: identity.threadId,
    };
    const user = await prisma.user.findUniqueOrThrow({ where: { id: ids.userId } });
    actor = {
      userId: ids.userId,
      spaceId: ids.spaceId,
      email: user.email,
      isDeploymentOwner: false,
    };
  });

  afterAll(async () => {
    try {
      await prisma.messagingIdentity.deleteMany({ where: { provider: "sendblue", address } });
      await prisma.organization.deleteMany({ where: { id: ids.spaceId } });
      await prisma.user.deleteMany({ where: { id: ids.userId } });
    } finally {
      await close?.();
    }
  });

  /** An open card from botId in threadId, on a bot message, as a completed run leaves it. */
  async function openCard(
    task = "Book the Lisbon hotel we compared.",
    where: { botId: string; threadId: string; groupId: string | null } = { ...ids, groupId: null },
  ) {
    await prisma.run.updateMany({
      where: { threadId: where.threadId, status: { in: ACTIVE } },
      data: { status: "cancelled" },
    });
    const t = await prisma.task.create({
      data: {
        spaceId: ids.spaceId,
        userId: ids.userId,
        botId: where.botId,
        threadId: where.threadId,
        prompt: "compare",
        status: "completed",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: ids.spaceId,
        userId: ids.userId,
        botId: where.botId,
        threadId: where.threadId,
        taskId: t.id,
        status: "completed",
        trigger: "user",
      },
    });
    const offer = await prisma.actionOffer.create({
      data: {
        spaceId: ids.spaceId,
        userId: ids.userId,
        botId: where.botId,
        threadId: where.threadId,
        runId: run.id,
        kind: "task",
        label: "Book the hotel",
        task,
        status: "open",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const message = await createThreadMessage(prisma, {
      threadId: where.threadId,
      role: "bot",
      botId: where.botId,
      runId: run.id,
      blocks: [
        { kind: "text", text: "Two hotels fit. The second is cheaper." },
        {
          kind: "action_offer",
          offers: [
            {
              id: offer.id,
              kind: "task",
              label: "Book the hotel",
              task,
              expiresAt: offer.expiresAt.toISOString(),
              status: "open",
            },
          ],
        },
      ],
    });
    await prisma.actionOffer.update({ where: { id: offer.id }, data: { messageId: message.id } });
    return { offer: { ...offer, messageId: message.id, groupId: where.groupId }, message };
  }

  async function take(offer: Awaited<ReturnType<typeof openCard>>["offer"], who: Actor = actor) {
    const target = await resolveThreadTarget(
      prisma,
      who,
      offer.groupId ? { groupId: offer.groupId } : { botId: offer.botId },
    );
    return takeActionOffer(deps(), who, target, offer);
  }

  const sentFor = (threadId: string, offerId: string) =>
    prisma.message.findUniqueOrThrow({
      where: { threadId_clientNonce: { threadId, clientNonce: offerId } },
    });

  it("starts one run with the whole source message as context, and records it on the card", async () => {
    const { offer, message } = await openCard();
    const result = await take(offer);
    expect(result.runId).toEqual(expect.any(String));
    const sent = await sentFor(ids.threadId, offer.id);
    expect(sent.replyToMessageId).toBe(message.id);
    expect(sent.replyQuote ?? null).toBeNull();
    expect(await prisma.actionOffer.findUniqueOrThrow({ where: { id: offer.id } })).toMatchObject({
      status: "taken",
      takenRunId: result.runId,
    });
    const blocks = (await prisma.message.findUniqueOrThrow({ where: { id: message.id } }))
      .blocks as Array<{
      kind: string;
      offers?: Array<{ status: string; takenMessageId?: string }>;
    }>;
    expect(blocks[1]?.offers?.[0]).toMatchObject({ status: "taken", takenMessageId: sent.id });
  });

  it("starts exactly one run for two simultaneous taps and refuses any later tap", async () => {
    const { offer } = await openCard();
    const results = await Promise.allSettled([take(offer), take(offer)]);
    const runIds = results.flatMap((r) => (r.status === "fulfilled" ? [r.value.runId] : []));
    expect(new Set(runIds).size).toBe(1);
    expect(await prisma.run.count({ where: { sourceMessage: { clientNonce: offer.id } } })).toBe(1);
    await expect(take(offer)).rejects.toMatchObject({
      code: "CONFLICT",
      data: { reason: "card_closed", status: "taken" },
    });
  });

  it("queues the task behind a busy run instead of steering it, and reopens it if that run is stopped", async () => {
    const { offer } = await openCard();
    const t = await prisma.task.create({ data: { ...ids, prompt: "busy", status: "running" } });
    const busy = await prisma.run.create({
      data: { ...ids, taskId: t.id, status: "running", trigger: "user", startedAt: new Date() },
    });
    expect((await take(offer)).runId).toBeUndefined();
    const sent = await sentFor(ids.threadId, offer.id);
    expect(await prisma.steeringMessage.findFirst({ where: { messageId: sent.id } })).toMatchObject(
      { runId: null, originTrigger: "action_offer" },
    );
    expect((await prisma.run.findUniqueOrThrow({ where: { id: busy.id } })).status).toBe("running");
    await stopThreadRuns(
      { ...deps(), sandbox: {} as unknown as SandboxProvider },
      actor,
      await resolveThreadTarget(prisma, actor, { botId: ids.botId }),
    );
    expect((await prisma.actionOffer.findUniqueOrThrow({ where: { id: offer.id } })).status).toBe(
      "open",
    );
    const again = await take(offer);
    expect(again.runId).toEqual(expect.any(String));
    expect(await prisma.actionOffer.findUniqueOrThrow({ where: { id: offer.id } })).toMatchObject({
      status: "taken",
      takenRunId: again.runId,
    });
  });

  it("reopens a queued card whose follow-up run was created but not started when stopped", async () => {
    const { offer } = await openCard();
    const t = await prisma.task.create({ data: { ...ids, prompt: "busy", status: "running" } });
    const busy = await prisma.run.create({
      data: {
        ...ids,
        taskId: t.id,
        status: "running",
        trigger: "user",
        startedAt: new Date(),
        leaseOwner: "worker-1",
        leaseFence: 1,
      },
    });
    const attempt = await prisma.attempt.create({
      data: { runId: busy.id, fence: 1, status: "running" },
    });
    expect((await take(offer)).runId).toBeUndefined();
    const finished = await finalizeRun(prisma, {
      ...ids,
      runId: busy.id,
      taskId: t.id,
      attemptId: attempt.id,
      leaseOwner: "worker-1",
      leaseFence: 1,
      outcome: "completed",
      blocks: [{ kind: "text", text: "Done." }],
      markUnread: false,
    });
    const continuationRunId = finished?.continuationRunId;
    expect(continuationRunId).toEqual(expect.any(String));
    const sent = await sentFor(ids.threadId, offer.id);
    expect(await prisma.steeringMessage.findFirst({ where: { messageId: sent.id } })).toMatchObject(
      { runId: continuationRunId, claimedAt: null },
    );
    await stopThreadRuns(
      { ...deps(), sandbox: {} as unknown as SandboxProvider },
      actor,
      await resolveThreadTarget(prisma, actor, { botId: ids.botId }),
    );
    expect((await prisma.actionOffer.findUniqueOrThrow({ where: { id: offer.id } })).status).toBe(
      "open",
    );
    expect((await take(offer)).runId).toEqual(expect.any(String));
  });

  it("names the card's own bot when a group stop reopens it", async () => {
    const second = await prisma.bot.create({
      data: { spaceId: ids.spaceId, userId: ids.userId, name: "Planner", color: "blue" },
    });
    const group = await prisma.chatGroup.create({
      data: {
        spaceId: ids.spaceId,
        userId: ids.userId,
        name: "Stop",
        members: { create: [{ botId: ids.botId }, { botId: second.id }] },
      },
    });
    const thread = await prisma.thread.create({
      data: { spaceId: ids.spaceId, userId: ids.userId, groupId: group.id },
    });
    const { offer, message } = await openCard("Book it.", {
      botId: second.id,
      threadId: thread.id,
      groupId: group.id,
    });
    const t = await prisma.task.create({
      data: { ...ids, botId: second.id, threadId: thread.id, prompt: "busy", status: "running" },
    });
    await prisma.run.create({
      data: {
        ...ids,
        botId: second.id,
        threadId: thread.id,
        taskId: t.id,
        status: "running",
        trigger: "user",
        startedAt: new Date(),
      },
    });
    expect((await take(offer)).runId).toBeUndefined();
    const target = await resolveThreadTarget(prisma, actor, { groupId: group.id });
    await stopThreadRuns({ ...deps(), sandbox: {} as unknown as SandboxProvider }, actor, target);
    expect((await prisma.actionOffer.findUniqueOrThrow({ where: { id: offer.id } })).status).toBe(
      "open",
    );
    const updates = await prisma.event.findMany({
      where: { threadId: thread.id, type: "thread.message.updated" },
      orderBy: { seq: "desc" },
    });
    const reopen = updates.find(
      (event) => (event.payload as { messageId?: string }).messageId === message.id,
    );
    expect(reopen?.botId).toBe(second.id);
  });

  it("refuses while the bot waits for an answer, and leaves the card open", async () => {
    const { offer } = await openCard();
    const t = await prisma.task.create({ data: { ...ids, prompt: "ask", status: "running" } });
    await prisma.run.create({
      data: { ...ids, taskId: t.id, status: "waiting_input", trigger: "user" },
    });
    await expect(take(offer)).rejects.toMatchObject({
      code: "CONFLICT",
      data: { reason: "waiting_for_answer", botName: expect.any(String) },
    });
    expect((await prisma.actionOffer.findUniqueOrThrow({ where: { id: offer.id } })).status).toBe(
      "open",
    );
  });

  it("refuses an expired card", async () => {
    const { offer } = await openCard();
    await prisma.actionOffer.update({
      where: { id: offer.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(take(offer)).rejects.toMatchObject({
      code: "CONFLICT",
      data: { reason: "card_closed", status: "expired" },
    });
  });

  it("refuses a dismissed card before sending anything", async () => {
    const { offer } = await openCard();
    await prisma.actionOffer.update({ where: { id: offer.id }, data: { status: "dismissed" } });
    await expect(take(offer)).rejects.toMatchObject({
      code: "CONFLICT",
      data: { reason: "card_closed", status: "dismissed" },
    });
    expect(await prisma.message.count({ where: { clientNonce: offer.id } })).toBe(0);
  });

  it("wakes only the offering bot in a group, even when the task names others", async () => {
    const second = await prisma.bot.create({
      data: { spaceId: ids.spaceId, userId: ids.userId, name: "Second", color: "blue" },
    });
    const third = await prisma.bot.create({
      data: { spaceId: ids.spaceId, userId: ids.userId, name: "Third", color: "green" },
    });
    const group = await prisma.chatGroup.create({
      data: {
        spaceId: ids.spaceId,
        userId: ids.userId,
        name: "Trip",
        members: {
          create: [{ botId: ids.botId }, { botId: second.id }, { botId: third.id }],
        },
      },
    });
    const thread = await prisma.thread.create({
      data: { spaceId: ids.spaceId, userId: ids.userId, groupId: group.id },
    });
    const first = await prisma.bot.findUniqueOrThrow({ where: { id: ids.botId } });
    const { offer } = await openCard(`Ask @${first.name} to help, @everyone.`, {
      botId: second.id,
      threadId: thread.id,
      groupId: group.id,
    });
    await take(offer);
    const runs = await prisma.run.findMany({
      where: { threadId: thread.id, sourceMessage: { clientNonce: offer.id } },
    });
    expect(runs.map((run) => run.botId)).toEqual([second.id]);
    // Another member's pending question does not block a take from a different bot.
    const { offer: other } = await openCard("Book it too.", {
      botId: second.id,
      threadId: thread.id,
      groupId: group.id,
    });
    const asking = await prisma.task.create({
      data: { ...ids, prompt: "ask", status: "running", threadId: thread.id },
    });
    await prisma.run.create({
      data: {
        ...ids,
        threadId: thread.id,
        taskId: asking.id,
        status: "waiting_input",
        trigger: "user",
      },
    });
    expect((await take(other)).runId).toEqual(expect.any(String));
    await prisma.chatGroupMember.deleteMany({ where: { groupId: group.id, botId: second.id } });
    const { offer: orphan } = await openCard("Book it.", {
      botId: second.id,
      threadId: thread.id,
      groupId: group.id,
    });
    await expect(take(orphan)).rejects.toMatchObject({
      code: "CONFLICT",
      data: { reason: "left_group" },
    });
  });
});
