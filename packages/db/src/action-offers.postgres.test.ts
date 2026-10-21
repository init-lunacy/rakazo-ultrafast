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
import { createThreadMessage } from "./messages.js";
import { provisionMessagingIdentity } from "./messaging.js";

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
    const counts = await countOpenActionOffers(prisma, ids, now);
    const [fresh] = await openCards(["Fresh"]);
    const after = await countOpenActionOffers(prisma, ids, new Date());
    expect(after.byBot.get(ids.botId)).toBe((counts.byBot.get(ids.botId) ?? 0) + 1);
    expect(fresh).toBeDefined();
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
});
