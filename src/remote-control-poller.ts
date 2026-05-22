/**
 * Remote control poller — Mac side. Polls the VPS UI server for queued
 * commands and dispatches them through the same file-IPC pipeline that TG /
 * DC pollers + slash commands use (~/.claude/channels/codey/voice-commands/).
 *
 * Why polling not WebSocket: Mac has no inbound port; outbound HTTPS works
 * through any NAT/firewall. 2-second cadence is fine for human-paced UI
 * control commands.
 *
 * Reuses LIVE_FEED_REMOTE_URL + LIVE_FEED_REMOTE_TOKEN — we derive the
 * control endpoint from the ingest URL by swapping the path suffix.
 *
 * Disabled if env not configured. Errors are logged + sampled (not spammed
 * during a VPS outage).
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

const INGEST_URL = (process.env.LIVE_FEED_REMOTE_URL ?? "").trim();
const TOKEN = (process.env.LIVE_FEED_REMOTE_TOKEN ?? "").trim();
const POLL_INTERVAL_MS = Number(process.env.REMOTE_CONTROL_POLL_MS) || 2_000;
const VOICE_CMD_DIR = join(homedir(), ".claude", "channels", "codey", "voice-commands");

interface RemoteCommand {
  id: string;
  ts: number;
  action: string;
  arg?: string;
}

let timer: ReturnType<typeof setInterval> | null = null;
let errorLogSampleCounter = 0;

export function startRemoteControlPoller(): void {
  if (!INGEST_URL || !TOKEN) {
    console.log("[remote-control] disabled (LIVE_FEED_REMOTE_URL / _TOKEN not set)");
    return;
  }
  // Derive control endpoint from ingest URL (e.g. .../api/ingest → .../api/control/pending)
  const controlUrl = INGEST_URL.replace(/\/api\/ingest\/?$/, "/api/control/pending");
  if (controlUrl === INGEST_URL) {
    console.warn(`[remote-control] could not derive control URL from ${INGEST_URL} — disabled`);
    return;
  }
  console.log(`[remote-control] polling ${controlUrl} every ${POLL_INTERVAL_MS}ms`);
  mkdirSync(VOICE_CMD_DIR, { recursive: true });

  const tick = async () => {
    try {
      const res = await fetch(controlUrl, {
        headers: { Authorization: `Bearer ${TOKEN}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        if (errorLogSampleCounter++ % 30 === 0) {
          console.warn(`[remote-control] poll HTTP ${res.status} (sampled)`);
        }
        return;
      }
      const json = (await res.json()) as { ok?: boolean; commands?: RemoteCommand[] };
      const cmds = json.commands ?? [];
      if (cmds.length === 0) return;
      for (const cmd of cmds) {
        await dispatchToIpc(cmd);
      }
    } catch (e: any) {
      if (errorLogSampleCounter++ % 30 === 0) {
        console.warn(`[remote-control] poll failed (sampled): ${e?.message ?? e}`);
      }
    }
  };

  timer = setInterval(tick, POLL_INTERVAL_MS);
  // Immediate first tick so UI commands feel responsive on startup
  void tick();
}

export function stopRemoteControlPoller(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Translate a remote command into the local VoiceCommand JSON IPC format. */
async function dispatchToIpc(cmd: RemoteCommand): Promise<void> {
  let action = (cmd.action ?? "").toLowerCase();
  const arg = (cmd.arg ?? "").trim();
  // Map UI-only "leave-long" alias → standard leave action + long summary flag.
  // Keeps the IPC schema flat (action="leave") while letting the UI button
  // choose between short and long modes.
  let summaryMode: "short" | "long" | undefined;
  if (action === "leave-long") {
    action = "leave";
    summaryMode = "long";
  } else if (action === "leave") {
    summaryMode = arg.toLowerCase() === "long" ? "long" : "short";
  }
  const requestId = `remote-ui-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const payload: Record<string, unknown> = {
    action,
    source: "session",
    issuedAt: new Date(cmd.ts ?? Date.now()).toISOString(),
    requestId,
    requester: `ui-remote(${cmd.id})`,
  };
  if (summaryMode) payload.summaryMode = summaryMode;
  if (action === "join" && arg) {
    if (/^\d{15,25}$/.test(arg)) payload.channelId = arg;
    else payload.channelName = arg;
  }
  if (action === "voice" && arg) payload.profile = arg;
  if ((action === "say" || action === "think" || action === "note") && arg) {
    payload.text = arg;
  }
  if (action === "stay" && arg) {
    const h = Number(arg);
    if (Number.isFinite(h) && h > 0) payload.stayHours = h;
  }
  try {
    writeFileSync(
      join(VOICE_CMD_DIR, `${requestId}.json`),
      JSON.stringify(payload, null, 2),
    );
    console.log(`[remote-control] queued ${action}${arg ? ` ${arg.slice(0, 40)}` : ""} (id=${cmd.id})`);
  } catch (e: any) {
    console.warn(`[remote-control] write IPC failed: ${e?.message ?? e}`);
  }
}
