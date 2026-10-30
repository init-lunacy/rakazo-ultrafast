import { ORPCError } from "@orpc/server";
import { ActionOfferNotFoundError, dismissActionOffer, listOpenActionOffers } from "@rakazo/db";
import { takeActionOffer } from "../action-offers.js";
import type { RouterContext } from "./context.js";
import { prepareTurn } from "./shared.js";

export function actionOffersRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    actionOffers: {
      list: authed.actionOffers.list.handler(async ({ context }) =>
        listOpenActionOffers(deps.prisma, context.actor, new Date()),
      ),
      take: authed.actionOffers.take.handler(async ({ context, input }) => {
        const offer = await deps.prisma.actionOffer.findFirst({
          where: {
            id: input.offerId,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          },
          include: { thread: { select: { groupId: true } } },
        });
        if (!offer?.messageId) throw new ORPCError("NOT_FOUND", { message: "Unknown action card" });
        const groupId = offer.thread.groupId;
        const { target } = await prepareTurn(
          deps,
          context.actor,
          groupId ? { groupId } : { botId: offer.botId },
        );
        return takeActionOffer(deps, context.actor, target, {
          id: offer.id,
          spaceId: offer.spaceId,
          threadId: offer.threadId,
          botId: offer.botId,
          task: offer.task,
          messageId: offer.messageId,
          groupId,
        });
      }),
      dismiss: authed.actionOffers.dismiss.handler(async ({ context, input }) => {
        try {
          const dismissed = await dismissActionOffer(deps.prisma, {
            offerId: input.offerId,
            ...context.actor,
            now: new Date(),
          });
          if (dismissed.seq !== undefined) {
            await deps.events.notify(dismissed.threadId, dismissed.seq);
          }
          return { status: dismissed.status };
        } catch (error) {
          if (error instanceof ActionOfferNotFoundError) {
            throw new ORPCError("NOT_FOUND", { message: "Unknown action card" });
          }
          throw error;
        }
      }),
    },
  };
}
