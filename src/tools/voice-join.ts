import type { VoiceBasedChannel } from "discord.js";
import { VoiceSession } from "../voice/voice-session.ts";

export async function joinVoiceChannelWithSession(
  session: VoiceSession,
  channel: VoiceBasedChannel,
): Promise<void> {
  await session.connect({
    channelId: channel.id,
    guildId: channel.guild.id,
    channelName: channel.name,
    adapterCreator: channel.guild.voiceAdapterCreator,
    guild: channel.guild,
  });
}
