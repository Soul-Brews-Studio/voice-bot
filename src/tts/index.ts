/**
 * TTS router for v2.
 *
 * Phase 0 keeps Edge TTS as the only active backend. Additional voice profile
 * routing can be layered back in once the bot process owns per-bot config.
 */
import { unlinkSync } from "node:fs";
import { synthesizeEdge, type TtsFile } from "./edge.ts";

export type TtsBackend = "edge";

export async function synthesizeTts(text: string): Promise<TtsFile> {
  if (!text.trim()) throw new Error("synthesizeTts: empty text");
  return synthesizeEdge(text);
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
