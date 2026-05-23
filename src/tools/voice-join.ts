import { getDiscordToolContext } from "./context.ts";

export function joinVoiceChannel(
  guildId: string,
  channelId: string,
): Promise<unknown> {
  return getDiscordToolContext().joinVoice(guildId, channelId);
}
