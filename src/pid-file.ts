/**
 * PID file management for on-demand voice-bot lifecycle.
 *
 * The poller (src/voice-cmd.ts) spawns voice-bot when /join arrives and
 * needs to detect whether it's already running. We use a PID file at
 * VOICE_BOT_PID_FILE + a `kill 0` liveness check so stale files from
 * crashes don't block future spawns.
 */
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const VOICE_BOT_PID_FILE = join(
  homedir(),
  ".claude",
  "channels",
  "codey",
  "voice-bot.pid",
);

export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readPidFile(): number | null {
  if (!existsSync(VOICE_BOT_PID_FILE)) return null;
  try {
    const raw = readFileSync(VOICE_BOT_PID_FILE, "utf8").trim();
    const pid = Number(raw);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function isVoiceBotRunning(): boolean {
  const pid = readPidFile();
  return pid !== null && isProcessAlive(pid);
}

export function writePidFile(): void {
  const existing = readPidFile();
  if (existing && existing !== process.pid && isProcessAlive(existing)) {
    console.warn(
      `[pid-file] another voice-bot already running (pid=${existing}); overwriting anyway with pid=${process.pid}`,
    );
  }
  try {
    writeFileSync(VOICE_BOT_PID_FILE, String(process.pid));
    console.log(`[pid-file] wrote ${VOICE_BOT_PID_FILE} (pid=${process.pid})`);
  } catch (e: any) {
    console.warn(`[pid-file] write failed: ${e?.message ?? e}`);
  }
}

export function unlinkPidFile(): void {
  if (!existsSync(VOICE_BOT_PID_FILE)) return;
  const pid = readPidFile();
  if (pid !== null && pid !== process.pid) {
    console.log(
      `[pid-file] skip unlink — pid file owned by ${pid}, we are ${process.pid}`,
    );
    return;
  }
  try {
    unlinkSync(VOICE_BOT_PID_FILE);
    console.log(`[pid-file] removed ${VOICE_BOT_PID_FILE}`);
  } catch (e: any) {
    console.warn(`[pid-file] unlink failed: ${e?.message ?? e}`);
  }
}
