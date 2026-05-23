import type { Client } from "discord.js";
import type { VoiceSession } from "../voice/voice-session.ts";
import type { VoiceProfile } from "../voice-config.ts";

export interface DiscordToolContext {
  client: Client;
  sessions: Map<string, VoiceSession>;
  voiceProfile?: VoiceProfile;
  joinVoice(guildId: string, channelId: string): Promise<unknown>;
  leaveVoice(guildId: string): Promise<unknown>;
  sayInVoice(guildId: string, text: string): Promise<unknown>;
}

let context: DiscordToolContext | undefined;

export function setDiscordToolContext(next: DiscordToolContext): void {
  context = next;
}

export function getDiscordToolContext(): DiscordToolContext {
  if (!context) {
    throw new Error("Discord tool context is not registered");
  }
  return context;
}
