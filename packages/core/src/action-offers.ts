import type { ActionOfferCard, ActionOfferStatus, MessageBlock } from "@rakazo/contracts";

export type ActionOfferCardUpdate = Partial<
  Pick<ActionOfferCard, "status" | "expiresAt" | "takenMessageId">
>;

/** An open card past its expiry is expired, wherever it is read; no job writes it. */
export function effectiveOfferStatus(
  card: { status: ActionOfferStatus; expiresAt: string | Date },
  now: Date,
): ActionOfferStatus {
  if (card.status !== "open") return card.status;
  return new Date(card.expiresAt).getTime() <= now.getTime() ? "expired" : "open";
}

/** Copy of blocks with the named cards updated; untouched blocks keep their identity. */
export function withOfferUpdates(
  blocks: MessageBlock[],
  updates: ReadonlyMap<string, ActionOfferCardUpdate>,
): MessageBlock[] {
  return blocks.map((block) =>
    block.kind === "action_offer" && block.offers.some((offer) => updates.has(offer.id))
      ? {
          ...block,
          offers: block.offers.map((offer) => ({ ...offer, ...updates.get(offer.id) })),
        }
      : block,
  );
}

/** Later turns see what the bot offered, with ids it can name to close a card. */
export function actionOfferHistoryText(offers: readonly ActionOfferCard[]): string {
  // A label cannot end the line or add a card of its own.
  const entries = offers.map((offer) => `${offer.id} ${offer.label.replace(/[[\];]/g, "")}`);
  return `[offered: ${entries.join("; ")}]`;
}

export function offerPushBody(labels: readonly string[]): string {
  const [first = "", ...rest] = labels;
  return rest.length > 0 ? `${first} and ${rest.length} more` : first;
}

/** The Actions entry's count: every open card across the user's bot and group chats. */
export function openOfferTotal(
  bots: ReadonlyArray<{ openOfferCount?: number }>,
  groups: ReadonlyArray<{ openOfferCount?: number }>,
): number {
  return [...bots, ...groups].reduce((sum, chat) => sum + (chat.openOfferCount ?? 0), 0);
}
