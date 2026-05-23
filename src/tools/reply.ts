import { chunkDiscordMessage } from "../text/chunker.ts";

export interface SendableChannel {
  send(content: string): Promise<unknown>;
}

export async function replyToChannel(
  channel: SendableChannel,
  content: string,
): Promise<void> {
  for (const chunk of chunkDiscordMessage(content)) {
    await channel.send(chunk);
  }
}
