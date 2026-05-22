/**
 * think-bridge — voice trigger reply via THIS Claude Code session (Opus 4.7).
 *
 * Flow:
 *   1. voice-bot writes context (per-speaker last 50) to think-requests/
 *   2. spawn `maw hey codey <notif>` — pastes a message into the codey tmux window
 *      so the Claude session sees it as new user input
 *   3. Claude reads context → thinks → writes reply text to think-replies/
 *   4. voice-bot polls reply file (every 500ms, default 90s timeout)
 *   5. caller (VoiceSession) TTS-plays the reply
 *
 * Cleanup: caller should delete the request + reply files after consumption.
 */
import { mkdir, writeFile, readFile, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ContextSegment } from "./brain.ts";
import { getActiveProfile, getActiveVoice } from "./voice-config.ts";

export const THINK_REQ_DIR = join(
  homedir(),
  ".claude",
  "channels",
  "codey",
  "think-requests",
);
export const THINK_REPLY_DIR = join(
  homedir(),
  ".claude",
  "channels",
  "codey",
  "think-replies",
);

const POLL_MS = 500;
const DEFAULT_TIMEOUT_MS = Number(process.env.CLAUDE_REPLY_TIMEOUT_MS) || 90_000;
const MAW_TARGET = process.env.MAW_TARGET || "codey";

export interface ThinkRequest {
  requestId: string;
  triggerText: string;
  triggeredAt: string;
  channelName: string;
  speakerCount: number;
  segmentCount: number;
  context: ContextSegment[];
  replyPath: string;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function pollForReply(
  replyPath: string,
  timeoutMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fileExists(replyPath)) {
      const txt = (await readFile(replyPath, "utf8")).trim();
      if (txt) return txt;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return null;
}

function sendMaw(notif: string): void {
  try {
    const proc = spawn("maw", ["hey", MAW_TARGET, notif], {
      stdio: "ignore",
      detached: true,
    });
    proc.unref();
  } catch (e) {
    console.warn(`[think-bridge] spawn maw failed:`, e);
  }
}

/**
 * Ask the Claude session (via maw hey) to think + write a reply, then poll
 * for it. Returns reply text on success, null on timeout.
 *
 * mode = "voice" (default) — triggered by voice transcription, reply will
 *                            be TTS-spoken in voice channel
 * mode = "text"  — triggered by `/codey think <msg>` slash command, reply
 *                  will be shown as Discord ephemeral message (no TTS)
 */
export async function requestClaudeReply(args: {
  triggerText: string;
  channelName: string;
  context: ContextSegment[];
  speakerCount: number;
  timeoutMs?: number;
  mode?: "voice" | "text";
}): Promise<{ reply: string | null; requestId: string; replyPath: string }> {
  const requestId = `req-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const reqPath = join(THINK_REQ_DIR, `${requestId}.json`);
  const replyPath = join(THINK_REPLY_DIR, `${requestId}.txt`);

  await mkdir(THINK_REQ_DIR, { recursive: true });
  await mkdir(THINK_REPLY_DIR, { recursive: true });

  const payload: ThinkRequest = {
    requestId,
    triggerText: args.triggerText,
    triggeredAt: new Date().toISOString(),
    channelName: args.channelName,
    speakerCount: args.speakerCount,
    segmentCount: args.context.length,
    context: args.context,
    replyPath,
  };
  await writeFile(reqPath, JSON.stringify(payload, null, 2));

  const mode = args.mode ?? "voice";
  const sourceLine =
    mode === "voice"
      ? `Trigger heard in voice: "${args.triggerText.slice(0, 200)}"`
      : `/codey think (typed text): "${args.triggerText.slice(0, 400)}"`;
  const contextLine =
    args.context.length > 0
      ? `Voice context: ${args.context.length} segments / ${args.speakerCount} speaker(s) at ${reqPath}`
      : `No voice context (text-only inject) — request payload at ${reqPath}`;

  // Single compact block — maw splits long multi-paragraph messages and the
  // trailing "Timeout: Ns" line gets delivered as a second message. Keep it
  // tight + no trailing standalone line.
  const seconds = Math.floor((args.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000);
  // Resolve the *currently active* TTS voice profile at notif time. The user
  // can swap voices at runtime (/yv leda etc.) so we must look this up, not
  // hardcode "Kanya". The profile name + language hint help Claude tune the
  // reply (Thai-only for Kanya/Narisa, code-switch OK for Leda).
  const profile = getActiveProfile();
  const resolved = getActiveVoice();
  const langRule =
    resolved.backend === "google"
      ? "Thai or English (Leda is multilingual)"
      : "Thai only";
  const notif =
    `🌀 [voice-bot] โคดี้ถูกเรียก (${args.channelName}, timeout ${seconds}s)\n` +
    `${sourceLine}\n` +
    `${contextLine}\n` +
    `Read: ${reqPath}\n` +
    `Reply: ${replyPath}\n` +
    `Rules: ${langRule}, สั้นที่สุด ครบสิ่งที่จะสื่อ เข้าใจง่าย (ไม่จำกัดประโยค), ลงท้าย ค่ะ/นะคะ, no markdown, no quotes. ` +
    `Tone: friendly and concise. ` +
    `TTS via ${profile} (${resolved.voice}).`;

  console.log(
    `[think-bridge] req=${requestId} ctx=${args.context.length}seg/${args.speakerCount}spk — notifying Claude`,
  );
  sendMaw(notif);

  const reply = await pollForReply(replyPath, args.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (reply) {
    console.log(
      `[think-bridge] req=${requestId} ✅ reply received (${reply.length} chars)`,
    );
  } else {
    console.warn(
      `[think-bridge] req=${requestId} ⏱ timeout after ${args.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`,
    );
  }
  return { reply, requestId, replyPath };
}

export async function cleanupRequest(requestId: string): Promise<void> {
  for (const p of [
    join(THINK_REQ_DIR, `${requestId}.json`),
    join(THINK_REPLY_DIR, `${requestId}.txt`),
  ]) {
    try {
      await unlink(p);
    } catch {}
  }
}
