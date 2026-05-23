#!/usr/bin/env bun
import { Events } from "discord.js";
import { createDiscordClient } from "./discord-client.ts";
import { createRegistryClient } from "./register.ts";

export interface BotProcessOptions {
  botName?: string;
  token?: string;
}

export async function startBotProcess(options: BotProcessOptions = {}): Promise<void> {
  const botName = options.botName ?? process.env.BOT_NAME ?? "codey";
  const token = options.token ?? process.env.DISCORD_TOKEN;
  if (!token) {
    throw new Error("DISCORD_TOKEN is required to start the v2 bot process");
  }

  const client = createDiscordClient();
  const registry = createRegistryClient();

  client.once(Events.ClientReady, async (readyClient) => {
    const guildIds = readyClient.guilds.cache.map((guild) => guild.id);
    await registry.register({ botName, guildIds, status: "online" });
    console.log(`[voice-bot] ${botName} online as ${readyClient.user.tag}`);
  });

  process.once("SIGINT", () => {
    void registry.deregister(botName).finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void registry.deregister(botName).finally(() => process.exit(0));
  });

  await client.login(token);
}

if (import.meta.main) {
  startBotProcess().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
