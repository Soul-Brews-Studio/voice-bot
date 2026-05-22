/**
 * Per-session cost estimation for the voice pipeline.
 *
 * STT/TTS cost is backend-dependent:
 *   - STT_BACKEND=whisper-cpp → $0 (local whisper.cpp + Metal)
 *   - STT_BACKEND=google      → Cloud Speech, per 15-sec increment
 *   - TTS_BACKEND=mac-say     → $0 (macOS `say` Kanya, on-device)
 *   - TTS_BACKEND=google      → Cloud TTS, per input char
 *
 * Other costs:
 *   - Gemini 2.5 Flash — per token in/out (when /codey think uses Gemini)
 *   - Claude — via subscription, NOT per-call (just reply count, no $)
 *
 * Pricing constants reflect public Google Cloud rates as of early 2026.
 * Override via env if rates change without redeploying.
 */
export interface CostMetrics {
  sttBilledSec: number;
  sttCallCount: number;
  ttsBilledChars: number;
  ttsCallCount: number;
  geminiInputTokens: number;
  geminiOutputTokens: number;
  geminiCallCount: number;
  claudeReplyCount: number;
  /** TTS voice profiles actually used during the session. */
  ttsProfilesUsed?: Set<string>;
}

export const PRICING = {
  STT_USD_PER_MIN:
    Number(process.env.STT_USD_PER_MIN) || 0.024, // Cloud STT latest_short
  TTS_USD_PER_1M_CHARS:
    Number(process.env.TTS_USD_PER_1M_CHARS) || 16, // Chirp 3 HD
  GEMINI_INPUT_USD_PER_1M_TOKENS:
    Number(process.env.GEMINI_INPUT_USD_PER_1M_TOKENS) || 0.075,
  GEMINI_OUTPUT_USD_PER_1M_TOKENS:
    Number(process.env.GEMINI_OUTPUT_USD_PER_1M_TOKENS) || 0.3,
};

export interface CostBreakdown {
  sttUsd: number;
  ttsUsd: number;
  geminiUsd: number;
  totalUsd: number;
}

/**
 * STT bills in 15-sec increments rounded up. Round per-call, not on aggregate.
 * Caller should round each chunk via roundSttSeconds() before accumulating.
 */
export function roundSttSeconds(secs: number): number {
  return Math.ceil(secs / 15) * 15;
}

/** Free local backends — these incur $0 regardless of usage. */
const FREE_STT_BACKENDS = new Set(["whisper-cpp"]);
const FREE_TTS_BACKENDS = new Set(["mac-say"]);

function sttIsFree(): boolean {
  return FREE_STT_BACKENDS.has(process.env.STT_BACKEND || "whisper-cpp");
}
function ttsIsFree(): boolean {
  return FREE_TTS_BACKENDS.has(process.env.TTS_BACKEND || "mac-say");
}

export function computeCost(m: CostMetrics): CostBreakdown {
  const sttUsd = sttIsFree()
    ? 0
    : (m.sttBilledSec / 60) * PRICING.STT_USD_PER_MIN;
  const ttsUsd = ttsIsFree()
    ? 0
    : (m.ttsBilledChars / 1_000_000) * PRICING.TTS_USD_PER_1M_CHARS;
  const geminiUsd =
    (m.geminiInputTokens / 1_000_000) * PRICING.GEMINI_INPUT_USD_PER_1M_TOKENS +
    (m.geminiOutputTokens / 1_000_000) *
      PRICING.GEMINI_OUTPUT_USD_PER_1M_TOKENS;
  return {
    sttUsd,
    ttsUsd,
    geminiUsd,
    totalUsd: sttUsd + ttsUsd + geminiUsd,
  };
}

/** Convert USD → THB at a rough rate (override via env). */
function usdToThb(usd: number): number {
  const rate = Number(process.env.USD_THB_RATE) || 35;
  return usd * rate;
}

export function formatCost(m: CostMetrics): string {
  const c = computeCost(m);
  const fmtUsd = (n: number) => `$${n.toFixed(4)}`;
  const fmtThb = (n: number) => `฿${n.toFixed(2)}`;

  // STT label: backend + actual model file used (read from env at call time;
  // we don't currently swap STT mid-session so this is accurate).
  const sttBackend = process.env.STT_BACKEND || "whisper-cpp";
  const sttModelPath = process.env.WHISPER_MODEL_PATH || "";
  const sttModelLabel = sttModelPath
    ? sttModelPath.split("/").pop()?.replace(/^ggml-|\.bin$/g, "") ?? sttBackend
    : sttBackend;
  const sttFreeStr = sttIsFree() ? ", free" : "";
  const sttTag = ` [${sttBackend}: ${sttModelLabel}${sttFreeStr}]`;

  // TTS label: all profiles actually used in this session (Set captured by
  // voice-session on every speakReply). Falls back to env default if empty.
  let ttsTag: string;
  if (m.ttsProfilesUsed && m.ttsProfilesUsed.size > 0) {
    const profiles = Array.from(m.ttsProfilesUsed).join(", ");
    const free = ttsIsFree() ? ", free" : "";
    ttsTag = ` [${profiles}${free}]`;
  } else {
    const ttsBackend = process.env.TTS_BACKEND || "mac-say";
    ttsTag = ttsIsFree() ? ` [${ttsBackend}, free]` : ` [${ttsBackend}]`;
  }

  const lines: string[] = [];
  lines.push(
    `STT  : ${m.sttBilledSec}s (${m.sttCallCount} calls) → ${fmtUsd(c.sttUsd)}${sttTag}`,
  );
  lines.push(
    `TTS  : ${m.ttsBilledChars} chars (${m.ttsCallCount} calls) → ${fmtUsd(c.ttsUsd)}${ttsTag}`,
  );
  if (m.geminiCallCount > 0) {
    lines.push(
      `Gemini: ${m.geminiInputTokens}↑ / ${m.geminiOutputTokens}↓ tokens (${m.geminiCallCount} calls) → ${fmtUsd(c.geminiUsd)}`,
    );
  }
  if (m.claudeReplyCount > 0) {
    lines.push(
      `Claude: ${m.claudeReplyCount} replies via subscription (no API charge)`,
    );
  }
  lines.push(
    `TOTAL: ${fmtUsd(c.totalUsd)} ≈ ${fmtThb(usdToThb(c.totalUsd))}`,
  );
  return lines.join("\n");
}
