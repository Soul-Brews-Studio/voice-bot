/**
 * Live-feed emitter — append session events as JSON lines to a shared file
 * so external consumers (web UI server, external dashboards) can tail it and
 * stream updates over SSE / WebSocket without re-implementing the audio flow.
 *
 * File: ~/.claude/channels/codey/live-feed.jsonl  (append-only)
 *
 * Event types:
 *   session    — { type, ts, action: "join"|"leave"|"flush", channelName, guildId, ... }
 *   transcript — { type, ts, speaker, speakerId, text, language?, durationMs? }
 *   codey-reply  — { type, ts, text, profile, voice }
 *   trigger    — { type, ts, speaker, speakerId, text, triggerText }
 *   note       — { type, ts, author, text }
 *   error      — { type, ts, source, message }
 *
 * Disabled if LIVE_FEED=false. Failures are swallowed — never crash the
 * recording path for a logging concern.
 */
import { appendFileSync, mkdirSync, existsSync, statSync, truncateSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export const LIVE_FEED_PATH = join(
  homedir(),
  ".claude",
  "channels",
  "codey",
  "live-feed.jsonl",
);

const ENABLED = process.env.LIVE_FEED !== "false";
const MAX_FILE_BYTES =
  Number(process.env.LIVE_FEED_MAX_BYTES) || 10 * 1024 * 1024; // 10MB

// Optional: also POST events to a remote ingest endpoint (VPS dashboard).
// Skipped silently if either URL or token is missing.
const REMOTE_URL = (process.env.LIVE_FEED_REMOTE_URL ?? "").trim();
const REMOTE_TOKEN = (process.env.LIVE_FEED_REMOTE_TOKEN ?? "").trim();
const REMOTE_ENABLED = REMOTE_URL.length > 0 && REMOTE_TOKEN.length > 0;

let initDone = false;
function ensureFile(): void {
  if (initDone) return;
  try {
    mkdirSync(dirname(LIVE_FEED_PATH), { recursive: true });
    // Rotate (truncate) if oversized — keeps last events but bounds disk usage
    if (existsSync(LIVE_FEED_PATH)) {
      const st = statSync(LIVE_FEED_PATH);
      if (st.size > MAX_FILE_BYTES) {
        truncateSync(LIVE_FEED_PATH, 0);
        console.log(`[live-feed] truncated (was ${st.size} bytes)`);
      }
    }
    initDone = true;
  } catch (e: any) {
    console.warn(`[live-feed] init failed: ${e?.message ?? e}`);
  }
}

export type LiveEvent =
  | {
      type: "session";
      action: "join" | "leave" | "flush" | "auto-leave";
      channelName?: string;
      guildId?: string;
      reason?: string;
    }
  | {
      type: "transcript";
      speaker: string;
      speakerId: string;
      text: string;
      language?: string;
      durationMs?: number;
    }
  | {
      type: "codey-reply";
      text: string;
      profile?: string;
      voice?: string;
    }
  | {
      type: "trigger";
      speaker: string;
      speakerId: string;
      text: string;
      triggerText: string;
    }
  | {
      type: "note";
      author: string;
      text: string;
    }
  | {
      type: "error";
      source: string;
      message: string;
    };

export function emitLiveEvent(event: LiveEvent): void {
  if (!ENABLED) return;
  ensureFile();
  const stamped = { ts: Date.now(), ...event };
  try {
    appendFileSync(LIVE_FEED_PATH, JSON.stringify(stamped) + "\n");
  } catch (e: any) {
    // Never throw upwards — emit failures must not break the recording pipeline.
    console.warn(`[live-feed] file emit failed: ${e?.message ?? e}`);
  }
  // Fire-and-forget remote push (VPS dashboard). Don't await — must not
  // add latency to the recording path. Errors are swallowed + logged.
  if (REMOTE_ENABLED) {
    void pushRemote(stamped);
  }
}

async function pushRemote(event: object): Promise<void> {
  try {
    const res = await fetch(REMOTE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${REMOTE_TOKEN}`,
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      console.warn(`[live-feed] remote push HTTP ${res.status}`);
    }
  } catch (e: any) {
    // Network blip — ignore. Don't spam logs on every event during outage.
    if (Math.random() < 0.05) {
      console.warn(`[live-feed] remote push failed (sampled): ${e?.message ?? e}`);
    }
  }
}
