/**
 * Google Cloud Text-to-Speech backend.
 * Extracted from tts.ts. Auth via GOOGLE_APPLICATION_CREDENTIALS.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { TextToSpeechClient } from "@google-cloud/text-to-speech";
import type { protos } from "@google-cloud/text-to-speech";
import type { TtsFile } from "./types.ts";

const TMP_DIR = join(homedir(), ".claude", "channels", "codey", "voice-tmp");

let client: TextToSpeechClient | null = null;
function getClient(): TextToSpeechClient {
  if (!client) client = new TextToSpeechClient();
  return client;
}

export async function synthesizeGoogle(
  text: string,
  voiceOverride?: string,
  langOverride?: string,
): Promise<TtsFile> {
  const voice = voiceOverride || process.env.TTS_VOICE || "en-US-Chirp3-HD-Leda";
  const lang = langOverride || process.env.TTS_LANGUAGE_CODE || "en-US";
  const sampleRate = Number(process.env.TTS_SAMPLE_RATE) || 24000;

  const request: protos.google.cloud.texttospeech.v1.ISynthesizeSpeechRequest = {
    input: { text },
    voice: { languageCode: lang, name: voice },
    audioConfig: {
      audioEncoding: "LINEAR16",
      sampleRateHertz: sampleRate,
    },
  };

  const [response] = await getClient().synthesizeSpeech(request);
  const audioContent = response.audioContent;
  if (!audioContent) throw new Error("Cloud TTS: no audioContent in response");

  const pcm =
    typeof audioContent === "string"
      ? Buffer.from(audioContent, "base64")
      : Buffer.from(audioContent);
  const wav = pcmToWav(pcm, sampleRate, 1, 16);

  mkdirSync(TMP_DIR, { recursive: true });
  const path = join(TMP_DIR, `tts_${Date.now()}.wav`);
  writeFileSync(path, wav);
  return path;
}

function pcmToWav(
  pcm: Buffer,
  sampleRate: number,
  channels: number,
  bitsPerSample: number,
): Buffer {
  const dataSize = pcm.length;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}
