/**
 * TTS dispatcher — picks backend from the runtime voice profile each call.
 *
 * Voice profile lives in src/voice-config.ts and can be flipped at runtime
 * via /codey voice <profile>. We resolve it per-call (NOT cached at module
 * load) so the next reply uses the new voice immediately — no restart.
 */
import { unlinkSync } from "node:fs";
import { getActiveVoice, getActiveProfile } from "../voice-config.ts";
import type { TtsFile } from "./types.ts";

export type TtsBackend = "mac-say" | "google" | "edge";

export async function synthesizeTts(text: string): Promise<TtsFile> {
  if (!text.trim()) throw new Error("synthesizeTts: empty text");
  const v = getActiveVoice();

  if (v.backend === "mac-say") {
    const { synthesizeMacSay } = await import("./macSay.ts");
    return synthesizeMacSay(text, v.voice);
  }
  if (v.backend === "edge") {
    const { synthesizeEdge } = await import("./edge.ts");
    return synthesizeEdge(text, v.voice);
  }
  if (v.backend === "google") {
    const { synthesizeGoogle } = await import("./google.ts");
    return synthesizeGoogle(text, v.voice, v.languageCode);
  }
  throw new Error(`[tts] unknown backend in profile: ${v.backend}`);
}

export function deleteTtsFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

/** Display name of the currently active backend (for cost reporting etc.). */
export function ttsBackend(): TtsBackend {
  return getActiveVoice().backend;
}

/** Re-export for status / cost messages. */
export { getActiveProfile, getActiveVoice };
export type { TtsFile };
