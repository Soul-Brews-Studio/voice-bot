/**
 * Session archive — push a completed voice session (raw transcript + metadata)
 * to the VPS UI server so it appears in the "Sessions" tab.
 *
 * Runs immediately on leave. Cleaning + summary are done by the Claude session
 * via the handoff prompt (zero API cost). When Claude updates the .md file
 * with summary, the next POST to this endpoint will overwrite the VPS entry
 * (saveSession is idempotent by id).
 *
 * Skips silently when:
 *   - SESSION_ARCHIVE=false
 *   - LIVE_FEED_REMOTE_URL / _TOKEN missing
 *   - segment count below SESSION_ARCHIVE_MIN_SEGMENTS (default 3)
 *
 * Endpoint:  POST <VPS>/api/sessions  (bearer auth via LIVE_FEED_REMOTE_TOKEN)
 * Derived from LIVE_FEED_REMOTE_URL by swapping the path suffix.
 */
import { readFile } from "node:fs/promises";

const ENABLED = process.env.SESSION_ARCHIVE !== "false";
const MIN_SEGMENTS = Number(process.env.SESSION_ARCHIVE_MIN_SEGMENTS) || 3;

const VPS_INGEST_URL = (process.env.LIVE_FEED_REMOTE_URL ?? "").trim();
const VPS_TOKEN = (process.env.LIVE_FEED_REMOTE_TOKEN ?? "").trim();

export interface ArchiveSessionMeta {
  /** Stable, sortable, human-readable. Matches transcript filename basename. */
  sessionId: string;
  /** Absolute path to the .md transcript on disk. */
  filepath: string;
  channelName: string;
  channelId?: string;
  guildId?: string;
  joinedAt: number;
  leftAt: number;
  durationMs: number;
  participants: string[];
  segmentCount: number;
}

/**
 * Fire-and-forget. Never throws. Caller does `void archiveSessionInBackground(...)`.
 * Pushes the raw transcript only — Claude session adds summary later and may
 * re-POST to overwrite this entry.
 */
export async function archiveSessionInBackground(
  meta: ArchiveSessionMeta,
): Promise<void> {
  if (!ENABLED) {
    console.log(`[archive] disabled (SESSION_ARCHIVE=false)`);
    return;
  }
  if (!VPS_INGEST_URL || !VPS_TOKEN) {
    console.log(`[archive] VPS not configured — skip`);
    return;
  }
  if (meta.segmentCount < MIN_SEGMENTS) {
    console.log(
      `[archive] skip ${meta.sessionId} — only ${meta.segmentCount} segments (< ${MIN_SEGMENTS})`,
    );
    return;
  }
  const startedAt = Date.now();
  try {
    const transcriptMd = await readFile(meta.filepath, "utf8");
    if (transcriptMd.length < 200) {
      console.log(`[archive] skip ${meta.sessionId} — transcript too short`);
      return;
    }

    const url = VPS_INGEST_URL.replace(/\/api\/ingest\/?$/, "/api/sessions");
    if (url === VPS_INGEST_URL) {
      console.warn(`[archive] couldn't derive sessions URL from ${VPS_INGEST_URL}`);
      return;
    }

    const payload = {
      id: meta.sessionId,
      channelName: meta.channelName,
      channelId: meta.channelId,
      guildId: meta.guildId,
      joinedAt: meta.joinedAt,
      leftAt: meta.leftAt,
      durationMs: meta.durationMs,
      participants: meta.participants,
      segmentCount: meta.segmentCount,
      summary: "", // Filled in later by Claude session re-POST
      transcriptMd,
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${VPS_TOKEN}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    const elapsed = Date.now() - startedAt;
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      console.warn(
        `[archive] HTTP ${res.status} after ${elapsed}ms: ${err.slice(0, 200)}`,
      );
      return;
    }
    console.log(
      `[archive] ✅ ${meta.sessionId} → VPS (${transcriptMd.length} chars, no summary yet, ${elapsed}ms)`,
    );
  } catch (e: any) {
    console.warn(`[archive] failed ${meta.sessionId}: ${e?.message ?? e}`);
  }
}

/**
 * Derive a stable session id from the transcript filepath basename. The writer
 * already produces `<ymd>_<hm>_<slug>.md` — keep that as the id so it's
 * human-readable, sortable, and matches the on-disk filename.
 */
export function sessionIdFromFilepath(filepath: string): string {
  const base = filepath.split("/").pop() ?? "";
  return base.replace(/\.md$/i, "") || `session-${Date.now()}`;
}
