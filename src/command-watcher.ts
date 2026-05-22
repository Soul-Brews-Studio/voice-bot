/**
 * Command watcher — reads VoiceCommand JSON files from VOICE_CMD_DIR,
 * executes via VoiceSession, writes VoiceResult, deletes input.
 *
 * Watch strategy: poll every 500ms (simpler than fs.watch quirks across
 * platforms; commands are low-volume so polling is fine).
 *
 * Concurrency: single async queue — one command at a time per voice-bot
 * process. Multi-guild would need per-guild queues; v1 = single guild.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ChannelType, type Client, type VoiceChannel, type StageChannel } from "discord.js";

function findVoiceChannelByName(
  client: Client,
  name: string,
): VoiceChannel | StageChannel | null {
  const target = name.trim().toLowerCase();
  for (const guild of client.guilds.cache.values()) {
    for (const ch of guild.channels.cache.values()) {
      if (
        (ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice) &&
        ch.name.toLowerCase() === target
      ) {
        return ch as VoiceChannel | StageChannel;
      }
    }
  }
  return null;
}
import {
  VOICE_CMD_DIR,
  VOICE_RESULT_DIR,
  type VoiceCommand,
  type VoiceResult,
} from "./command-types.ts";
import type { VoiceSession } from "./voice-session.ts";
import { handoff } from "./handoff.ts";
import {
  setSpeakMode,
  setTriggerMode,
  addAllowedTriggerUser,
  removeAllowedTriggerUser,
  getAllowedTriggerUsers,
  type TriggerMode,
} from "./speak-state.ts";
import {
  setActiveVoice,
  listVoiceProfiles,
  type VoiceProfile,
} from "./voice-config.ts";
import { requestClaudeReply, cleanupRequest } from "./think-bridge.ts";
import {
  archiveSessionInBackground,
  sessionIdFromFilepath,
} from "./session-archive.ts";
import { armAutoShutdown, trackPendingArchive } from "./auto-shutdown.ts";

const POLL_INTERVAL_MS = 500;
const SILENCE_MS = Number(process.env.SILENCE_THRESHOLD_MS) || 1500;
const MAX_CHUNK_MS = Number(process.env.MAX_CHUNK_MS) || 30000;
const THINK_TIMEOUT_MS = Number(process.env.CLAUDE_REPLY_TIMEOUT_MS) || 120_000;

export interface WatcherDeps {
  client: Client;
  /** Resolve / create VoiceSession for a guild. */
  sessionFor: (guildId: string) => VoiceSession;
  /** All currently-tracked sessions (read-only iteration). */
  allSessions: () => Iterable<VoiceSession>;
}

export function startCommandWatcher(deps: WatcherDeps): void {
  mkdirSync(VOICE_CMD_DIR, { recursive: true });
  mkdirSync(VOICE_RESULT_DIR, { recursive: true });

  console.log(`[cmd-watcher] watching ${VOICE_CMD_DIR}`);

  let processing = false;
  setInterval(async () => {
    if (processing) return;
    processing = true;
    try {
      await drainQueue(deps);
    } catch (e: any) {
      console.error("[cmd-watcher] drain error:", e?.message ?? e);
    } finally {
      processing = false;
    }
  }, POLL_INTERVAL_MS);
}

