/**
 * STT dispatcher — picks backend via STT_BACKEND env.
 *   - "typhoon":     OpenTyphoon Typhoon ASR when TYPHOON_API_KEY exists
 *   - "groq":        Groq Whisper Large V3 cloud when GROQ_API_KEY exists
 *   - "whisper-cpp": local whisper.cpp fallback
 *
 * Post-process: every transcript is run through ./hallucinations.ts.
 * Hallucinated text → empty string (caller treats as silence, no segment).
 */
import { unlink } from "node:fs/promises";
import { isHallucination } from "./hallucinations.ts";
import type { TranscribeResult } from "./types.ts";

export type SttBackend = "whisper-cpp" | "groq" | "typhoon";

export function sttBackend(): SttBackend {
  const configured = process.env.STT_BACKEND as SttBackend | undefined;
  if (configured) return configured;
  if (process.env.TYPHOON_API_KEY) return "typhoon";
  if (process.env.GROQ_API_KEY) return "groq";
  return "whisper-cpp";
}

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
  const backend = sttBackend();
  if (backend === "whisper-cpp") {
    const { transcribeWhisperCpp } = await import("./whisper-cpp.ts");
    return transcribeWhisperCpp(wavPath);
  }
  if (backend === "groq") {
    const { transcribeGroq } = await import("./groq.ts");
    return transcribeGroq(wavPath);
  }
  if (backend === "typhoon") {
    const { transcribeTyphoon } = await import("./typhoon.ts");
    return transcribeTyphoon(wavPath);
  }
  throw new Error(`[stt] unknown STT_BACKEND: ${backend}`);
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

export type { TranscribeResult };
