/**
 * After a voice session ends, send the cleaned transcript .md file back to
 * the voice channel (which has an embedded text panel in the Discord UI).
 *
 * Called fire-and-forget after cleanTranscriptInBackground resolves so the
 * file already has hallucination cleanup applied. Falls back gracefully if
 * the channel is unavailable or not text-capable.
 */
import { basename } from "node:path";
import { existsSync } from "node:fs";
import { type Client, ChannelType } from "discord.js";

const ENABLED = process.env.TRANSCRIPT_SEND_TO_DISCORD !== "false"; // default ON
const DEFAULT_CHANNEL_ID = (process.env.TRANSCRIPT_DISCORD_CHANNEL_ID ?? "").trim();

export async function sendTranscriptToDiscord(
  client: Client,
  /** Voice channel ID (fallback if no replyChannelId) */
  voiceChannelId: string | undefined | null,
  filepath: string,
  channelName?: string,
  segmentCount?: number,
  /** Text channel where /yj was typed — preferred destination */
  replyChannelId?: string | null,
): Promise<void> {
  if (!ENABLED) {
    console.log("[discord-transcript] disabled (TRANSCRIPT_SEND_TO_DISCORD=false)");
    return;
  }
  // Priority: replyChannelId (where /yj was typed) → voice channel → env default
  const channelId = replyChannelId || voiceChannelId || DEFAULT_CHANNEL_ID || null;
  if (!channelId) {
    console.log("[discord-transcript] no target channel — skip (set TRANSCRIPT_DISCORD_CHANNEL_ID to configure default)");
    return;
  }
  if (!existsSync(filepath)) {
    console.warn(`[discord-transcript] file not found: ${filepath}`);
    return;
  }
  try {
    const ch = await client.channels.fetch(channelId);
    if (!ch || !ch.isTextBased()) {
      console.log(`[discord-transcript] channel ${channelId} not text-capable — skip`);
      return;
    }
    // PartialGroupDMChannel is text-based but lacks send() — exclude it.
    if (ch.type === ChannelType.GroupDM) {
      console.log(`[discord-transcript] GroupDM not supported — skip`);
      return;
    }
    const name = channelName ? `#${channelName}` : "voice";
    const segs = segmentCount != null ? ` · ${segmentCount} segments` : "";
    // PartialGroupDMChannel excluded above; all remaining text-based channels have send().
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (ch as any).send({
      content: `📄 **Transcript** — ${name}${segs} · Recorded by Codey 🌀`,
      files: [{ attachment: filepath, name: basename(filepath) }],
    });
    console.log(`[discord-transcript] ✅ sent ${basename(filepath)} → ${channelId}`);
  } catch (e: any) {
    console.warn(`[discord-transcript] failed: ${e?.message ?? e}`);
  }
}
