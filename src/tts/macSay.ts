/**
 * macOS `say` command backend — free, on-device, instant.
 *
 * Voice: MAC_SAY_VOICE (default Kanya = Thai). Upgrade to Premium Kanya:
 *   System Settings → Accessibility → Spoken Content → System Voice
 *   → Manage Voices → Thai → Kanya (Premium) → Download
 *
 * Output: WAV 16-bit mono @ MAC_SAY_SAMPLE_RATE (default 24000) — matches
 * the Google TTS shape so downstream playback code is unchanged.
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { TtsFile } from "./types.ts";

const TMP_DIR = join(homedir(), ".claude", "channels", "codey", "voice-tmp");

/**
 * Apple speech markup tags injected at the start of text to shape Kanya's
 * voice. Tags affect everything that follows (single utterance scope).
 *   [[pbas N]]  pitch baseline (default ~50; higher = more high-pitched)
 *   [[pmod N]]  pitch modulation (variation/expressiveness; 1.0 default)
 *   [[volm N]]  volume (0.0-1.0)
 * Apple `say` ignores unknown tags silently, so this is safe for non-Apple
 * voices too — `say` for non-supporting voices just drops them.
 */
function buildPrefix(): string {
  const parts: string[] = [];
  const pbas = process.env.MAC_SAY_PITCH;
  const pmod = process.env.MAC_SAY_MODULATION;
  const volm = process.env.MAC_SAY_VOLUME;
  if (pbas) parts.push(`[[pbas ${pbas}]]`);
  if (pmod) parts.push(`[[pmod ${pmod}]]`);
  if (volm) parts.push(`[[volm ${volm}]]`);
  return parts.join(" ");
}

export async function synthesizeMacSay(
  text: string,
  voiceOverride?: string,
): Promise<TtsFile> {
  const voice = voiceOverride || process.env.MAC_SAY_VOICE || "Kanya";
  const rate = Number(process.env.MAC_SAY_RATE) || 0;
  const sampleRate = Number(process.env.MAC_SAY_SAMPLE_RATE) || 24000;

  mkdirSync(TMP_DIR, { recursive: true });
  const outPath = join(TMP_DIR, `tts_${Date.now()}.wav`);

  const prefix = buildPrefix();
  const spoken = prefix ? `${prefix} ${text}` : text;

  const args = [
    "-v", voice,
    "--file-format=WAVE",
    `--data-format=LEI16@${sampleRate}`,
    "-o", outPath,
  ];
  if (rate > 0) args.push("-r", String(rate));
  args.push(spoken);

  await new Promise<void>((resolve, reject) => {
    const proc = spawn("say", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`say exit ${code}: ${stderr.slice(0, 200)}`));
    });
  });

  return outPath;
}
