import { sendReply } from "./reply.ts";
import { addReaction } from "./react.ts";
import { joinVoiceChannel } from "./voice-join.ts";
import { leaveVoiceChannel } from "./voice-leave.ts";
import { sayInVoice } from "./voice-say.ts";

export interface ClaudeTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler(args: Record<string, unknown>): Promise<unknown>;
}

export const discordTools: ClaudeTool[] = [
  {
    name: "discord.reply",
    description: "Send a Discord message to a channel, chunking text and optionally attaching files.",
    parameters: {
      type: "object",
      required: ["channelId", "text"],
      properties: {
        channelId: { type: "string" },
        text: { type: "string" },
        attachments: {
          type: "array",
          items: {
            anyOf: [
              { type: "string" },
              {
                type: "object",
                required: ["path"],
                properties: {
                  path: { type: "string" },
                  name: { type: "string" },
                },
              },
            ],
          },
        },
      },
    },
    handler: (args) =>
      sendReply(
        String(args.channelId),
        String(args.text ?? ""),
        Array.isArray(args.attachments) ? args.attachments as any[] : [],
      ),
  },
  {
    name: "discord.react",
    description: "Add an emoji reaction to a Discord message.",
    parameters: {
      type: "object",
      required: ["channelId", "messageId", "emoji"],
      properties: {
        channelId: { type: "string" },
        messageId: { type: "string" },
        emoji: { type: "string" },
      },
    },
    handler: (args) =>
      addReaction(String(args.channelId), String(args.messageId), String(args.emoji)),
  },
  {
    name: "discord.voice_join",
    description: "Join a voice channel in a guild.",
    parameters: {
      type: "object",
      required: ["guildId", "channelId"],
      properties: {
        guildId: { type: "string" },
        channelId: { type: "string" },
      },
    },
    handler: (args) =>
      joinVoiceChannel(String(args.guildId), String(args.channelId)),
  },
  {
    name: "discord.voice_leave",
    description: "Leave the active voice channel for a guild and flush transcript.",
    parameters: {
      type: "object",
      required: ["guildId"],
      properties: {
        guildId: { type: "string" },
      },
    },
    handler: (args) => leaveVoiceChannel(String(args.guildId)),
  },
  {
    name: "discord.voice_say",
    description: "Speak text into the current voice channel for a guild.",
    parameters: {
      type: "object",
      required: ["guildId", "text"],
      properties: {
        guildId: { type: "string" },
        text: { type: "string" },
      },
    },
    handler: (args) => sayInVoice(String(args.guildId), String(args.text ?? "")),
  },
];

export async function callDiscordTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tool = discordTools.find((item) => item.name === name);
  if (!tool) throw new Error(`unknown tool: ${name}`);
  return tool.handler(args);
}
