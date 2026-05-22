/**
 * Edge TTS backend — free, cloud, Thai-native voices.
 *
 * Voices: th-TH-NiwatNeural (male), th-TH-PremwadeeNeural (female)
 * Requires: pip install edge-tts (already installed)
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { TtsFile } from "./types.ts";

const TMP_DIR = join(homedir(), ".claude", "channels", "codey", "voice-tmp");
const EDGE_TTS_BIN = process.env.EDGE_TTS_BIN || "edge-tts";

export async function synthesizeEdge(
  text: string,
  voiceOverride?: string,
): Promise<TtsFile> {
  const voice = voiceOverride || process.env.TTS_VOICE || "th-TH-PremwadeeNeural";

  mkdirSync(TMP_DIR, { recursive: true });
  const outPath = join(TMP_DIR, `tts_${Date.now()}.wav`);

  const mp3Path = outPath.replace(/\.wav$/, ".mp3");

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(EDGE_TTS_BIN, [
      "--voice", voice,
      "--text", text,
      "--write-media", mp3Path,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`edge-tts exit ${code}: ${stderr.slice(0, 200)}`));
    });
  });

  // Convert mp3 → wav (16-bit mono) for Discord audio player
  const sampleRate = Number(process.env.MAC_SAY_SAMPLE_RATE) || 24000;
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("ffmpeg", [
      "-y", "-i", mp3Path,
      "-ar", String(sampleRate),
      "-ac", "1",
      "-f", "wav",
      outPath,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(0, 200)}`));
    });
  });

  // Clean up mp3
  try { const { unlinkSync } = await import("node:fs"); unlinkSync(mp3Path); } catch {}

  return outPath;
}
