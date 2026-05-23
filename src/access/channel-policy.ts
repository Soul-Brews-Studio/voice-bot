import { loadAccessConfig } from "./allowlist.ts";

export function isChannelEnabled(guildId: string, channelId: string): boolean {
  const channel = loadAccessConfig().guilds[guildId]?.channels?.[channelId];
  return channel?.enabled ?? true;
}

export function requiresMention(guildId: string, channelId: string): boolean {
  const channel = loadAccessConfig().guilds[guildId]?.channels?.[channelId];
  return channel?.requiresMention ?? true;
}
