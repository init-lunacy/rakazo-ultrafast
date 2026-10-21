import { ORPCError } from "@orpc/server";
import type { JobPublisher } from "@rakazo/adapter-kit";
import type { ActionOfferStatus, Actor } from "@rakazo/contracts";
import { effectiveOfferStatus } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  ActionOfferConflictError,
  lockActionOfferInTransaction,
  mirrorActionOffersInTransaction,
} from "@rakazo/db";
import type { ThreadTarget } from "./thread-target.js";
import { sendThreadMessage } from "./thread-target.js";

export type ActionOfferForTake = {
  id: string;
  spaceId: string;
  threadId: string;
  botId: string;
  task: string;
  messageId: string;
  groupId: string | null;
};

/**
 * Claims the card, sends its task, and records the result in one transaction. A tap that
 * races the first replays the same message through the nonce; every later tap is refused.
 * A busy bot gets the task queued behind its run; a bot waiting for the user refuses it.
 */
export async function takeActionOffer(
  deps: { prisma: PrismaClient; events: ThreadEvents; jobs: JobPublisher },
  actor: Actor,
  target: ThreadTarget,
  offer: ActionOfferForTake,
): Promise<{ runId?: string }> {
  const now = new Date();
  // A tap after the card closed is refused here; without this, the nonce would replay the
  // earlier tap's message. Only taps racing the winning one reach the replay below.
  const current = await deps.prisma.actionOffer.findUniqueOrThrow({
    where: { id: offer.id },
    select: { status: true, expiresAt: true },
  });
  const status = effectiveOfferStatus(
    current as { status: ActionOfferStatus; expiresAt: Date },
    now,
  );
  if (status !== "open") throw cardClosed(status);
  let started: { runId?: string } | undefined;
  try {
    await sendThreadMessage(
      deps,
      actor,
      target,
      { text: offer.task, replyToMessageId: offer.messageId, clientNonce: offer.id },
      // A take never sends into a takeover (it refuses one), so nothing is released.
      undefined,
      {
        fullReplyContext: true,
        queueBehindActiveRun: true,
        ...(offer.groupId ? { targetBotIds: [offer.botId] } : {}),
        beforeSend: async (tx) => {
          const { status } = await lockActionOfferInTransaction(tx, {
            offerId: offer.id,
            spaceId: actor.spaceId,
            userId: actor.userId,
            now,
          });
          if (status !== "open") throw new ActionOfferConflictError(status);
          await tx.actionOffer.update({ where: { id: offer.id }, data: { status: "taken" } });
        },
        afterSend: async (tx, sent) => {
          const runId = sent.queued ? undefined : sent.runIds[0];
          if (runId) {
            await tx.actionOffer.update({ where: { id: offer.id }, data: { takenRunId: runId } });
          }
          await mirrorActionOffersInTransaction(tx, {
            spaceId: offer.spaceId,
            threadId: offer.threadId,
            botId: offer.botId,
            updates: new Map([
              [offer.id, { status: "taken" as const, takenMessageId: sent.messageId }],
            ]),
          });
          started = runId ? { runId } : {};
        },
      },
    );
  } catch (error) {
    if (error instanceof ActionOfferConflictError) throw cardClosed(error.status);
    throw error;
  }
  if (started) return started;
  // A racing tap replayed the winner's message without running the hooks.
  const taken = await deps.prisma.actionOffer.findUniqueOrThrow({
    where: { id: offer.id },
    select: { takenRunId: true },
  });
  return taken.takenRunId ? { runId: taken.takenRunId } : {};
}

function cardClosed(status: ActionOfferStatus) {
  return new ORPCError("CONFLICT", {
    message: `This card is ${status}.`,
    data: { reason: "card_closed", status },
  });
}
