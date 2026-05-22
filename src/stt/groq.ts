/**
 * Groq Whisper Large V3 backend — fast cloud STT via Groq LPU.
 * Free tier: 30 RPM. Auth via GROQ_API_KEY env.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { TranscribeResult } from "./types.ts";

const API_KEY = process.env.GROQ_API_KEY;
const MODEL = process.env.GROQ_STT_MODEL || "whisper-large-v3";
const LANGUAGE = process.env.GROQ_STT_LANGUAGE || "th";
const API_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

export async function transcribeGroq(wavPath: string): Promise<TranscribeResult> {
  if (!API_KEY) {
    throw new Error("[stt-groq] GROQ_API_KEY missing in .env");
  }

  const buf = await readFile(wavPath);
  const blob = new Blob([buf], { type: "audio/wav" });

  const form = new FormData();
  form.append("file", blob, basename(wavPath));
  form.append("model", MODEL);
  form.append("language", LANGUAGE);
  form.append("response_format", "verbose_json");

  const res = await fetch(API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}` },
    body: form,
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`[stt-groq] HTTP ${res.status}: ${err.slice(0, 300)}`);
  }

  const json = (await res.json()) as {
    text?: string;
    language?: string;
    duration?: number;
  };

  return {
    text: (json.text ?? "").trim(),
    language: json.language ?? LANGUAGE,
    durationSec: json.duration,
  };
}
