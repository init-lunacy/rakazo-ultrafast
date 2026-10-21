import { describe, expect, it } from "vitest";
import { DEFAULT_ACTION_OFFER_SETTINGS, MessageBlock, parseActionOfferSettings } from "./index.js";
import { appContract } from "./rpc.js";

describe("action offer settings", () => {
  it("fills every default when nothing is stored", () => {
    expect(parseActionOfferSettings(null)).toEqual({
      enabled: true,
      perReply: 3,
      openPerChat: 6,
      defaultLifetimeDays: 3,
      saveSkillMinSteps: 3,
    });
    expect(DEFAULT_ACTION_OFFER_SETTINGS.perReply).toBe(3);
  });

  it("keeps valid stored values and replaces only invalid ones", () => {
    expect(parseActionOfferSettings({ perReply: 7, openPerChat: 99, enabled: false })).toEqual({
      enabled: false,
      perReply: 7,
      openPerChat: 6,
      defaultLifetimeDays: 3,
      saveSkillMinSteps: 3,
    });
  });

  it("lets preferences.update carry a partial settings patch on its own", () => {
    const input = appContract.preferences.update["~orpc"].inputSchema!;
    expect(input.safeParse({ actionOfferSettings: { perReply: 2 } }).success).toBe(true);
    expect(input.safeParse({ actionOfferSettings: { perReply: 11 } }).success).toBe(false);
    expect(input.safeParse({}).success).toBe(false);
  });
});

describe("action_offer block", () => {
  it("accepts cards and rejects an unknown status", () => {
    const card = {
      id: "offer-1",
      kind: "task",
      label: "Book the hotel",
      task: "Book the Lisbon hotel we compared.",
      expiresAt: "2026-10-24T10:00:00.000Z",
      status: "open",
    };
    expect(MessageBlock.safeParse({ kind: "action_offer", offers: [card] }).success).toBe(true);
    expect(
      MessageBlock.safeParse({ kind: "action_offer", offers: [{ ...card, status: "gone" }] })
        .success,
    ).toBe(false);
  });
});
