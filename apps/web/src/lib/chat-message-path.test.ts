import { expect, it } from "vitest";
import { chatMessagePath } from "./chat-message-path";

it("opens a bot or group chat at a message", () => {
  expect(chatMessagePath({ botId: "b1", groupId: null, messageId: "m1" })).toBe("/app/b1?m=m1");
  expect(chatMessagePath({ botId: "b1", groupId: "g 1", messageId: "m1" })).toBe(
    "/app/g/g%201?m=m1",
  );
});
