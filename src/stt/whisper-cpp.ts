/**
 * whisper.cpp persistent-server backend.
 *
 * Talks to a local `whisper-server` (brew install whisper-cpp) over HTTP.
 * Default port 9000 (override WHISPER_SERVER_PORT). Server lifecycle is
 * managed by ./whisperServerManager.ts — this file is only the HTTP client.
 */
import type { TranscribeResult } from "./types.ts";

const PORT = Number(process.env.WHISPER_SERVER_PORT) || 9000;
const HOST = process.env.WHISPER_SERVER_HOST || "127.0.0.1";
const PATH = process.env.WHISPER_SERVER_PATH || "/transcribe";
const LANG = process.env.WHISPER_LANGUAGE || "th";

function endpoint(): string {
  return `http://${HOST}:${PORT}${PATH}`;
}

export async function transcribeWhisperCpp(
  wavPath: string,
): Promise<TranscribeResult> {
  const form = new FormData();
  if (typeof Bun !== "undefined") {
    form.set("file", Bun.file(wavPath));
  } else {
    const { readFile } = await import("node:fs/promises");
    const buf = await readFile(wavPath);
    form.set("file", new Blob([buf], { type: "audio/wav" }), "chunk.wav");
  }
  form.set("language", LANG);
  form.set("response_format", "json");
  form.set("temperature", "0");

  const res = await fetch(endpoint(), { method: "POST", body: form });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`whisper-server HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { text?: string; language?: string };
  return {
    text: (data.text ?? "").trim(),
    language: data.language ?? LANG,
  };
}

/** Ping the server. Returns true if up + responding. */
export async function pingWhisperServer(timeoutMs = 1500): Promise<boolean> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${HOST}:${PORT}/`, { signal: ctl.signal });
    return res.ok || res.status === 404;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}
