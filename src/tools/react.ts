import { getDiscordToolContext } from "./context.ts";

export async function addReaction(
  channelId: string,
  messageId: string,
  emoji: string,
): Promise<{ reacted: true }> {
  const { client } = getDiscordToolContext();
  const channel = await client.channels.fetch(channelId);
  if (!channel || !("messages" in channel)) {
    throw new Error(`channel ${channelId} does not expose messages`);
  }
  const message = await channel.messages.fetch(messageId);
  await message.react(emoji);
  return { reacted: true };
}
