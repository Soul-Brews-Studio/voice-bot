import type { Message, Snowflake } from "discord.js";

export async function reactToMessage(
  message: Message,
  emoji: string | Snowflake,
): Promise<void> {
  await message.react(emoji);
}
