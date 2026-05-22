/**
 * Transcript cleaner — post-flush LLM rewrite to remove residual whisper
 * hallucinations and improve readability.
 *
 * Runs ASYNC after `/yoi leave` (or auto-leave) writes the raw .md. Reads the
 * file, sends to Gemini with a strict cleaning prompt, overwrites the file
 * with the cleaned version. Non-blocking: voice-bot returns the leave result
 * immediately; the cleaned transcript appears on disk a few seconds later.
 *
 * Uses Gemini (not Claude session) so it doesn't disrupt the user's active
 * Claude Code session. Cost is ~$0.001 per session (Gemini 2.5 Flash).
 *
 * Failure mode: if Gemini call fails or times out, the raw .md is preserved
 * untouched. We never delete the original — only overwrite on success.
 */

import { readFile, writeFile } from "node:fs/promises";

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.CLEANER_MODEL || "gemini-2.5-flash";
const TIMEOUT_MS = Number(process.env.CLEANER_TIMEOUT_MS) || 60_000;
const ENABLED = process.env.TRANSCRIPT_CLEAN !== "false"; // default ON

const SYSTEM_INSTRUCTION = `You are a Thai voice-chat transcript cleaner. Your job is to remove whisper STT hallucinations and produce a readable transcript.

INPUT FORMAT:
A markdown transcript with a header section followed by speaker segments:
\`\`\`
# Voice transcript — channel-name
> Session: ...
> Participants: ...
> ...

---

## HH:MM:SS — speaker-name
text content (possibly hallucinated)

## HH:MM:SS — speaker-name
text content
...
\`\`\`

YOUR RULES:
1. Preserve EVERY \`## HH:MM:SS — speaker\` header exactly as-is, in original order
2. Preserve the entire header block (everything before the first \`##\`) unchanged
3. For each segment text, decide:
   - REAL THAI SPEECH (even if rough/colloquial) → keep as-is, fix only obvious typos
   - HALLUCINATION (YouTube outro, broadcast CTA, "UPS โรงเรียน...", "ขอบคุณที่ติดตาม", "กดติดตาม", "ทีเด็ดบอล", "FB ชัชชาติ", football betting noise, etc.) → replace with: \`_(hallucination dropped)_\`
   - MOSTLY GARBAGE WITH SOME REAL → keep only the real part, drop the garbage
   - REPETITIVE NONSENSE (same phrase >3 times) → keep one instance, drop repeats
4. Do NOT translate, do NOT summarize, do NOT add commentary
5. Do NOT change speaker names, times, or order
6. Output ONLY the cleaned markdown — no preamble, no \`\`\`fences, no explanation
7. Each segment text stays under the same \`## HH:MM:SS\` header
8. If unsure whether something is hallucination, keep it (false-negative is better than removing real speech)`;

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
}

/**
 * Clean transcript in-place. Fire-and-forget — caller doesn't await.
 * Errors are logged but never thrown.
 */
export async function cleanTranscriptInBackground(
  filepath: string,
): Promise<void> {
  if (!ENABLED) {
    console.log(`[cleaner] disabled (TRANSCRIPT_CLEAN=false) — skip ${filepath}`);
    return;
  }
  if (!API_KEY) {
    console.warn(`[cleaner] GEMINI_API_KEY missing — skip ${filepath}`);
    return;
  }

  const startedAt = Date.now();
  try {
    const raw = await readFile(filepath, "utf8");
    if (raw.length < 200) {
      console.log(`[cleaner] skip ${filepath} — too short (${raw.length} chars)`);
      return;
    }
    const segmentCount = (raw.match(/^## \d{2}:\d{2}:\d{2}/gm) ?? []).length;
    if (segmentCount < 2) {
      console.log(`[cleaner] skip ${filepath} — only ${segmentCount} segment(s)`);
      return;
    }

    console.log(
      `[cleaner] start ${filepath} (${raw.length} chars, ${segmentCount} segments) → ${MODEL}`,
    );
    const cleaned = await callGemini(raw);
    const elapsed = Date.now() - startedAt;

    if (!cleaned) {
      console.warn(`[cleaner] empty reply after ${elapsed}ms — keep raw`);
      return;
    }
    // Sanity check: cleaned output must contain at least half the original headers
    const cleanedHeaders = (cleaned.match(/^## \d{2}:\d{2}:\d{2}/gm) ?? []).length;
    if (cleanedHeaders < segmentCount * 0.5) {
      console.warn(
        `[cleaner] suspicious output (${cleanedHeaders}/${segmentCount} headers preserved) — keep raw`,
      );
      return;
    }
    await writeFile(filepath, cleaned, "utf8");
    console.log(
      `[cleaner] ✅ cleaned ${filepath} in ${elapsed}ms ` +
        `(${raw.length} → ${cleaned.length} chars, ${cleanedHeaders} segments kept)`,
    );
  } catch (e: any) {
    console.warn(`[cleaner] failed ${filepath}: ${e?.message ?? e}`);
  }
}

async function callGemini(rawTranscript: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [{ role: "user", parts: [{ text: rawTranscript }] }],
    generationConfig: {
      temperature: 0.1, // low — we want consistent cleanup, not creative
      maxOutputTokens: 8192,
    },
  };

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new Error(`Gemini HTTP ${res.status}: ${err.slice(0, 200)}`);
    }
    const json = (await res.json()) as GeminiResponse;
    return (json.candidates?.[0]?.content?.parts?.[0]?.text ?? "").trim();
  } finally {
    clearTimeout(t);
  }
}
