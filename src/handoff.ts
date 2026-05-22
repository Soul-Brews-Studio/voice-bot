/**
 * Post-flush handoff:
 *   1. Copy transcript .md to ~/Downloads/codey-discord-voice/
 *   2. Notify Codey via `maw hey yoi` so the AI session can read + summarize
 *
 * Trigger points (anywhere session ends):
 *   - /voice-out via command-watcher
 *   - /codey leave slash command
 *   - auto-leave when alone in channel
 *   - SIGTERM/SIGINT graceful shutdown
 */
import { copyFile, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

const DOWNLOAD_DIR = join(homedir(), "Downloads", "codey-discord-voice");
const MAW_BIN = process.env.MAW_BIN || "maw";
const MAW_TARGET = process.env.MAW_TARGET || "codey";

export interface HandoffMeta {
  channelName?: string;
  chunkCount?: number;
  segmentCount?: number;
  durationMs?: number;
  participants?: string[];
  /** Formatted cost report (multi-line). Appended to maw notification. */
  costReport?: string;
  /** Discord text channel to send transcript after summary (from /yj slash). */
  replyChannelId?: string;
  /** Discord voice channel ID (fallback if no replyChannelId). */
  voiceChannelId?: string;
  /** Summary depth requested. "short" (default) = quick bullets. "long" = detailed sections. */
  summaryMode?: "short" | "long";
}

/**
 * Copy-only: keep the Downloads/codey-discord-voice/ mirror up to date.
 * Called on every flush() (incl. the empty one at join) so the file
 * appears in Downloads from the moment Codey joins + stays current.
 * Best-effort — failures logged but not thrown.
 */
export async function copyToDownloads(
  transcriptPath: string,
): Promise<string | null> {
  try {
    await mkdir(DOWNLOAD_DIR, { recursive: true });
    const dest = join(DOWNLOAD_DIR, basename(transcriptPath));
    await copyFile(transcriptPath, dest);
    return dest;
  } catch (e: any) {
    console.warn(`[handoff] copyToDownloads failed: ${e?.message ?? e}`);
    return null;
  }
}

export async function handoff(
  transcriptPath: string,
  meta: HandoffMeta = {},
): Promise<{ copied: string; notified: boolean }> {
  let copied = "";
  try {
    await mkdir(DOWNLOAD_DIR, { recursive: true });
    const dest = join(DOWNLOAD_DIR, basename(transcriptPath));
    await copyFile(transcriptPath, dest);
    copied = dest;
    console.log(`[handoff] copied transcript → ${dest}`);
  } catch (e: any) {
    console.warn(`[handoff] copy failed: ${e?.message ?? e}`);
  }

  const partsList = (meta.participants ?? []).join(", ") || "(none)";
  const durationSec = Math.floor((meta.durationMs ?? 0) / 1000);
  const lines = [
    `[voice-bot] session complete — channel="${meta.channelName ?? "voice"}"`,
    `duration=${durationSec}s chunks=${meta.chunkCount ?? 0} segments=${meta.segmentCount ?? 0}`,
    `participants=[${partsList}]`,
    `transcript=${copied || transcriptPath}`,
  ];
  if (meta.costReport) {
    lines.push("");
    lines.push("Cost (this session):");
    lines.push(meta.costReport);
  }
  // Discord send instruction — Claude session handles clean + summary + file send
  const discordChannelId = meta.replyChannelId || meta.voiceChannelId || "";
  const envPath = join(process.cwd(), ".env");
  const discordInstruction = discordChannelId
    ? `After saving the file, send it to Discord channel ID ${discordChannelId} using:\n` +
      `TOKEN=$(grep '^DISCORD_TOKEN=' ${envPath} | cut -d= -f2- | tr -d "\\"'") && ` +
      `curl -sS -X POST "https://discord.com/api/v10/channels/${discordChannelId}/messages" ` +
      `-H "Authorization: Bot $TOKEN" ` +
      `-F "payload_json={\\"content\\":\\"📄 **Transcript** — #${meta.channelName ?? "voice"} · ${meta.segmentCount ?? 0} segments · Recorded by Codey 🌀\\"}" ` +
      `-F "files[0]=@${copied || transcriptPath};filename=$(basename ${copied || transcriptPath})"`
    : "";

  lines.push("");
  const isLong = meta.summaryMode === "long";
  const summaryStep = isLong
    ? "2. Add a **DETAILED** Summary section (Thai) — no length cap. Sections required:\n" +
      "   • หัวข้อหลัก (Topics) — each topic in depth with sub-bullets, quotes, context\n" +
      "   • Decisions — every decision made, who decided, rationale if stated\n" +
      "   • Action items / TODOs — owner + deadline if mentioned\n" +
      "   • Key quotes — memorable lines, jokes, banter (verbatim, with speaker)\n" +
      "   • Speaker contributions — what each participant brought to the discussion\n" +
      "   • Open questions / unresolved threads\n" +
      "   Be thorough — this is a detailed-mode summary. Skip nothing material."
    : "2. Add a Summary section (Thai) with key topics / decisions / action items.";
  lines.push(
    "Please open the .md and:\n" +
    "1. Clean STT hallucinations (remove broadcast noise, lottery text, football betting CTAs, exact repetitions, gibberish). Keep real Thai speech even if rough.\n" +
    summaryStep + "\n" +
    (discordInstruction ? "3. " + discordInstruction : ""),
  );
  const msg = lines.join("\n");

  let notified = false;
  try {
    const child = spawn(MAW_BIN, ["hey", MAW_TARGET, msg, "--force"], {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    notified = true;
    console.log(`[handoff] notified Codey via maw hey ${MAW_TARGET}`);
  } catch (e: any) {
    console.warn(`[handoff] maw hey failed: ${e?.message ?? e}`);
  }

  return { copied, notified };
}
