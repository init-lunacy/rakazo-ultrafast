import { describe, expect, it } from "vitest";
import { UpdateBotInput } from "./index.js";

describe("UpdateBotInput page decider", () => {
  it("accepts setting or clearing the decider on its own", () => {
    expect(
      UpdateBotInput.safeParse({
        botId: "bot-1",
        pageDeciderProvider: "jev",
        pageDeciderModel: "jev-latest",
      }).success,
    ).toBe(true);
    expect(
      UpdateBotInput.safeParse({
        botId: "bot-1",
        pageDeciderProvider: null,
        pageDeciderModel: null,
      }).success,
    ).toBe(true);
  });

  // The check must run when the bot's own model is not part of the update.
  it("rejects a provider without a model", () => {
    expect(UpdateBotInput.safeParse({ botId: "bot-1", pageDeciderProvider: "jev" }).success).toBe(
      false,
    );
  });
});
