import type { Message } from "discord.js";
import type { ClaudeBridge } from "../bot/claude-bridge.ts";
import { chunkDiscordMessage } from "./chunker.ts";

export async function handleMentionMessage(
  message: Message,
  bridge: ClaudeBridge,
): Promise<void> {
  if (message.author.bot) return;
  const reply = await bridge.ask(message.content);
  for (const chunk of chunkDiscordMessage(reply)) {
    await message.reply(chunk);
  }
}
