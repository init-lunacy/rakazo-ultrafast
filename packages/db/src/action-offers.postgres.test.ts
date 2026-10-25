import type { MessageBlock } from "@rakazo/contracts";
import { ACTION_OFFER_STEERING_ORIGIN } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ActionOfferConflictError,
  countOpenActionOffers,
  dismissActionOffer,
  listOpenActionOffers,
  openActionOffersInChat,
  replaceHeldActionOffers,
} from "./action-offers.js";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { claimSteering, finalizeRun, runTookOutsideSteering } from "./events.js";
import { createThreadMessage } from "./messages.js";
import { provisionMessagingIdentity } from "./messaging.js";
import { asSystem } from "./row-security.js";
import { previewFromBlocks } from "./thread-listing.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe.sequential : describe.skip;

const hour = 60 * 60 * 1000;

describePostgres("action offers (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let ids: { userId: string; spaceId: string; botId: string; threadId: string };
  const address = `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    // Fixtures and assertions have no request around them; the runtime login enforces row security.
    prisma = asSystem(db.prisma);
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

  /** A running run of this bot, as the executor holds it; earlier runs are ended first. */
  async function runningRun(trigger = "user") {
    await prisma.run.updateMany({
      where: {
        threadId: ids.threadId,
        status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
      },
      data: { status: "cancelled" },
    });
    const task = await prisma.task.create({
      data: { ...ids, prompt: "compare hotels", status: "running" },
    });
    const run = await prisma.run.create({
      data: {
        ...ids,
        taskId: task.id,
        status: "running",
        trigger,
        startedAt: new Date(),
        leaseOwner: "worker-1",
        leaseFence: 1,
      },
    });
    const attempt = await prisma.attempt.create({
      data: { runId: run.id, fence: 1, status: "running" },
    });
    return { task, run, attempt };
  }

  /** Open cards on a bot message, as a completed run leaves them. */
  async function openCards(labels: string[], expiresAt = new Date(Date.now() + 24 * hour)) {
    const { run } = await runningRun();
    await prisma.run.update({ where: { id: run.id }, data: { status: "completed" } });
    const message = await createThreadMessage(prisma, {
      threadId: ids.threadId,
      role: "bot",
      botId: ids.botId,
      runId: run.id,
      blocks: [{ kind: "text", text: "Here is what I found." }],
    });
    const created = [];
    for (const label of labels) {
      created.push(
        await prisma.actionOffer.create({
          data: {
            ...ids,
            runId: run.id,
            messageId: message.id,
            kind: "task",
            label,
            task: `${label}.`,
            status: "open",
            expiresAt,
          },
        }),
      );
    }
    return created;
  }

  it("replaces a run's held offers on each call and keeps them out of every list", async () => {
    const { run } = await runningRun();
    const offer = {
      kind: "task" as const,
      label: "Book",
      task: "Book it.",
      expiresAt: new Date(Date.now() + hour),
    };
    await replaceHeldActionOffers(prisma, {
      ...ids,
      runId: run.id,
      offers: [offer, offer],
      close: [],
    });
    await replaceHeldActionOffers(prisma, { ...ids, runId: run.id, offers: [offer], close: [] });
    expect(await prisma.actionOffer.count({ where: { runId: run.id, status: "held" } })).toBe(1);
    const now = new Date();
    expect(
      (await listOpenActionOffers(prisma, ids, now)).some((item) => item.label === "Book"),
    ).toBe(false);
    expect(
      (
        await openActionOffersInChat(prisma, { threadId: ids.threadId, botId: ids.botId, now })
      ).some((item) => item.label === "Book"),
    ).toBe(false);
  });

  it("reads an open card past its expiry as expired without any job", async () => {
    const [stale] = await openCards(["Stale"], new Date(Date.now() - 1000));
    const now = new Date();
    expect(
      (await listOpenActionOffers(prisma, ids, now)).some((item) => item.id === stale!.id),
    ).toBe(false);
    const [fresh] = await openCards(["Fresh"]);
    const listed = await listOpenActionOffers(prisma, ids, new Date());
    expect(listed.some((item) => item.id === stale!.id)).toBe(false);
    expect(listed.some((item) => item.id === fresh!.id)).toBe(true);
    const counts = await countOpenActionOffers(prisma, ids, new Date());
    expect(counts.byBot.get(ids.botId)).toBe(listed.filter((item) => !item.groupId).length);
    expect(await dismissActionOffer(prisma, { offerId: stale!.id, ...ids, now })).toMatchObject({
      status: "expired",
    });
    expect((await prisma.actionOffer.findUnique({ where: { id: stale!.id } }))?.status).toBe(
      "expired",
    );
  });

  it("dismisses an open card once and reports the status of a closed one", async () => {
    const [card] = await openCards(["Dismiss me"]);
    const now = new Date();
    expect(await dismissActionOffer(prisma, { offerId: card!.id, ...ids, now })).toMatchObject({
      status: "dismissed",
    });
    expect(await dismissActionOffer(prisma, { offerId: card!.id, ...ids, now })).toMatchObject({
      status: "dismissed",
    });
  });

  it("refuses another user's card", async () => {
    const [card] = await openCards(["Mine"]);
    await expect(
      dismissActionOffer(prisma, {
        offerId: card!.id,
        spaceId: ids.spaceId,
        userId: "someone-else",
        now: new Date(),
      }),
    ).rejects.toThrow("Unknown action card");
  });

  it("is removed with the chat's messages", async () => {
    const [card] = await openCards(["Cleared"]);
    await prisma.message.delete({ where: { id: card!.messageId! } });
    expect(await prisma.actionOffer.findUnique({ where: { id: card!.id } })).toBeNull();
  });

  it("exports the conflict error with the card's status", () => {
    expect(new ActionOfferConflictError("taken").status).toBe("taken");
  });

  async function completeRun(
    fixture: Awaited<ReturnType<typeof runningRun>>,
    blocks: MessageBlock[],
    publishOffers = true,
  ) {
    const result = await finalizeRun(prisma, {
      ...ids,
      runId: fixture.run.id,
      taskId: fixture.task.id,
      attemptId: fixture.attempt.id,
      leaseOwner: "worker-1",
      leaseFence: 1,
      outcome: "completed",
      blocks,
      markUnread: false,
      publishOffers,
    });
    if (!result) throw new Error("Run was not finalized");
    return result;
  }

  const soon = () => new Date(Date.now() + 24 * hour);

  it("opens a completed run's cards on its final reply, in the same transaction", async () => {
    const fixture = await runningRun();
    await replaceHeldActionOffers(prisma, {
      ...ids,
      runId: fixture.run.id,
      offers: [{ kind: "task", label: "Book the hotel", task: "Book it.", expiresAt: soon() }],
      close: [],
    });
    const result = await completeRun(fixture, [{ kind: "text", text: "Found it." }]);
    const reply = await prisma.message.findFirstOrThrow({
      where: { runId: fixture.run.id, role: "bot" },
    });
    const blocks = reply.blocks as MessageBlock[];
    expect(blocks.map((block) => block.kind)).toEqual(["text", "action_offer"]);
    expect(result.publishedOffers).toEqual([
      { id: expect.any(String), label: "Book the hotel", messageId: reply.id },
    ]);
    expect(
      previewFromBlocks([{ kind: "action_offer", offers: [{ label: "Book the hotel" }] }]),
    ).toBe("Book the hotel");
    expect(
      await prisma.actionOffer.count({
        where: { runId: fixture.run.id, status: "open", messageId: reply.id },
      }),
    ).toBe(1);
  });

  it("posts a cards-only message when a completed run had nothing to say", async () => {
    await prisma.thread.update({ where: { id: ids.threadId }, data: { unread: false } });
    const fixture = await runningRun("routine");
    await replaceHeldActionOffers(prisma, {
      ...ids,
      runId: fixture.run.id,
      offers: [{ kind: "task", label: "Answer 3 emails", task: "Answer them.", expiresAt: soon() }],
      close: [],
    });
    const result = await completeRun(fixture, []);
    const message = await prisma.message.findUniqueOrThrow({
      where: { id: result.publishedOffers![0]!.messageId },
    });
    expect((await prisma.thread.findUniqueOrThrow({ where: { id: ids.threadId } })).unread).toBe(
      true,
    );
    expect((message.blocks as MessageBlock[]).map((block) => block.kind)).toEqual(["action_offer"]);
  });

  it("keeps cards held after a failure or without publishOffers, and never closes what they asked", async () => {
    const [old] = await openCards(["Pay the bill"]);
    const failed = await runningRun();
    await replaceHeldActionOffers(prisma, {
      ...ids,
      runId: failed.run.id,
      offers: [{ kind: "task", label: "Never shown", task: "x", expiresAt: soon() }],
      close: [old!.id],
    });
    await finalizeRun(prisma, {
      ...ids,
      runId: failed.run.id,
      taskId: failed.task.id,
      attemptId: failed.attempt.id,
      leaseOwner: "worker-1",
      leaseFence: 1,
      outcome: "failed",
      error: "boom",
    });
    const handedOff = await runningRun();
    await replaceHeldActionOffers(prisma, {
      ...ids,
      runId: handedOff.run.id,
      offers: [{ kind: "task", label: "Also never shown", task: "y", expiresAt: soon() }],
      close: [old!.id],
    });
    const result = await completeRun(handedOff, [], false);
    expect(result.publishedOffers).toBeUndefined();
    expect((await prisma.actionOffer.findUniqueOrThrow({ where: { id: old!.id } })).status).toBe(
      "open",
    );
    expect(
      await prisma.actionOffer.count({
        where: { runId: { in: [failed.run.id, handedOff.run.id] }, status: "held" },
      }),
    ).toBe(2);
  });

  it("merges an exact repeat, keeps a same-label different task apart, and applies close", async () => {
    const [repeat, other, closing] = await openCards(["Check prices", "Reply to Sam", "Old offer"]);
    const fixture = await runningRun();
    const later = new Date(Date.now() + 48 * hour);
    await replaceHeldActionOffers(prisma, {
      ...ids,
      runId: fixture.run.id,
      offers: [
        { kind: "task", label: "Check prices", task: "Check prices.", expiresAt: later },
        { kind: "task", label: "Reply to Sam", task: "Reply about the invoice.", expiresAt: later },
      ],
      close: [closing!.id],
    });
    const result = await completeRun(fixture, [{ kind: "text", text: "Done." }]);
    expect(result.publishedOffers?.map((offer) => offer.label)).toEqual(["Reply to Sam"]);
    const rows = await prisma.actionOffer.findMany({
      where: { id: { in: [repeat!.id, other!.id, closing!.id] } },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(repeat!.id)?.expiresAt.getTime()).toBe(later.getTime());
    expect(byId.get(other!.id)?.status).toBe("open");
    expect(byId.get(closing!.id)?.status).toBe("closed");
  });

  it("never merges save-skill cards: each run's card opens on its own reply", async () => {
    const replies = [];
    for (const text of ["Booked the flight.", "Filed the expense."]) {
      const fixture = await runningRun();
      await replaceHeldActionOffers(prisma, {
        ...ids,
        runId: fixture.run.id,
        offers: [
          {
            kind: "save_skill",
            label: "Save as a skill",
            task: "Save it.",
            expiresAt: soon(),
            skillSource: [`shell {"command":"${text}"}`],
          },
        ],
        close: [],
      });
      const result = await completeRun(fixture, [{ kind: "text", text }]);
      expect(result.publishedOffers).toHaveLength(1);
      replies.push({ runId: fixture.run.id, messageId: result.publishedOffers![0]!.messageId });
    }
    for (const reply of replies) {
      expect(
        await prisma.actionOffer.findMany({
          where: { runId: reply.runId },
          select: { status: true, messageId: true },
        }),
      ).toEqual([{ status: "open", messageId: reply.messageId }]);
    }
  });

  it("drops held cards that expired while the run waited", async () => {
    const fixture = await runningRun();
    await replaceHeldActionOffers(prisma, {
      ...ids,
      runId: fixture.run.id,
      offers: [
        { kind: "task", label: "Too late", task: "z", expiresAt: new Date(Date.now() - 1000) },
      ],
      close: [],
    });
    const result = await completeRun(fixture, [{ kind: "text", text: "Done." }]);
    expect(result.publishedOffers).toBeUndefined();
    expect(await prisma.actionOffer.count({ where: { runId: fixture.run.id } })).toBe(0);
  });

  it("runs a queued card after the busy run as its own follow-up, never as steering", async () => {
    const busy = await runningRun();
    const message = await createThreadMessage(prisma, {
      threadId: ids.threadId,
      role: "user",
      blocks: [{ kind: "text", text: "Book the hotel." }],
    });
    await prisma.steeringMessage.create({
      data: {
        messageId: message.id,
        botId: ids.botId,
        userId: ids.userId,
        runId: null,
        originTrigger: ACTION_OFFER_STEERING_ORIGIN,
      },
    });
    const claimed = await claimSteering(prisma, {
      threadId: ids.threadId,
      botId: ids.botId,
      runId: busy.run.id,
      leaseOwner: "worker-1",
      leaseFence: 1,
      seenIds: [],
    });
    expect(JSON.stringify(claimed)).not.toContain(message.id);
    const result = await completeRun(busy, [{ kind: "text", text: "Done." }]);
    expect(result.continuationRunId).toEqual(expect.any(String));
    const next = await prisma.run.findUniqueOrThrow({ where: { id: result.continuationRunId! } });
    expect(next.trigger).toBe("follow_up");
    expect(next.sourceMessageId).toBe(message.id);
    await prisma.steeringMessage.updateMany({
      where: { messageId: message.id },
      data: { runId: next.id, claimedAt: new Date() },
    });
    expect(await runTookOutsideSteering(prisma, next.id)).toBe(false);
  });

  it("leaves the chat read when a run with no cards and markUnread false completes", async () => {
    const fixture = await runningRun();
    await prisma.thread.update({ where: { id: ids.threadId }, data: { unread: false } });
    await completeRun(fixture, [{ kind: "text", text: "Done." }]);
    expect((await prisma.thread.findUniqueOrThrow({ where: { id: ids.threadId } })).unread).toBe(
      false,
    );
  });

  it("opens cards in the order the model gave them", async () => {
    const fixture = await runningRun();
    const labels = ["First", "Second", "Third", "Fourth"];
    await replaceHeldActionOffers(prisma, {
      ...ids,
      runId: fixture.run.id,
      offers: labels.map((label) => ({
        kind: "task" as const,
        label,
        task: label,
        expiresAt: soon(),
      })),
      close: [],
    });
    const result = await completeRun(fixture, [{ kind: "text", text: "Done." }]);
    expect(result.publishedOffers?.map((offer) => offer.label)).toEqual(labels);
    const reply = await prisma.message.findUniqueOrThrow({
      where: { id: result.publishedOffers![0]!.messageId },
    });
    const block = (reply.blocks as MessageBlock[]).find((item) => item.kind === "action_offer");
    expect(block?.kind === "action_offer" && block.offers.map((offer) => offer.label)).toEqual(
      labels,
    );
  });

  it("drops cards of an archived bot and of an archived group", async () => {
    const [botCard] = await openCards(["Bot card"]);
    await prisma.bot.update({ where: { id: ids.botId }, data: { archivedAt: new Date() } });
    try {
      expect(
        (await listOpenActionOffers(prisma, ids, new Date())).some(
          (item) => item.id === botCard!.id,
        ),
      ).toBe(false);
      expect((await countOpenActionOffers(prisma, ids, new Date())).byBot.has(ids.botId)).toBe(
        false,
      );
    } finally {
      await prisma.bot.update({ where: { id: ids.botId }, data: { archivedAt: null } });
    }
    const group = await prisma.chatGroup.create({
      data: { spaceId: ids.spaceId, userId: ids.userId, name: "Trip" },
    });
    const thread = await prisma.thread.create({
      data: { spaceId: ids.spaceId, userId: ids.userId, groupId: group.id },
    });
    const { run } = await runningRun();
    const message = await createThreadMessage(prisma, {
      threadId: thread.id,
      role: "bot",
      botId: ids.botId,
      runId: run.id,
      blocks: [{ kind: "text", text: "Plan." }],
    });
    const card = await prisma.actionOffer.create({
      data: {
        ...ids,
        threadId: thread.id,
        runId: run.id,
        messageId: message.id,
        kind: "task",
        label: "Group card",
        task: "Do it.",
        status: "open",
        expiresAt: soon(),
      },
    });
    expect((await countOpenActionOffers(prisma, ids, new Date())).byGroup.get(group.id)).toBe(1);
    expect(
      (await listOpenActionOffers(prisma, ids, new Date())).some((item) => item.id === card.id),
    ).toBe(true);
    await prisma.chatGroup.update({ where: { id: group.id }, data: { archivedAt: new Date() } });
    expect((await countOpenActionOffers(prisma, ids, new Date())).byGroup.has(group.id)).toBe(
      false,
    );
    expect(
      (await listOpenActionOffers(prisma, ids, new Date())).some((item) => item.id === card.id),
    ).toBe(false);
  });

  it("counts a claimed webhook or channel message as outside steering", async () => {
    const run = (await runningRun()).run;
    const plain = await createThreadMessage(prisma, {
      threadId: ids.threadId,
      role: "user",
      blocks: [{ kind: "text", text: "hello" }],
    });
    const claimedRow = await prisma.steeringMessage.create({
      data: {
        messageId: plain.id,
        botId: ids.botId,
        userId: ids.userId,
        runId: run.id,
        claimedAt: new Date(),
        originTrigger: "webhook",
      },
    });
    expect(await runTookOutsideSteering(prisma, run.id)).toBe(true);
    await prisma.steeringMessage.delete({ where: { id: claimedRow.id } });
    const channel = await createThreadMessage(prisma, {
      threadId: ids.threadId,
      role: "user",
      blocks: [
        {
          kind: "channel_message",
          provider: "sendblue",
          channelId: "chan-1",
          fromAddress: "+15550000000",
          fromLabel: "Sam",
          text: "hi",
        },
      ],
    });
    await prisma.steeringMessage.create({
      data: {
        messageId: channel.id,
        botId: ids.botId,
        userId: ids.userId,
        runId: run.id,
        claimedAt: new Date(),
      },
    });
    expect(await runTookOutsideSteering(prisma, run.id)).toBe(true);
  });

  it("does not make a follow-up of a batch that mixes a queued card with a messaging row", async () => {
    const busy = await runningRun();
    for (const [text, originTrigger] of [
      ["Book it.", ACTION_OFFER_STEERING_ORIGIN],
      ["Also this.", "messaging"],
    ] as const) {
      const message = await createThreadMessage(prisma, {
        threadId: ids.threadId,
        role: "user",
        blocks: [{ kind: "text", text }],
      });
      await prisma.steeringMessage.create({
        data: {
          messageId: message.id,
          botId: ids.botId,
          userId: ids.userId,
          runId: null,
          originTrigger,
        },
      });
    }
    const result = await completeRun(busy, [{ kind: "text", text: "Done." }]);
    const next = result.continuationRunId
      ? await prisma.run.findUniqueOrThrow({ where: { id: result.continuationRunId } })
      : null;
    expect(next?.trigger).not.toBe("follow_up");
  });
});
