/**
 * Markdown transcript renderer + writer.
 *
 * Output schema:
 *
 *   # Voice transcript — <channel name>
 *   > Session: <start> → <end> (<duration>)
 *   > Participants: A, B, C
 *   > Recorded by Codey 🌀
 *
 *   ---
 *
 *   ## HH:MM:SS — Speaker
 *   <text>
 *
 *   ## HH:MM:SS — [note from Speaker]
 *   <text>
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const TRANSCRIPT_DIR =
  process.env.TRANSCRIPT_DIR || "transcripts";

export interface TranscriptSegment {
  speaker: string;
  speakerId: string;
  startedAt: number;
  endedAt: number;
  text: string;
  language?: string;
  isNote?: boolean;
  noteAuthor?: string;
}

export interface TranscriptHeader {
  channelName: string;
  sessionStart: number;
  sessionEnd: number;
  participants: string[];
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function formatTimeOfDay(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

function formatDurationMin(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m} min`;
}

export function renderTranscript(
  header: TranscriptHeader,
  segments: TranscriptSegment[],
): string {
  const lines: string[] = [];
  lines.push(`# Voice transcript — ${header.channelName}`);
  lines.push(
    `> Session: ${formatTimestamp(header.sessionStart)} → ${formatTimestamp(header.sessionEnd)} (${formatDurationMin(header.sessionEnd - header.sessionStart)})`,
  );
  if (header.participants.length > 0) {
    lines.push(`> Participants: ${header.participants.join(", ")}`);
  }
  lines.push(`> Recorded by Codey 🌀`);
  lines.push(`> Order: 📜 newest first (waterfall)`);
  lines.push("");
  lines.push("---");
  lines.push("");

  // Waterfall: newest segment on top, oldest at bottom.
  // Internal array stays chronological — we just iterate in reverse for render.
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i]!;
    if (s.isNote) {
      lines.push(
        `## ${formatTimeOfDay(s.startedAt)} — [note from ${s.noteAuthor ?? "unknown"}]`,
      );
    } else {
      lines.push(`## ${formatTimeOfDay(s.startedAt)} — ${s.speaker}`);
    }
    lines.push(s.text);
    lines.push("");
  }

  if (segments.length === 0) {
    lines.push("_(empty session — no audio captured)_");
    lines.push("");
  }

  return lines.join("\n");
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-_\s]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 50) || "voice";
}

export async function writeTranscriptFile(
  header: TranscriptHeader,
  segments: TranscriptSegment[],
): Promise<string> {
  await mkdir(TRANSCRIPT_DIR, { recursive: true });
  const d = new Date(header.sessionStart);
  const ymd = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hm = `${pad(d.getHours())}${pad(d.getMinutes())}`;
  const filename = `${ymd}_${hm}_${slugify(header.channelName)}.md`;
  const filepath = join(TRANSCRIPT_DIR, filename);
  await writeFile(filepath, renderTranscript(header, segments));
  return filepath;
}
