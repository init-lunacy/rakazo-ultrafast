import type {
  ActionOfferCard,
  ActionOfferKind,
  ActionOfferListItem,
  ActionOfferStatus,
  MessageBlock,
} from "@rakazo/contracts";
import type { ActionOfferCardUpdate } from "@rakazo/core";
import { effectiveOfferStatus, withOfferUpdates } from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";
import { appendEventInTransaction } from "./events.js";

export class ActionOfferNotFoundError extends Error {
  constructor() {
    super("Unknown action card");
  }
}

export class ActionOfferConflictError extends Error {
  constructor(readonly status: ActionOfferStatus) {
    super(`This card is ${status}.`);
  }
}

export type HeldActionOfferInput = {
  kind: ActionOfferKind;
  label: string;
  task: string;
  expiresAt: Date;
  skillSource?: Prisma.InputJsonValue;
};

/** Latest call wins: a run's held offers and close requests are replaced together. */
export async function replaceHeldActionOffers(
  prisma: PrismaClient,
  input: {
    spaceId: string;
    userId: string;
    threadId: string;
    botId: string;
    runId: string;
    offers: HeldActionOfferInput[];
    close: string[];
  },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // The same thread-then-rows lock order as finalizeRun.
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    await tx.actionOffer.deleteMany({ where: { runId: input.runId, status: "held" } });
    await tx.actionOffer.updateMany({
      where: { closingRunId: input.runId },
      data: { closingRunId: null },
    });
    if (input.offers.length > 0) {
      const createdAt = Date.now();
      await tx.actionOffer.createMany({
        // Explicit, increasing creation times keep the model's order through createMany.
        data: input.offers.map((offer, index) => ({
          spaceId: input.spaceId,
          userId: input.userId,
          threadId: input.threadId,
          botId: input.botId,
          runId: input.runId,
          kind: offer.kind,
          label: offer.label,
          task: offer.task,
          expiresAt: offer.expiresAt,
          createdAt: new Date(createdAt + index),
          ...(offer.skillSource === undefined ? {} : { skillSource: offer.skillSource }),
        })),
      });
    }
    if (input.close.length > 0) {
      await tx.actionOffer.updateMany({
        where: {
          id: { in: input.close },
          threadId: input.threadId,
          botId: input.botId,
          status: "open",
        },
        data: { closingRunId: input.runId },
      });
    }
  });
}

/** This bot's open, unexpired cards in one chat: the tool's cap and its result list. */
export async function openActionOffersInChat(
  prisma: PrismaClient,
  input: { threadId: string; botId: string; now: Date },
) {
  return prisma.actionOffer.findMany({
    where: {
      threadId: input.threadId,
      botId: input.botId,
      status: "open",
      expiresAt: { gt: input.now },
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, kind: true, label: true, task: true, expiresAt: true },
  }) as Promise<
    Array<{ id: string; kind: ActionOfferKind; label: string; task: string; expiresAt: Date }>
  >;
}

/** The actor's open, published cards in chats that are still live: the list and the counts. */
function openCardsWhere(
  actor: { spaceId: string; userId: string },
  now: Date,
): Prisma.ActionOfferWhereInput {
  return {
    spaceId: actor.spaceId,
    userId: actor.userId,
    status: "open",
    expiresAt: { gt: now },
    messageId: { not: null },
    bot: { archivedAt: null },
    thread: { OR: [{ groupId: null }, { group: { archivedAt: null } }] },
  };
}

export async function listOpenActionOffers(
  prisma: PrismaClient,
  actor: { spaceId: string; userId: string },
  now: Date,
): Promise<ActionOfferListItem[]> {
  const rows = await prisma.actionOffer.findMany({
    where: openCardsWhere(actor, now),
    orderBy: { createdAt: "desc" },
    include: { thread: { select: { groupId: true } } },
  });
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as ActionOfferKind,
    label: row.label,
    task: row.task,
    expiresAt: row.expiresAt.toISOString(),
    status: "open",
    botId: row.botId,
    groupId: row.thread.groupId,
    threadId: row.threadId,
    messageId: row.messageId!,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function countOpenActionOffers(
  prisma: PrismaClient,
  actor: { spaceId: string; userId: string },
  now: Date,
) {
  const rows = await prisma.actionOffer.findMany({
    where: openCardsWhere(actor, now),
    select: { botId: true, thread: { select: { groupId: true } } },
  });
  const byBot = new Map<string, number>();
  const byGroup = new Map<string, number>();
  for (const row of rows) {
    const groupId = row.thread.groupId;
    if (groupId) byGroup.set(groupId, (byGroup.get(groupId) ?? 0) + 1);
    else byBot.set(row.botId, (byBot.get(row.botId) ?? 0) + 1);
  }
  return { byBot, byGroup };
}

/** Write card updates into their messages' blocks and announce each message once. */
export async function mirrorActionOffersInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    spaceId: string;
    threadId: string;
    botId: string;
    updates: ReadonlyMap<string, ActionOfferCardUpdate>;
  },
): Promise<number | null> {
  if (input.updates.size === 0) return null;
  const rows = await tx.actionOffer.findMany({
    where: { id: { in: [...input.updates.keys()] }, messageId: { not: null } },
    select: { messageId: true },
  });
  let seq: number | null = null;
  for (const messageId of new Set(rows.map((row) => row.messageId!))) {
    const message = await tx.message.findUnique({ where: { id: messageId } });
    if (!message) continue;
    const blocks = withOfferUpdates(message.blocks as MessageBlock[], input.updates);
    await tx.message.update({ where: { id: messageId }, data: { blocks } });
    const event = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "thread.message.updated",
      payload: { messageId, role: "bot", blocks },
    });
    seq = event.seq;
  }
  return seq;
}

