import { expect, it } from "vitest";
import { OFFER_SETTING_CHOICES, offerRoute } from "./action-offers.js";

it("opens a card's message in its bot or group thread", () => {
  expect(offerRoute({ botId: "b1", groupId: null, messageId: "m1" })).toEqual({
    pathname: "/thread",
    params: { botId: "b1", messageId: "m1" },
  });
  expect(offerRoute({ botId: "b1", groupId: "g1", messageId: "m1" })).toEqual({
    pathname: "/group-thread",
    params: { groupId: "g1", messageId: "m1" },
  });
});

it("offers native choices inside each setting's range", () => {
  expect(OFFER_SETTING_CHOICES.perReply).toEqual([1, 2, 3, 5, 10]);
  expect(Math.max(...OFFER_SETTING_CHOICES.openPerChat)).toBeLessThanOrEqual(20);
  expect(Math.max(...OFFER_SETTING_CHOICES.defaultLifetimeDays)).toBeLessThanOrEqual(30);
  expect(Math.max(...OFFER_SETTING_CHOICES.saveSkillMinSteps)).toBeLessThanOrEqual(50);
});
