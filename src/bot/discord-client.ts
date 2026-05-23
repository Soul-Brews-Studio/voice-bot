import {
  Client,
  GatewayIntentBits,
  Partials,
  type ClientOptions,
} from "discord.js";
import "sodium-native";

export function createDiscordClient(options: Partial<ClientOptions> = {}): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
    ...options,
  });
}
