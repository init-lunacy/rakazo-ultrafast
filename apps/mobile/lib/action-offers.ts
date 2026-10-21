/** The thread route that jumps to a card's message, as search results do. */
export function offerRoute(item: { botId: string; groupId: string | null; messageId: string }) {
  return item.groupId
    ? {
        pathname: "/group-thread" as const,
        params: { groupId: item.groupId, messageId: item.messageId },
      }
    : {
        pathname: "/thread" as const,
        params: { botId: item.botId, messageId: item.messageId },
      };
}

/** Native menu choices for each number setting, all inside the contract's ranges. */
export const OFFER_SETTING_CHOICES = {
  perReply: [1, 2, 3, 5, 10],
  openPerChat: [3, 6, 10, 20],
  defaultLifetimeDays: [1, 3, 7, 14, 30],
  saveSkillMinSteps: [1, 3, 5, 10, 20],
} as const;
