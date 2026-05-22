/**
 * STT dispatcher — picks backend via STT_BACKEND env.
 *   - "whisper-cpp" (default): local whisper.cpp + Metal, free
 *   - "google":     Google Cloud Speech-to-Text v1, paid
 *
 * Post-process: every transcript is run through ./hallucinations.ts.
 * Hallucinated text → empty string (caller treats as silence, no segment).
 */
import { unlink } from "node:fs/promises";
import { isHallucination } from "./hallucinations.ts";
import type { TranscribeResult } from "./types.ts";

export type SttBackend = "whisper-cpp" | "google" | "groq";

const BACKEND: SttBackend =
  (process.env.STT_BACKEND as SttBackend) || "whisper-cpp";

export async function transcribe(wavPath: string): Promise<TranscribeResult> {
  const raw = await transcribeRaw(wavPath);
  if (raw.text && isHallucination(raw.text)) {
    console.log(
      `[stt] hallucination dropped: "${raw.text.slice(0, 80)}"`,
    );
    return { ...raw, text: "" };
  }
  return raw;
}

async function transcribeRaw(wavPath: string): Promise<TranscribeResult> {
  if (BACKEND === "whisper-cpp") {
    const { transcribeWhisperCpp } = await import("./whisperCpp.ts");
    return transcribeWhisperCpp(wavPath);
  }
  if (BACKEND === "google") {
    const { transcribeGoogle } = await import("./google.ts");
    return transcribeGoogle(wavPath);
  }
  if (BACKEND === "groq") {
    const { transcribeGroq } = await import("./groq.ts");
    return transcribeGroq(wavPath);
  }
  throw new Error(`[stt] unknown STT_BACKEND: ${BACKEND}`);
}

export async function transcribeAndCleanup(
  wavPath: string,
): Promise<TranscribeResult> {
  try {
    return await transcribe(wavPath);
  } finally {
    try {
      await unlink(wavPath);
    } catch {
      // already gone
    }
  }
}

export { BACKEND as sttBackend };
export type { TranscribeResult };
