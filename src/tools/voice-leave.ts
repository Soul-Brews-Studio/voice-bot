import { getDiscordToolContext } from "./context.ts";

export function leaveVoiceChannel(guildId: string): Promise<unknown> {
  return getDiscordToolContext().leaveVoice(guildId);
}
