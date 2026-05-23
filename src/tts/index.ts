/**
 * TTS router for v2.
 *
 * Phase 0 keeps Edge TTS as the only active backend. Additional voice profile
 * routing can be layered back in once the bot process owns per-bot config.
 */
import { unlinkSync } from "node:fs";
import { synthesizeEdge, type TtsFile } from "./edge.ts";
import {
  getActiveVoice,
  setActiveVoice,
  type VoiceProfile,
} from "../voice-config.ts";

export type TtsBackend = "edge";

export async function synthesize(
  text: string,
  voiceProfile?: VoiceProfile,
): Promise<TtsFile> {
  if (!text.trim()) throw new Error("synthesizeTts: empty text");
  const voice = voiceProfile ? setActiveVoice(voiceProfile) : getActiveVoice();
  if (voice.backend !== "edge") {
    console.warn(
      `[tts] voice profile '${voiceProfile ?? "active"}' uses ${voice.backend}; falling back to Edge TTS default`,
    );
    return synthesizeEdge(text);
  }
  return synthesizeEdge(text, voice.voice);
}

export function synthesizeTts(
  text: string,
  voiceProfile?: VoiceProfile,
): Promise<TtsFile> {
  return synthesize(text, voiceProfile);
}

export function deleteTtsFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

export function ttsBackend(): TtsBackend {
  return "edge";
}

export type { TtsFile };