/** Loads the actor's card under its thread lock; an expired open card is written expired. */
export async function lockActionOfferInTransaction(
  tx: Prisma.TransactionClient,
  input: { offerId: string; spaceId: string; userId: string; now: Date },
) {
  const found = await tx.actionOffer.findFirst({
    where: { id: input.offerId, spaceId: input.spaceId, userId: input.userId },
    select: { threadId: true },
  });
  if (!found) throw new ActionOfferNotFoundError();
  await tx.$queryRaw`SELECT id FROM threads WHERE id = ${found.threadId} FOR UPDATE`;
  const offer = await tx.actionOffer.findUniqueOrThrow({ where: { id: input.offerId } });
  const status = effectiveOfferStatus(
    offer as { status: ActionOfferStatus; expiresAt: Date },
    input.now,
  );
  if (status === "expired" && offer.status === "open") {
    // The status column only: no block rewrite, so reads never fan out into writes.
    await tx.actionOffer.update({ where: { id: offer.id }, data: { status: "expired" } });
  }
  return { offer, status };
}

export async function dismissActionOffer(
  prisma: PrismaClient,
  input: { offerId: string; spaceId: string; userId: string; now: Date },
): Promise<{ status: ActionOfferStatus; threadId: string; seq?: number }> {
  return prisma.$transaction(async (tx) => {
    const { offer, status } = await lockActionOfferInTransaction(tx, input);
    if (status !== "open") return { status, threadId: offer.threadId };
    await tx.actionOffer.update({ where: { id: offer.id }, data: { status: "dismissed" } });
    const seq = await mirrorActionOffersInTransaction(tx, {
      spaceId: offer.spaceId,
      threadId: offer.threadId,
      botId: offer.botId,
      updates: new Map([[offer.id, { status: "dismissed" as const }]]),
    });
    return {
      status: "dismissed" as const,
      threadId: offer.threadId,
      ...(seq === null ? {} : { seq }),
    };
  });
}

/**
 * Called by finalizeRunOnce for a completed run, under its thread lock. Expired held
 * cards are dropped, exact task repeats extend the open card they repeat, cards the run
 * asked to close are closed, and the rest open. Their message is attached by the caller.
 */
export async function publishRunActionOffersInTransaction(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; threadId: string; botId: string; runId: string; now: Date },
): Promise<{ opened: ActionOfferCard[]; seq: number | null }> {
  await tx.actionOffer.deleteMany({
    where: { runId: input.runId, status: "held", expiresAt: { lte: input.now } },
  });
  const held = await tx.actionOffer.findMany({
    where: { runId: input.runId, status: "held" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const open = await tx.actionOffer.findMany({
    where: {
      threadId: input.threadId,
      botId: input.botId,
      status: "open",
      expiresAt: { gt: input.now },
    },
  });
  const updates = new Map<string, ActionOfferCardUpdate>();
  const opening = [];
  for (const offer of held) {
    // Save-skill cards share a fixed label and task but each carries its own run's source.
    const repeat = open.find(
      (card) =>
        offer.kind === "task" &&
        card.kind === "task" &&
        card.label === offer.label &&
        card.task === offer.task &&
        card.closingRunId !== input.runId,
    );
    if (!repeat) {
      opening.push(offer);
      continue;
    }
    const expiresAt = new Date(Math.max(repeat.expiresAt.getTime(), offer.expiresAt.getTime()));
    await tx.actionOffer.update({ where: { id: repeat.id }, data: { expiresAt } });
    await tx.actionOffer.delete({ where: { id: offer.id } });
    updates.set(repeat.id, { expiresAt: expiresAt.toISOString() });
  }
  for (const card of open.filter((card) => card.closingRunId === input.runId)) {
    await tx.actionOffer.update({
      where: { id: card.id },
      data: { status: "closed", closingRunId: null },
    });
    updates.set(card.id, { status: "closed" });
  }
  if (opening.length > 0) {
    await tx.actionOffer.updateMany({
      where: { id: { in: opening.map((offer) => offer.id) } },
      data: { status: "open" },
    });
  }
  const seq = await mirrorActionOffersInTransaction(tx, { ...input, updates });
  return {
    opened: opening.map((offer) => ({
      id: offer.id,
      kind: offer.kind as ActionOfferCard["kind"],
      label: offer.label,
      task: offer.task,
      expiresAt: offer.expiresAt.toISOString(),
      status: "open" as const,
    })),
    seq,
  };
}
