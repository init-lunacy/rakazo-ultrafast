/** Opens a bot or group chat at one message, through the chat's ?m= jump. */
export function chatMessagePath(target: {
  botId: string;
  groupId: string | null;
  messageId: string;
}): string {
  const chat = target.groupId
    ? `/app/g/${encodeURIComponent(target.groupId)}`
    : `/app/${encodeURIComponent(target.botId)}`;
  return `${chat}?m=${encodeURIComponent(target.messageId)}`;
}
