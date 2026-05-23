import { AttachmentBuilder, type MessageCreateOptions } from "discord.js";
import { statSync } from "node:fs";
import { splitMessage } from "../text/chunker.ts";
import { getDiscordToolContext } from "./context.ts";

const MAX_FILES = 10;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

interface SendableChannel {
  send(options: string | MessageCreateOptions): Promise<unknown>;
}

export interface ReplyAttachment {
  path: string;
  name?: string;
}

export async function sendReply(
  channelId: string,
  text: string,
  attachments: Array<string | ReplyAttachment> = [],
): Promise<{ sent: number }> {
  const { client } = getDiscordToolContext();
  const channel = await client.channels.fetch(channelId);
  if (!channel || !("send" in channel)) {
    throw new Error(`channel ${channelId} is not sendable`);
  }

  const files = buildAttachments(attachments);
  const chunks = splitMessage(text || " ");
  let sent = 0;
  for (let i = 0; i < chunks.length; i++) {
    await (channel as SendableChannel).send({
      content: chunks[i],
      files: i === 0 ? files : [],
    });
    sent++;
  }
  if (chunks.length === 0 && files.length > 0) {
    await (channel as SendableChannel).send({ files });
    sent++;
  }
  return { sent };
}

function buildAttachments(
  attachments: Array<string | ReplyAttachment>,
): AttachmentBuilder[] {
  return attachments.slice(0, MAX_FILES).map((attachment) => {
    const item =
      typeof attachment === "string" ? { path: attachment } : attachment;
    const stat = statSync(item.path);
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(`attachment exceeds 25MB: ${item.path}`);
    }
    return new AttachmentBuilder(item.path, item.name ? { name: item.name } : undefined);
  });
}
