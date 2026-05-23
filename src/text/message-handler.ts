import type { Client, Message } from "discord.js";
import type { ClaudeBridge } from "../bot/claude-bridge.ts";
import { accessPolicy, isAllowed, isOwner } from "../access/allowlist.ts";
import { isChannelEnabled, requiresMention } from "../access/channel-policy.ts";
import { confirmPair, requestPair } from "../access/pairing.ts";
import { splitMessage } from "./chunker.ts";

export interface MessageHandlerOptions {
  bridge: ClaudeBridge;
  client: Client;
}

export async function handleMessage(
  message: Message,
  options: MessageHandlerOptions,
): Promise<void> {
  if (message.author.bot) return;

  if (tryConfirmPair(message)) {
    await message.reply("Pairing confirmed. User is now allowed.");
    return;
  }

  const mentioned = isMentionForClient(message, options.client);
  if (message.guild) {
    if (!isChannelEnabled(message.guild.id, message.channel.id)) return;
    if (requiresMention(message.guild.id, message.channel.id) && !mentioned) return;
  }

  if (!isAllowed(message.author.id)) {
    await handleUnauthorized(message);
    return;
  }

  const prompt = stripBotMention(message.content, options.client).trim();
  if (!prompt) return;

  try {
    const reply = await options.bridge.ask(prompt);
    for (const chunk of splitMessage(reply)) {
      await message.reply(chunk);
    }
  } catch (error: any) {
    console.warn(`[text] Claude reply failed: ${error?.message ?? error}`);
    await message.reply(`Error: ${error?.message ?? "Claude reply failed"}`);
  }
}

export async function handleMentionMessage(
  message: Message,
  bridge: ClaudeBridge,
  client?: Client,
): Promise<void> {
  const resolvedClient = client ?? message.client;
  await handleMessage(message, { bridge, client: resolvedClient });
}

function tryConfirmPair(message: Message): boolean {
  if (!isOwner(message.author.id)) return false;
  const match = message.content.trim().match(/^(?:pair|confirm)\s+([A-Z0-9]{6})$/i);
  if (!match) return false;
  return confirmPair(match[1]!, message.author.id);
}

async function handleUnauthorized(message: Message): Promise<void> {
  if (accessPolicy() === "disabled") return;
  const code = requestPair(message.author.id);
  await message.reply(
    `Access required. Pairing code: ${code}. Ask an owner to send \`pair ${code}\`.`,
  );
}

function isMentionForClient(message: Message, client: Client): boolean {
  const selfId = client.user?.id;
  if (!selfId) return false;
  return message.mentions.users.has(selfId);
}

function stripBotMention(text: string, client: Client): string {
  const selfId = client.user?.id;
  if (!selfId) return text;
  return text
    .replace(new RegExp(`<@!?${selfId}>`, "g"), "")
    .trim();
}