async function drainQueue(deps: WatcherDeps): Promise<void> {
  const files = readdirSync(VOICE_CMD_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort(); // FIFO by filename

  for (const f of files) {
    const path = join(VOICE_CMD_DIR, f);
    let cmd: VoiceCommand;
    try {
      cmd = JSON.parse(readFileSync(path, "utf8")) as VoiceCommand;
    } catch (e: any) {
      console.warn(`[cmd-watcher] invalid json ${f}: ${e?.message ?? e}`);
      try {
        unlinkSync(path);
      } catch {}
      continue;
    }

    console.log(
      `[cmd-watcher] processing ${cmd.requestId} action=${cmd.action} source=${cmd.source}`,
    );
    const result = await execute(deps, cmd);
    // Echo replyTo so external watchers (poller-tg) know where to deliver.
    if (cmd.replyTo) result.replyTo = cmd.replyTo;
    writeResult(result);
    try {
      unlinkSync(path);
    } catch {}
  }
}

function now(): string {
  return new Date().toISOString();
}

/** Find the first session that is connected/recording (cmd has no guild hint). */
function firstActiveSession(deps: WatcherDeps): VoiceSession | null {
  for (const s of deps.allSessions()) {
    if (s.state === "recording" || s.state === "connecting") return s;
  }
  return null;
}

async function execute(deps: WatcherDeps, cmd: VoiceCommand): Promise<VoiceResult> {
  switch (cmd.action) {
    case "join":
      return handleJoin(deps, cmd);
    case "leave":
      return handleLeave(deps, cmd);
    case "save":
      return handleSave(deps, cmd);
    case "status":
      return handleStatus(deps, cmd);
    case "note":
      return handleNote(deps, cmd);
    case "speak-on":
    case "speak-off":
      return handleSpeakToggle(deps, cmd);
    case "voice":
      return handleVoice(cmd);
    case "trigger":
      return handleTrigger(deps, cmd);
    case "say":
      return handleSay(deps, cmd);
    case "think":
      return handleThink(deps, cmd);
    case "stay":
      return handleStay(deps, cmd);
    case "unstay":
      return handleUnstay(deps, cmd);
    default:
      return {
        requestId: cmd.requestId,
        ok: false,
        message: `unknown action: ${(cmd as VoiceCommand).action}`,
        completedAt: now(),
      };
  }
}

async function handleJoin(deps: WatcherDeps, cmd: VoiceCommand): Promise<VoiceResult> {
  if (!cmd.channelId && !cmd.channelName) {
    return {
      requestId: cmd.requestId,
      ok: false,
      message: "join requires channelId OR channelName",
      completedAt: now(),
    };
  }
  let channel;
  try {
    if (cmd.channelId) {
      channel = await deps.client.channels.fetch(cmd.channelId);
    } else {
      channel = findVoiceChannelByName(deps.client, cmd.channelName!);
    }
  } catch (e: any) {
    return {
      requestId: cmd.requestId,
      ok: false,
      message: `fetch/find channel failed: ${e?.message ?? e}`,
      completedAt: now(),
    };
  }
  if (!channel || !channel.isVoiceBased() || !("guildId" in channel) || !channel.guildId) {
    return {
      requestId: cmd.requestId,
      ok: false,
      message: `channel ${cmd.channelId ?? cmd.channelName} not a voice channel (or not found)`,
      completedAt: now(),
    };
  }
  const guildId = channel.guildId;
  const session = deps.sessionFor(guildId);
  if (session.state !== "idle") {
    return {
      requestId: cmd.requestId,
      ok: false,
      message: `already in ${session.channelName} (state=${session.state}); use /codey leave first`,
      completedAt: now(),
      guildId,
    };
  }
  try {
    await session.connect({
      channelId: channel.id,
      guildId,
      channelName: "name" in channel ? channel.name : "voice",
      adapterCreator: channel.guild!.voiceAdapterCreator,
      guild: channel.guild!,
      silenceThresholdMs: SILENCE_MS,
      maxChunkMs: MAX_CHUNK_MS,
      autoFlushMs: Number(process.env.AUTO_FLUSH_MS) || 15 * 60 * 1000,
    });
    const chName = "name" in channel ? channel.name : "voice";
    return {
      requestId: cmd.requestId,
      ok: true,
      message: `🌀 joined **${chName}** — recording started`,
      guildId,
      channelId: channel.id,
      channelName: "name" in channel ? channel.name : undefined,
      completedAt: now(),
    };
  } catch (e: any) {
    return {
      requestId: cmd.requestId,
      ok: false,
      message: `connect failed: ${e?.message ?? e}`,
      guildId,
      channelId: channel.id,
      completedAt: now(),
    };
  }
}

async function handleLeave(deps: WatcherDeps, cmd: VoiceCommand): Promise<VoiceResult> {
  const summaryMode = cmd.summaryMode ?? "short";
  for (const guildId of deps.client.guilds.cache.keys()) {
    const session = deps.sessionFor(guildId);
    if (session.state === "idle") continue;
    const channelName = session.channelName;
    const channelId = session.channelId;
    // Capture before disconnect() — it resets meta to idle.
    const joinedAt = session.startedAt ?? Date.now();
    let filepath = "";
    let segments = 0;
    const participants = session.getParticipants();
    const costReport = session.getCostReport();
    try {
      const flushed = await session.flush();
      filepath = flushed.filepath;
      segments = flushed.segments;
    } catch (e: any) {
      console.warn(`[cmd-watcher] flush on leave failed: ${e?.message ?? e}`);
    }
    try {
      const { chunks, durationMs } = await session.disconnect();
      if (filepath) {
        const replyChannelId = session.replyChannelId;
        await handoff(filepath, {
          channelName,
          chunkCount: chunks,
          segmentCount: segments,
          durationMs,
          participants,
          costReport,
          replyChannelId,
          voiceChannelId: channelId,
          summaryMode,
        });
        // Archive to VPS. Clean + summary + Discord send are handled by Claude
        // session via the handoff prompt above. Track the promise so the
        // auto-shutdown waits for the POST to finish before exiting.
        const archivePromise = archiveSessionInBackground({
          sessionId: sessionIdFromFilepath(filepath),
          filepath,
          channelName: channelName ?? "voice",
          channelId,
          guildId,
          joinedAt,
          leftAt: Date.now(),
          durationMs,
          participants,
          segmentCount: segments,
        });
        trackPendingArchive(archivePromise);
      }
      armAutoShutdown(`cmd /yl${summaryMode === "long" ? "-long" : ""} from ${cmd.source}`);
      return {
        requestId: cmd.requestId,
        ok: true,
        message: `🌀 left **${channelName ?? "voice"}** — ${chunks} chunks / ${segments} segments (${summaryMode} summary)`,
        guildId,
        channelId,
        channelName,
        chunkCount: chunks,
        durationMs,
        completedAt: now(),
      };
    } catch (e: any) {
      return {
        requestId: cmd.requestId,
        ok: false,
        message: `disconnect failed: ${e?.message ?? e}`,
        guildId,
        completedAt: now(),
      };
    }
  }
  return {
    requestId: cmd.requestId,
    ok: false,
    message: "no active voice session to leave",
    completedAt: now(),
  };
}

async function handleSave(deps: WatcherDeps, cmd: VoiceCommand): Promise<VoiceResult> {
  const session = firstActiveSession(deps);
  if (!session) {
    return {
      requestId: cmd.requestId,
      ok: false,
      message: "no active voice session to save",
      completedAt: now(),
    };
  }
  try {
    const flushed = await session.flush();
    return {
      requestId: cmd.requestId,
      ok: true,
      message: `🌀 saved — ${flushed.segments} segments → ${flushed.filepath}`,
      guildId: session.guildId,
      channelId: session.channelId,
      channelName: session.channelName,
      completedAt: now(),
    };
  } catch (e: any) {
    return {
      requestId: cmd.requestId,
      ok: false,
      message: `save failed: ${e?.message ?? e}`,
      completedAt: now(),
    };
  }
}

async function handleStatus(deps: WatcherDeps, cmd: VoiceCommand): Promise<VoiceResult> {
  const session = firstActiveSession(deps);
  if (!session) {
    return {
      requestId: cmd.requestId,
      ok: true,
      message: "🌀 idle — not in any voice channel",
      completedAt: now(),
    };
  }
  const status = session.getStatus();
  const segments = session.getSegmentCount();
  const participants = session.getParticipants();
  const duration = status.startedAt
    ? formatDuration(Date.now() - status.startedAt)
    : "0s";
  return {
    requestId: cmd.requestId,
    ok: true,
    message:
      `🌀 status — **${status.channelName}** (${status.state}) · ${duration}\n` +
      `chunks=${status.chunkCount} segments=${segments}\n` +
      `participants: ${participants.join(", ") || "(none yet)"}`,
    guildId: status.guildId,
    channelId: status.channelId,
    channelName: status.channelName ?? undefined,
    chunkCount: status.chunkCount,
    completedAt: now(),
  };
}

async function handleNote(deps: WatcherDeps, cmd: VoiceCommand): Promise<VoiceResult> {
  const session = firstActiveSession(deps);
  if (!session || session.state !== "recording") {
    return {
      requestId: cmd.requestId,
      ok: false,
      message: "no active session to add note (use /codey join first)",
      completedAt: now(),
    };
  }
  const text = (cmd.text ?? "").trim();
  if (!text) {
    return {
      requestId: cmd.requestId,
      ok: false,
      message: "note requires non-empty text",
      completedAt: now(),
    };
  }
  const author =
    cmd.requester ?? (cmd.source === "tg" ? "tg-user" : cmd.source === "dc" ? "dc-user" : "manual");
  session.addNote(text, author);
  return {
    requestId: cmd.requestId,
    ok: true,
    message: `🌀 note added (${author}) — ${text.slice(0, 80)}${text.length > 80 ? "..." : ""}`,
    completedAt: now(),
  };
}

async function handleSpeakToggle(
  deps: WatcherDeps,
  cmd: VoiceCommand,
): Promise<VoiceResult> {
  const on = cmd.action === "speak-on";
  const muteResults: string[] = [];
  for (const guildId of deps.client.guilds.cache.keys()) {
    setSpeakMode(guildId, on);
    const session = deps.sessionFor(guildId);
    if (session.state === "recording") {
      try {
        session.setSelfMute(!on);
        muteResults.push(`${guildId}:mic=${on ? "open" : "mute"}`);
      } catch (e: any) {
        muteResults.push(`${guildId}:mute-failed(${e?.message ?? e})`);
      }
    }
  }
  return {
    requestId: cmd.requestId,
    ok: true,
    message: `🌀 speak mode = ${on ? "ON" : "OFF"}${muteResults.length ? ` — ${muteResults.join(", ")}` : ""}`,
    completedAt: now(),
  };
}

async function handleVoice(cmd: VoiceCommand): Promise<VoiceResult> {
  const profile = (cmd.profile ?? "").toLowerCase() as VoiceProfile;
  const valid = listVoiceProfiles().map((p) => p.id);
  if (!valid.includes(profile)) {
    return {
      requestId: cmd.requestId,
      ok: false,
      message: `unknown voice profile "${cmd.profile}" — valid: ${valid.join(", ")}`,
      completedAt: now(),
    };
  }
  try {
    const resolved = setActiveVoice(profile);
    return {
      requestId: cmd.requestId,
      ok: true,
      message: `🌀 voice → **${profile}** (${resolved.backend}/${resolved.voice}) — ${resolved.costNote}`,
      completedAt: now(),
    };
  } catch (e: any) {
    return {
      requestId: cmd.requestId,
      ok: false,
      message: `voice switch failed: ${e?.message ?? e}`,
      completedAt: now(),
    };
  }
}

async function handleTrigger(deps: WatcherDeps, cmd: VoiceCommand): Promise<VoiceResult> {
  const action = (cmd.triggerMode ?? "").toLowerCase();
  const guildIds = Array.from(deps.client.guilds.cache.keys());
  const userId = cmd.triggerUserId;

  const formatList = (gid: string): string => {
    const ids = getAllowedTriggerUsers(gid);
    return ids.length ? ids.map((id) => `<@${id}>`).join(", ") : "(empty)";
  };

  if (action === "anyone" || action === "owner-only" || action === "selected") {
    for (const gid of guildIds) setTriggerMode(gid, action as TriggerMode);
    return {
      requestId: cmd.requestId,
      ok: true,
      message: `🌀 trigger mode → **${action}** (${guildIds.length} guild${guildIds.length === 1 ? "" : "s"})`,
      completedAt: now(),
    };
  }

  if (action === "add" || action === "remove") {
    if (!userId) {
      return {
        requestId: cmd.requestId,
        ok: false,
        message: `trigger ${action} requires userId`,
        completedAt: now(),
      };
    }
    let changed = 0;
    for (const gid of guildIds) {
      if (action === "add") {
        addAllowedTriggerUser(gid, userId);
        changed++;
      } else {
        if (removeAllowedTriggerUser(gid, userId)) changed++;
      }
    }
    const lists = guildIds
      .map((gid) => `  ${gid}: ${formatList(gid)}`)
      .join("\n");
    return {
      requestId: cmd.requestId,
      ok: true,
      message: `🌀 trigger ${action} <@${userId}> (${changed}/${guildIds.length} guilds)\n${lists}`,
      completedAt: now(),
    };
  }

  if (action === "list") {
    const lists = guildIds
      .map((gid) => `  ${gid}: ${formatList(gid)}`)
      .join("\n");
    return {
      requestId: cmd.requestId,
      ok: true,
      message: `🌀 trigger allow-list per guild:\n${lists}`,
      completedAt: now(),
    };
  }

  return {
    requestId: cmd.requestId,
    ok: false,
    message: `unknown trigger action "${cmd.triggerMode}" — valid: anyone | owner-only | selected | add | remove | list`,
    completedAt: now(),
  };
}

async function handleSay(deps: WatcherDeps, cmd: VoiceCommand): Promise<VoiceResult> {
  const session = firstActiveSession(deps);
  if (!session || session.state !== "recording") {
    return {
      requestId: cmd.requestId,
      ok: false,
      message: "no active voice session to speak in (use /codey join first)",
      completedAt: now(),
    };
  }
  const text = (cmd.text ?? "").trim();
  if (!text) {
    return {
      requestId: cmd.requestId,
      ok: false,
      message: "say requires non-empty text",
      completedAt: now(),
    };
  }
  try {
    await session.speakReply(text);
    return {
      requestId: cmd.requestId,
      ok: true,
      message: `🌀 said in **${session.channelName}** — "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"`,
      guildId: session.guildId,
      channelId: session.channelId,
      channelName: session.channelName,
      completedAt: now(),
    };
  } catch (e: any) {
    return {
      requestId: cmd.requestId,
      ok: false,
      message: `say failed: ${e?.message ?? e}`,
      completedAt: now(),
    };
  }
}

async function handleThink(deps: WatcherDeps, cmd: VoiceCommand): Promise<VoiceResult> {
  const session = firstActiveSession(deps);
  if (!session || session.state !== "recording") {
    return {
      requestId: cmd.requestId,
      ok: false,
      message: "no active voice session for /think (use /codey join first)",
      completedAt: now(),
    };
  }
  const text = (cmd.text ?? "").trim();
  if (!text) {
    return {
      requestId: cmd.requestId,
      ok: false,
      message: "think requires non-empty text",
      completedAt: now(),
    };
  }
  try {
    const { reply, requestId } = await requestClaudeReply({
      triggerText: text,
      channelName: session.channelName ?? "voice",
      context: [],
      speakerCount: 0,
      timeoutMs: THINK_TIMEOUT_MS,
      mode: "text",
    });
    cleanupRequest(requestId).catch(() => {});
    if (!reply) {
      return {
        requestId: cmd.requestId,
        ok: false,
        message: `🌀 think timeout — Claude session didn't reply within ${Math.floor(THINK_TIMEOUT_MS / 1000)}s`,
        completedAt: now(),
      };
    }
    await session.speakReply(reply);
    const preview = reply.length > 180 ? reply.slice(0, 180) + "..." : reply;
    return {
      requestId: cmd.requestId,
      ok: true,
      message: `🌀 spoken in **${session.channelName}**:\n> ${preview}`,
      guildId: session.guildId,
      channelId: session.channelId,
      channelName: session.channelName,
      completedAt: now(),
    };
  } catch (e: any) {
    return {
      requestId: cmd.requestId,
      ok: false,
      message: `think failed: ${e?.message ?? e}`,
      completedAt: now(),
    };
  }
}

const STAY_MAX_HOURS = Number(process.env.STAY_MAX_HOURS) || 24;

async function handleStay(deps: WatcherDeps, cmd: VoiceCommand): Promise<VoiceResult> {
  const session = firstActiveSession(deps);
  if (!session || session.state !== "recording") {
    return {
      requestId: cmd.requestId,
      ok: false,
      message: "no active voice session for /stay (use /codey join first)",
      completedAt: now(),
    };
  }
  // Cap to STAY_MAX_HOURS (default 24). Default duration also 24h.
  const requested = cmd.stayHours ?? STAY_MAX_HOURS;
  const hours = Math.min(Math.max(requested, 0.1), STAY_MAX_HOURS);
  const ms = Math.floor(hours * 3_600_000);
  session.setPersistent(ms);
  const until = new Date(Date.now() + ms);
  const hh = String(until.getHours()).padStart(2, "0");
  const mm = String(until.getMinutes()).padStart(2, "0");
  return {
    requestId: cmd.requestId,
    ok: true,
    message:
      `🌀 stay ON — ${hours}h (until ${hh}:${mm}) in **${session.channelName}**\n` +
      `auto-leave-alone + auto-leave-silence are SKIPPED until then`,
    guildId: session.guildId,
    channelId: session.channelId,
    channelName: session.channelName,
    completedAt: now(),
  };
}

async function handleUnstay(deps: WatcherDeps, cmd: VoiceCommand): Promise<VoiceResult> {
  const session = firstActiveSession(deps);
  if (!session) {
    return {
      requestId: cmd.requestId,
      ok: false,
      message: "no active voice session",
      completedAt: now(),
    };
  }
  const wasPersistent = session.isPersistent();
  session.clearPersistent();
  return {
    requestId: cmd.requestId,
    ok: true,
    message: wasPersistent
      ? `🌀 stay OFF — auto-leave watchers active again`
      : `🌀 not in stay mode (already off)`,
    guildId: session.guildId,
    channelId: session.channelId,
    channelName: session.channelName,
    completedAt: now(),
  };
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m${rs > 0 ? `${rs}s` : ""}`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h${rm > 0 ? `${rm}m` : ""}`;
}

function writeResult(result: VoiceResult): void {
  const path = join(VOICE_RESULT_DIR, `${result.requestId}.json`);
  try {
    writeFileSync(path, JSON.stringify(result, null, 2));
    console.log(
      `[cmd-watcher] result ${result.requestId} ok=${result.ok} — ${result.message.slice(0, 80)}`,
    );
  } catch (e: any) {
    console.warn(`[cmd-watcher] write result failed: ${e?.message ?? e}`);
  }
}
