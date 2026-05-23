import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type ChatInputCommandInteraction,
  type ClientOptions,
  type Interaction,
  type Message,
} from "discord.js";
import "sodium-native";
import type { ClaudeBridge } from "./claude-bridge.ts";
import { handleMentionMessage } from "../text/message-handler.ts";

export interface DiscordClientHandlers {
  bridge?: ClaudeBridge;
  onReady?: (client: Client<true>) => void | Promise<void>;
  onInteraction?: (interaction: Interaction) => void | Promise<void>;
}

export function createDiscordClient(options: Partial<ClientOptions> = {}): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.GuildMember],
    ...options,
  });
}

export const client = createDiscordClient();

export function installDiscordEventHandlers(
  discordClient: Client,
  handlers: DiscordClientHandlers,
): void {
  discordClient.once(Events.ClientReady, async (readyClient) => {
    await handlers.onReady?.(readyClient);
  });

  discordClient.on(Events.MessageCreate, async (message: Message) => {
    if (!handlers.bridge) return;
    if (!isMentionForClient(message, discordClient)) return;
    try {
      await handleMentionMessage(message, handlers.bridge);
    } catch (error: any) {
      console.warn(`[discord-client] mention handling failed: ${error?.message ?? error}`);
    }
  });

  discordClient.on(Events.InteractionCreate, async (interaction: Interaction) => {
    await handlers.onInteraction?.(interaction);
  });
}

function isMentionForClient(message: Message, discordClient: Client): boolean {
  if (message.author.bot) return false;
  const selfId = discordClient.user?.id;
  if (!selfId) return false;
  return message.mentions.users.has(selfId);
}

export type { ChatInputCommandInteraction };
