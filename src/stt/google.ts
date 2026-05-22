/**
 * Google Cloud Speech-to-Text backend.
 * Extracted from transcriber.ts. Auth via GOOGLE_APPLICATION_CREDENTIALS.
 */
import { readFile } from "node:fs/promises";
import { SpeechClient } from "@google-cloud/speech";
import type { protos } from "@google-cloud/speech";
import type { TranscribeResult } from "./types.ts";

const STT_LANG = process.env.STT_LANGUAGE_CODE || "th-TH";
const STT_MODEL = process.env.STT_MODEL || "latest_short";

let client: SpeechClient | null = null;
function getClient(): SpeechClient {
  if (!client) client = new SpeechClient();
  return client;
}

function stripWavHeader(buf: Buffer): Buffer {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") return buf;
  return buf.subarray(44);
}

export async function transcribeGoogle(wavPath: string): Promise<TranscribeResult> {
  const buf = await readFile(wavPath);
  const pcm = stripWavHeader(buf);
  const base64 = pcm.toString("base64");

  const request: protos.google.cloud.speech.v1.IRecognizeRequest = {
    audio: { content: base64 },
    config: {
      encoding: "LINEAR16",
      sampleRateHertz: 16000,
      audioChannelCount: 1,
      languageCode: STT_LANG,
      model: STT_MODEL,
      enableAutomaticPunctuation: true,
      useEnhanced: true,
    },
  };

  const [response] = await getClient().recognize(request);
  const text = response.results?.[0]?.alternatives?.[0]?.transcript ?? "";
  const detectedLang = response.results?.[0]?.languageCode ?? STT_LANG;
  return { text: text.trim(), language: detectedLang };
}
