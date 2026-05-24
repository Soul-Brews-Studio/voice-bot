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
import { existsSync, readdirSync, type Dirent } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const GHQ_DIR = join(homedir(), "ghq");

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

export interface VoiceSessionMetadata {
  sessionId: string;
  botName: string;
  channel: string;
  guild: string;
  startedAt: string;
  endedAt: string | null;
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

function botName(): string {
  return process.env.BOT_NAME ?? process.env.VOICE_BOT_NAME ?? "codey";
}

function findBotRepo(root: string, name: string, maxDepth: number): string | null {
  if (maxDepth < 0 || !existsSync(root)) return null;

  let entries: Dirent<string>[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    if (entry.name.startsWith(name) && existsSync(join(path, "ψ"))) {
      return path;
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findBotRepo(join(root, entry.name), name, maxDepth - 1);
    if (found) return found;
  }

  return null;
}

export function resolveTranscriptDir(): string {
  if (process.env.TRANSCRIPT_DIR) return process.env.TRANSCRIPT_DIR;

  const oracleRepo = process.env.ORACLE_REPO;
  if (oracleRepo && existsSync(join(oracleRepo, "ψ"))) {
    return join(oracleRepo, "ψ", "transcripts");
  }

  const name = botName();
  const repo = findBotRepo(GHQ_DIR, name, 4);
  if (repo) return join(repo, "ψ", "transcripts");

  return join(homedir(), ".claude", "channels", name, "transcripts");
}

export function transcriptBasename(
  startedAt: number,
  channelName: string,
): string {
  const d = new Date(startedAt);
  const ymd = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hm = `${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `${ymd}_${hm}_${slugify(botName())}_${slugify(channelName)}`;
}

export async function writeVoiceSessionMetadata(
  metadata: VoiceSessionMetadata,
  startedAt: number,
): Promise<string> {
  const transcriptDir = resolveTranscriptDir();
  await mkdir(transcriptDir, { recursive: true });
  const filename = `${transcriptBasename(startedAt, metadata.channel)}.session.json`;
  const filepath = join(transcriptDir, filename);
  await writeFile(filepath, `${JSON.stringify(metadata, null, 2)}\n`);
  return filepath;
}

export async function writeTranscriptFile(
  header: TranscriptHeader,
  segments: TranscriptSegment[],
): Promise<string> {
  const transcriptDir = resolveTranscriptDir();
  await mkdir(transcriptDir, { recursive: true });
  const filename = `${transcriptBasename(header.sessionStart, header.channelName)}.md`;
  const filepath = join(transcriptDir, filename);
  await writeFile(filepath, renderTranscript(header, segments));
  return filepath;
}
