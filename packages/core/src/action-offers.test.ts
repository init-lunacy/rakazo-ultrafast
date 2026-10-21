import type { ActionOfferCard, MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { blocksToAgentHistoryText } from "./attachments.js";
import {
  actionOfferHistoryText,
  effectiveOfferStatus,
  offerPushBody,
  openOfferTotal,
  withOfferUpdates,
} from "./action-offers.js";
import { aiDataUsesForProcedure } from "./ai-consent.js";
import { replyBlockText } from "./message-quote.js";

const card: ActionOfferCard = {
  id: "offer-1",
  kind: "task",
  label: "Book the hotel",
  task: "Book it.",
  expiresAt: "2026-10-24T10:00:00.000Z",
  status: "open",
};

describe("action offers", () => {
  it("reads an open card past its expiry as expired, and leaves other states alone", () => {
    const before = new Date("2026-10-24T09:59:59.000Z");
    const after = new Date("2026-10-24T10:00:00.000Z");
    expect(effectiveOfferStatus(card, before)).toBe("open");
    expect(effectiveOfferStatus(card, after)).toBe("expired");
    expect(effectiveOfferStatus({ ...card, status: "taken" }, after)).toBe("taken");
  });

  it("mirrors updates into the matching card and nothing else", () => {
    const blocks: MessageBlock[] = [
      { kind: "text", text: "Found two hotels." },
      { kind: "action_offer", offers: [card, { ...card, id: "offer-2" }] },
    ];
    const next = withOfferUpdates(blocks, new Map([["offer-2", { status: "taken" }]]));
    const offers = next[1]?.kind === "action_offer" ? next[1].offers : [];
    expect(offers.map((offer) => offer.status)).toEqual(["open", "taken"]);
    expect(next[0]).toBe(blocks[0]);
  });

  it("tells later turns what was offered, by id, and quotes by label", () => {
    const block: MessageBlock = { kind: "action_offer", offers: [card] };
    expect(actionOfferHistoryText([card])).toBe("[offered: offer-1 Book the hotel]");
    expect(blocksToAgentHistoryText([block])).toBe("[offered: offer-1 Book the hotel]");
    expect(replyBlockText(block)).toBe("Book the hotel");
  });

  it("summarises several cards in one push line", () => {
    expect(offerPushBody(["Book the hotel"])).toBe("Book the hotel");
    expect(offerPushBody(["Book the hotel", "Check flights", "Save as a skill"])).toBe(
      "Book the hotel and 2 more",
    );
  });

  it("adds up open cards across bots and groups", () => {
    expect(openOfferTotal([{ openOfferCount: 2 }, {}], [{ openOfferCount: 1 }])).toBe(3);
    expect(openOfferTotal([], [])).toBe(0);
  });

  it("asks for AI consent before a take starts a run", () => {
    expect(aiDataUsesForProcedure("actionOffers/take")).toEqual(["model", "memory"]);
  });
});
