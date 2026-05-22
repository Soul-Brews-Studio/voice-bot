#!/usr/bin/env bun
/**
 * Codey Voice Bot — entry point
 *
 * Slash command handlers (in-guild):
 *   /codey join   — joinVoiceChannel where the invoker currently sits
 *   /codey leave  — flush transcript + destroy connection
 *   /codey save   — flush transcript snapshot, keep recording
 *   /codey status — show session state, chunks, segments
 *   /codey note   — add manual note to transcript
 *
 * Cross-channel commands (via VOICE_CMD_DIR file IPC):
 *   /voice-in <channelId>   — join (works from TG/DM/session via pollers)
 *   /voice-out              — flush + leave
 *
 * Polish:
 *   - Auto-flush transcript every AUTO_FLUSH_MS (default 15 min)
 *   - Auto-leave if alone in voice channel for AUTO_LEAVE_ALONE_MS (default 5 min)
 *   - Periodic memory usage log every MEMORY_REPORT_MS (default 10 min)
 *
 * Run:
 *   bun src/index.ts          (foreground)
 *   bun --watch src/index.ts  (dev)
 *   tmux new -s codey-voice -d "bun src/index.ts"
 */
import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  type ChatInputCommandInteraction,
  type GuildMember,
  type VoiceBasedChannel,
  type VoiceState,
} from "discord.js";
// sodium-native: required for Discord's new AEAD encryption (xchacha20poly1305_ietf).
// tweetnacl alone doesn't support it → packets get dropped silently → 0 chunks captured.
import "sodium-native";
import { VoiceSession, formatDuration } from "./voice-session.ts";
import { startCommandWatcher } from "./command-watcher.ts";
import { handoff } from "./handoff.ts";
import {
  setSpeakMode,
  setTriggerMode,
  addAllowedTriggerUser,
  removeAllowedTriggerUser,
  getAllowedTriggerUsers,
  type TriggerMode,
} from "./speak-state.ts";
import { requestClaudeReply, cleanupRequest } from "./think-bridge.ts";
import { sttBackend } from "./transcriber.ts";
import {
  archiveSessionInBackground,
  sessionIdFromFilepath,
} from "./session-archive.ts";
import { YOI_BASE_NAMES, ALIAS_TO_SUBCOMMAND } from "./commands.ts";
import { startUiServer, stopUiServer } from "./ui-server.ts";
import { startRemoteControlPoller, stopRemoteControlPoller } from "./remote-control-poller.ts";
import { ttsBackend } from "./tts.ts";
import { setActiveVoice, getActiveProfile, type VoiceProfile } from "./voice-config.ts";
import {
  startWhisperServer,
  stopWhisperServer,
} from "./stt/whisperServerManager.ts";
import { writePidFile, unlinkPidFile } from "./pid-file.ts";
import { armAutoShutdown, trackPendingArchive } from "./auto-shutdown.ts";

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("[codey-voice] DISCORD_TOKEN missing in .env — copy from root .env");
  process.exit(1);
}

const OWNER_IDS = new Set(
  (process.env.DC_OWNER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
if (OWNER_IDS.size === 0) {
  console.warn(
    "[codey-voice] ⚠️ DC_OWNER_IDS is empty — slash commands will be ignored for ALL users",
  );
}

const AUTO_FLUSH_MS = Number(process.env.AUTO_FLUSH_MS) || 15 * 60 * 1000;
const AUTO_LEAVE_ALONE_MS = Number(process.env.AUTO_LEAVE_ALONE_MS) || 5 * 60 * 1000;
const AUTO_LEAVE_SILENCE_MS = Number(process.env.AUTO_LEAVE_SILENCE_MS) || 15 * 60 * 1000;
const MEMORY_REPORT_MS = Number(process.env.MEMORY_REPORT_MS) || 10 * 60 * 1000;
const SILENCE_THRESHOLD_MS = Number(process.env.SILENCE_THRESHOLD_MS) || 1500;
const MAX_CHUNK_MS = Number(process.env.MAX_CHUNK_MS) || 30_000;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel],
});

const sessions = new Map<string, VoiceSession>();
const aloneSince = new Map<string, number>(); // guildId → ms when bot became alone

const FALLBACK_GUILD_ID = process.env.DISCORD_GUILD_ID;

/**
 * Resolve which guild to act on for non-join commands:
 *   1. interaction.guildId (when called from a guild channel)
 *   2. The first guild with an active recording session
 *   3. process.env.DISCORD_GUILD_ID fallback (single-guild default)
 */
function resolveActiveGuildId(
  interaction: ChatInputCommandInteraction,
): string | null {
  if (interaction.guildId) return interaction.guildId;
  for (const [gid, s] of sessions) {
    if (s.state !== "idle") return gid;
  }
  return FALLBACK_GUILD_ID ?? null;
}

function sessionFor(guildId: string): VoiceSession {
  let s = sessions.get(guildId);
  if (!s) {
    s = new VoiceSession();
    sessions.set(guildId, s);
  }
  return s;
}

client.once(Events.ClientReady, (c) => {
  console.log(
    `[codey-voice] 🌀 Codey ready — logged in as ${c.user.tag} (id=${c.user.id})`,
  );
  console.log(
    `[codey-voice] In ${c.guilds.cache.size} guild(s); slash commands handled per-guild`,
  );
  console.log(
    `[codey-voice] config: auto-flush=${AUTO_FLUSH_MS}ms auto-leave-alone=${AUTO_LEAVE_ALONE_MS}ms auto-leave-silence=${AUTO_LEAVE_SILENCE_MS}ms mem-report=${MEMORY_REPORT_MS}ms`,
  );
  startCommandWatcher({ client, sessionFor, allSessions: () => sessions.values() });
  startUiServer();
  startRemoteControlPoller();
  startAutoLeaveWatcher();
  startAutoLeaveSilenceWatcher();
  startPersistentCapWatcher();
  startMemoryReporter();
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const cmdName = interaction.commandName;
  const isBase = YOI_BASE_NAMES.has(cmdName);
  const aliasSub = ALIAS_TO_SUBCOMMAND[cmdName];
  if (!isBase && !aliasSub) return;

  // Owner-only gate: silent ignore for anyone not in DC_OWNER_IDS.
  // (Per CLAUDE.md: "stay silent" for unauthorized — no refusal message
  //  to avoid leaking the rule + social-engineering surface.)
  if (!OWNER_IDS.has(interaction.user.id)) {
    console.log(
      `[codey-voice] ignored /${cmdName} from non-owner user=${interaction.user.id} (${interaction.user.username})`,
    );
    return;
  }

  // Resolve subcommand: from interaction (for /codey /y) or from alias map.
  const sub = isBase ? interaction.options.getSubcommand() : aliasSub!;

  try {
    switch (sub) {
      case "help":
        await handleHelp(interaction);
        break;
      case "join":
        await handleJoin(interaction);
        break;
      case "leave":
        await handleLeave(interaction);
        break;
      case "save":
        await handleSave(interaction);
        break;
      case "note":
        await handleNote(interaction);
        break;
      case "status":
        await handleStatus(interaction);
        break;
      case "speak-on":
        await handleSpeakToggle(interaction, true);
        break;
      case "speak-off":
        await handleSpeakToggle(interaction, false);
        break;
      case "say":
        await handleSay(interaction);
        break;
      case "think":
        await handleThink(interaction);
        break;
      case "trigger":
        await handleTriggerMode(interaction);
        break;
      case "voice":
        await handleVoice(interaction);
        break;
      case "stay":
        await handleStay(interaction);
        break;
      case "unstay":
        await handleUnstay(interaction);
        break;
      default:
        await interaction.reply({
          content: `🌀 ไม่รู้จัก subcommand \`${sub}\` ค่ะ`,
          flags: MessageFlags.Ephemeral,
        });
    }
  } catch (e: any) {
    console.error(`[codey-voice] interaction error /codey ${sub}:`, e?.message || e);
    const errMsg = `🌀 เกิดข้อผิดพลาด: ${e?.message ?? "unknown"}`;
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: errMsg, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: errMsg, flags: MessageFlags.Ephemeral });
    }
  }
});

async function handleHelp(interaction: ChatInputCommandInteraction) {
  const help =
    `🌀 **โคดี้ — Discord voice transcriber**\n` +
    `_ตัวช่วยฟัง / ถอดเสียง / ตอบกลับ ในห้อง voice ค่ะ_\n\n` +
    `**📋 คำสั่ง (slash) — ใช้ได้ทั้งใน guild + DM กับ Codey-Oracle**\n` +
    `\`/codey help\` — โชว์ help นี้\n` +
    `\`/codey join [channel-id]\` — โคดี้เข้า voice channel\n` +
    `   • ใน guild: ไม่ต้องใส่ id (ตามพี่)  • ใน DM: ต้องใส่ \`channel-id\`\n` +
    `\`/codey leave\` — ออก + save transcript + handoff\n` +
    `\`/codey save\` — snapshot transcript ระหว่างทาง (ยังบันทึกอยู่)\n` +
    `\`/codey status\` — ดู state, duration, segments, participants\n` +
    `\`/codey note <text>\` — แทรกโน้ตลงใน transcript\n` +
    `\`/codey speak-on\` — un-mute mic + เปิด trigger reply\n` +
    `\`/codey speak-off\` — mute mic + ปิด trigger (ฟังเงียบๆ)\n` +
    `\`/codey say <text>\` — ให้โคดี้พูดข้อความนี้เข้า voice channel ทันที (Leda TTS)\n` +
    `\`/codey think <msg>\` — ส่ง text เข้า Claude session — Claude คิด + TTS ตอบใน voice\n` +
    `\`/codey trigger <mode>\` — เลือกว่าใคร trigger ได้: \`anyone\` (ทุกคน) หรือ \`owner-only\` (เฉพาะพี่)\n\n` +
    `**💬 DM trigger — Discord DM หรือ Telegram DM ก็ได้**\n` +
    `\`/voice-in <channelId>\` — join channel ตาม ID\n` +
    `\`/voice-out\` — ออก + save\n` +
    `\`/speak-on\` \`/speak-off\` — เหมือน slash version\n\n` +
    `**🚦 ขั้นตอนการใช้งานทั่วไป**\n` +
    `1. เข้า voice channel ก่อน\n` +
    `2. \`/codey join\` → โคดี้ตามเข้า (เริ่มแบบ mute, แค่ฟัง+ถอดเสียง)\n` +
    `3. \`/codey speak-on\` → un-mute, พร้อมตอบเสียง\n` +
    `4. พูด **"โคดี้ตอบหน่อย ..."** → โคดี้ตอบกลับด้วย TTS (Leda voice)\n` +
    `5. \`/codey speak-off\` → mute กลับ, แค่ฟัง+ถอด\n` +
    `6. \`/codey save\` ระหว่างทาง / \`/codey note <text>\` แทรกโน้ต\n` +
    `7. \`/codey leave\` → save .md + copy ไป ~/Downloads/codey-discord-voice/ + ping Codey ผ่าน maw\n\n` +
    `**⚙️ ค่าตั้ง auto:**\n` +
    `• auto-flush transcript ทุก 15 นาที\n` +
    `• auto-leave ถ้าอยู่คนเดียวเกิน 5 นาที หรือ เงียบเกิน 15 นาที\n` +
    `• transcribe per-speaker (ถอดเสียงแยกคน)\n` +
    `• trigger phrase: "โคดี้/หอย/ยอย/codey ตอบ/answer/reply"\n`;

  await interaction.reply({
    content: help,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleJoin(interaction: ChatInputCommandInteraction) {
  const explicitChannelId = interaction.options.getString("channel-id");
  let voiceChannel: VoiceBasedChannel | null = null;
  let guildId: string | null = null;

  if (explicitChannelId) {
    // DM path OR guild user wants to override their current voice channel
    try {
      const ch = await client.channels.fetch(explicitChannelId);
      if (!ch || !ch.isVoiceBased() || !("guildId" in ch) || !ch.guildId) {
        await interaction.reply({
          content: `🌀 channel id \`${explicitChannelId}\` ไม่ใช่ voice channel ค่ะ`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      voiceChannel = ch as VoiceBasedChannel;
      guildId = ch.guildId;
    } catch (e: any) {
      await interaction.reply({
        content: `🌀 fetch channel ล้มเหลว: ${e?.message ?? e}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  } else if (interaction.guildId) {
    // Guild context, no channel-id given → use the caller's current voice channel
    guildId = interaction.guildId;
    const member = interaction.member as GuildMember | null;
    voiceChannel = member?.voice.channel ?? null;
    if (!voiceChannel) {
      await interaction.reply({
        content:
          "🌀 พี่ต้องอยู่ใน voice channel ก่อนค่ะ — หรือใส่ `channel-id` parameter",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  } else {
    // DM context, no channel-id → can't auto-resolve
    await interaction.reply({
      content:
        "🌀 ใน DM ต้องใส่ `channel-id` ค่ะ — เช่น `/codey join channel-id:1500510701519634546`",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const session = sessionFor(guildId);
  if (session.state !== "idle") {
    await interaction.reply({
      content: `🌀 โคดี้อยู่ใน **${session.channelName}** อยู่แล้วค่ะ (state: ${session.state})\nใช้ \`/codey leave\` ก่อนถ้าจะย้าย`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await session.connect({
    channelId: voiceChannel.id,
    guildId,
    channelName: voiceChannel.name,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    guild: voiceChannel.guild,
    silenceThresholdMs: SILENCE_THRESHOLD_MS,
    maxChunkMs: MAX_CHUNK_MS,
    autoFlushMs: AUTO_FLUSH_MS,
  });
  // Remember where the join command came from so leave can send the transcript there.
  session.replyChannelId = interaction.channelId;

  await interaction.editReply(
    `🌀 โคดี้เข้า **${voiceChannel.name}** แล้วค่ะ — เริ่ม transcribing\n` +
      `_(auto-save ทุก ${Math.floor(AUTO_FLUSH_MS / 60000)} นาที, auto-leave ถ้าคนเดียวเกิน ${Math.floor(AUTO_LEAVE_ALONE_MS / 60000)} นาที หรือ เงียบเกิน ${Math.floor(AUTO_LEAVE_SILENCE_MS / 60000)} นาที)_`,
  );
  console.log(
    `[codey-voice] joined channel=${voiceChannel.id} (${voiceChannel.name}) in guild=${guildId} via=${interaction.guildId ? "guild" : "DM"}`,
  );
}

async function replyNoGuild(interaction: ChatInputCommandInteraction) {
  await interaction.reply({
    content:
      "🌀 หาไม่เจอว่า guild ไหนค่ะ — ยังไม่มี active session + ไม่ได้ตั้ง DISCORD_GUILD_ID",
    flags: MessageFlags.Ephemeral,
  });
}

async function handleLeave(interaction: ChatInputCommandInteraction) {
  const guildId = resolveActiveGuildId(interaction);
  if (!guildId) return replyNoGuild(interaction);
  const session = sessions.get(guildId);

  if (!session || session.state === "idle") {
    await interaction.reply({
      content: "🌀 โคดี้ไม่ได้อยู่ใน voice channel ค่ะ",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();
  let filepath = "";
  let segmentCount = 0;
  const participants = session.getParticipants();
  const costReport = session.getCostReport();
  try {
    const flushed = await session.flush();
    filepath = flushed.filepath;
    segmentCount = flushed.segments;
  } catch (e: any) {
    console.warn(`[codey-voice] flush on leave failed:`, e?.message ?? e);
  }
  const { chunks, durationMs, channelName } = await session.disconnect();
  const duration = formatDuration(durationMs);

  if (filepath) {
    handoff(filepath, {
      channelName,
      chunkCount: chunks,
      segmentCount,
      durationMs,
      participants,
      costReport,
    }).catch((e) => console.warn("[codey-voice] handoff failed:", e));
  }
  armAutoShutdown("slash /codey leave");

  await interaction.editReply(
    `🌀 โคดี้ออกจาก **${channelName ?? "voice channel"}** แล้วค่ะ\n` +
      `- Chunks: ${chunks}\n- Segments transcribed: ${segmentCount}\n` +
      `- Duration: ${duration}\n- Transcript: \`${filepath || "(empty)"}\`\n\n` +
      `**💰 Cost (this session):**\n\`\`\`\n${costReport}\n\`\`\`\n` +
      `_(copied to ~/Downloads/codey-discord-voice/ + notified Codey for summary)_`,
  );
  console.log(
    `[codey-voice] left guild=${guildId} channel=${channelName} after ${duration}, ${chunks} chunks, ${segmentCount} segments → ${filepath}`,
  );
}

async function handleSave(interaction: ChatInputCommandInteraction) {
  const guildId = resolveActiveGuildId(interaction);
  if (!guildId) return replyNoGuild(interaction);
  const session = sessions.get(guildId);

  if (!session || session.state === "idle") {
    await interaction.reply({
      content: "🌀 โคดี้ไม่ได้อยู่ใน voice channel ค่ะ (nothing to save)",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const { filepath, segments } = await session.flush();
    await interaction.editReply(
      `🌀 Saved snapshot: ${segments} segments → \`${filepath}\`\n_(still recording)_`,
    );
  } catch (e: any) {
    await interaction.editReply(`🌀 Save failed: ${e?.message ?? e}`);
  }
}

async function handleNote(interaction: ChatInputCommandInteraction) {
  const guildId = resolveActiveGuildId(interaction);
  if (!guildId) return replyNoGuild(interaction);
  const session = sessions.get(guildId);
  const text = interaction.options.getString("text", true);
  const author =
    (interaction.member as GuildMember | null)?.displayName ??
    interaction.user.username;

  if (!session || session.state !== "recording") {
    await interaction.reply({
      content: "🌀 โคดี้ไม่ได้กำลังบันทึก voice อยู่ ใช้ \`/codey join\` ก่อนค่ะ",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  session.addNote(text, author);
  await interaction.reply({
    content: `🌀 จดโน้ตของ ${author} แล้วค่ะ — \`${text.slice(0, 80)}${text.length > 80 ? "..." : ""}\``,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleStatus(interaction: ChatInputCommandInteraction) {
  const guildId = resolveActiveGuildId(interaction);
  if (!guildId) return replyNoGuild(interaction);
  const session = sessions.get(guildId);
  const status = session?.getStatus();

  if (!status || status.state === "idle") {
    await interaction.reply({
      content: "🌀 **สถานะโคดี้**\n- ยังไม่ join voice channel ค่ะ",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const duration = status.startedAt
    ? formatDuration(Date.now() - status.startedAt)
    : "0s";
  const segments = session?.getSegmentCount() ?? 0;
  const participants = session?.getParticipants() ?? [];

  await interaction.reply({
    content:
      `🌀 **สถานะโคดี้**\n` +
      `- State: ${status.state}\n` +
      `- Channel: **${status.channelName}** (id=${status.channelId})\n` +
      `- Duration: ${duration}\n` +
      `- Chunks: ${status.chunkCount}\n` +
      `- Segments transcribed: ${segments}\n` +
      `- Participants: ${participants.join(", ") || "(none yet)"}`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleVoice(interaction: ChatInputCommandInteraction) {
  const profile = interaction.options.getString("profile", true) as VoiceProfile;
  try {
    const resolved = setActiveVoice(profile);
    await interaction.reply({
      content:
        `🌀 เปลี่ยนเสียงเป็น **${resolved.label}**\n` +
        `• Backend: \`${resolved.backend}\`  • Voice: \`${resolved.voice}\`  • Cost: ${resolved.costNote}\n` +
        `_(มีผลกับ reply ถัดไปทันที — ไม่ต้อง restart)_`,
      flags: MessageFlags.Ephemeral,
    });
    console.log(`[codey-voice] voice profile → ${profile} (${resolved.backend}/${resolved.voice})`);
  } catch (e: any) {
    await interaction.reply({
      content: `🌀 เปลี่ยนเสียงไม่สำเร็จ: ${e?.message ?? e}`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

const STAY_MAX_HOURS = Number(process.env.STAY_MAX_HOURS) || 24;

async function handleStay(interaction: ChatInputCommandInteraction) {
  const guildId = resolveActiveGuildId(interaction);
  if (!guildId) return replyNoGuild(interaction);
  const session = sessions.get(guildId);
  if (!session || session.state !== "recording") {
    await interaction.reply({
      content: "🌀 ต้อง `/codey join` ก่อนถึงจะ `/codey stay` ได้ค่ะ",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const requested = interaction.options.getNumber("hours") ?? STAY_MAX_HOURS;
  const hours = Math.min(Math.max(requested, 0.1), STAY_MAX_HOURS);
  const ms = Math.floor(hours * 3_600_000);
  session.setPersistent(ms);
  const until = new Date(Date.now() + ms);
  const hh = String(until.getHours()).padStart(2, "0");
  const mm = String(until.getMinutes()).padStart(2, "0");
  await interaction.reply({
    content:
      `🌀 stay ON ใน **${session.channelName}** — ${hours} ชม. (อยู่จนถึง ~${hh}:${mm})\n` +
      `_auto-leave-alone + auto-leave-silence ถูกข้าม จนกว่าจะหมดเวลาหรือ \`/codey unstay\`_`,
    flags: MessageFlags.Ephemeral,
  });
  console.log(`[codey-voice] stay ON guild=${guildId} for ${hours}h (until ${until.toISOString()})`);
}

async function handleUnstay(interaction: ChatInputCommandInteraction) {
  const guildId = resolveActiveGuildId(interaction);
  if (!guildId) return replyNoGuild(interaction);
  const session = sessions.get(guildId);
  if (!session || session.state === "idle") {
    await interaction.reply({
      content: "🌀 ไม่ได้อยู่ใน voice channel ค่ะ",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const was = session.isPersistent();
  session.clearPersistent();
  await interaction.reply({
    content: was
      ? `🌀 stay OFF — auto-leave watchers กลับมาทำงานปกติแล้วนะคะ`
      : `🌀 ตอนนี้ไม่ได้อยู่ใน stay mode อยู่แล้วค่ะ`,
    flags: MessageFlags.Ephemeral,
  });
  console.log(`[codey-voice] stay OFF guild=${guildId} (was=${was})`);
}

async function handleTriggerMode(interaction: ChatInputCommandInteraction) {
  const guildId = resolveActiveGuildId(interaction);
  if (!guildId) return replyNoGuild(interaction);
  const action = interaction.options.getString("action", true);
  const user = interaction.options.getUser("user", false);

  const formatList = (): string => {
    const ids = getAllowedTriggerUsers(guildId);
    if (ids.length === 0) return "_(allow-list ว่างเปล่า)_";
    return ids.map((id) => `<@${id}>`).join(", ");
  };

  switch (action) {
    case "anyone":
    case "owner-only":
    case "selected": {
      setTriggerMode(guildId, action as TriggerMode);
      const desc = {
        anyone: "ทุกคนในห้อง trigger ได้",
        "owner-only": "เฉพาะ DC_OWNER_IDS เท่านั้น",
        selected: `ตามรายชื่อ — ปัจจุบัน: ${formatList()}`,
      }[action];
      await interaction.reply({
        content: `🌀 Trigger mode → **${action}** — ${desc}`,
        flags: MessageFlags.Ephemeral,
      });
      console.log(`[codey-voice] trigger-mode → ${action} guild=${guildId}`);
      break;
    }
    case "add":
    case "remove": {
      if (!user) {
        await interaction.reply({
          content: `🌀 \`/codey trigger ${action}\` ต้องระบุ \`user\` ด้วยค่ะ`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (action === "add") {
        addAllowedTriggerUser(guildId, user.id);
        await interaction.reply({
          content:
            `🌀 เพิ่ม <@${user.id}> เข้า allow-list แล้วค่ะ\n` +
            `(จะมีผลเมื่อ \`/codey trigger selected\`)\nlist: ${formatList()}`,
          flags: MessageFlags.Ephemeral,
        });
      } else {
        const removed = removeAllowedTriggerUser(guildId, user.id);
        await interaction.reply({
          content: removed
            ? `🌀 ลบ <@${user.id}> ออกแล้ว — list: ${formatList()}`
            : `🌀 <@${user.id}> ไม่อยู่ใน allow-list — list: ${formatList()}`,
          flags: MessageFlags.Ephemeral,
        });
      }
      break;
    }
    case "list":
      await interaction.reply({
        content: `🌀 Allow-list ของ guild นี้: ${formatList()}`,
        flags: MessageFlags.Ephemeral,
      });
      break;
    default:
      await interaction.reply({
        content: `🌀 ไม่รู้จัก action \`${action}\` ค่ะ`,
        flags: MessageFlags.Ephemeral,
      });
  }
}

async function handleThink(interaction: ChatInputCommandInteraction) {
  const text = interaction.options.getString("message", true);
  const guildId = resolveActiveGuildId(interaction);
  if (!guildId) return replyNoGuild(interaction);
  const session = sessions.get(guildId);
  if (!session || session.state !== "recording") {
    await interaction.reply({
      content:
        "🌀 ต้องให้โคดี้อยู่ใน voice channel ก่อนค่ะ (ใช้ `/codey join` ก่อน) — `/codey think` ตอบกลับเป็น TTS",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const { reply, requestId } = await requestClaudeReply({
      triggerText: text,
      channelName: session.channelName ?? "voice",
      context: [],
      speakerCount: 0,
      timeoutMs: 120_000,
      mode: "text",
    });
    cleanupRequest(requestId).catch(() => {});
    if (reply) {
      await session.speakReply(reply);
      const preview = reply.length > 200 ? reply.slice(0, 200) + "..." : reply;
      await interaction.editReply(
        `🌀 พูดแล้วใน **${session.channelName}**:\n> ${preview}`,
      );
    } else {
      await interaction.editReply(
        "🌀 timeout — Claude session ไม่ตอบใน 120s (อาจ busy ทำงานอื่นอยู่)",
      );
    }
  } catch (e: any) {
    await interaction.editReply(`🌀 think failed: ${e?.message ?? e}`);
  }
}

async function handleSay(interaction: ChatInputCommandInteraction) {
  const guildId = resolveActiveGuildId(interaction);
  if (!guildId) return replyNoGuild(interaction);
  const session = sessions.get(guildId);
  const text = interaction.options.getString("text", true);
  if (!session || session.state !== "recording") {
    await interaction.reply({
      content: "🌀 โคดี้ยังไม่อยู่ใน voice channel ค่ะ — ใช้ `/codey join` ก่อน",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    await session.speakReply(text);
    await interaction.editReply(
      `🌀 พูดแล้วค่ะ — \`${text.slice(0, 100)}${text.length > 100 ? "..." : ""}\``,
    );
  } catch (e: any) {
    await interaction.editReply(`🌀 พูดไม่สำเร็จ: ${e?.message ?? e}`);
  }
}

async function handleSpeakToggle(
  interaction: ChatInputCommandInteraction,
  on: boolean,
) {
  const guildId = resolveActiveGuildId(interaction);
  if (!guildId) return replyNoGuild(interaction);
  setSpeakMode(guildId, on);
  const session = sessions.get(guildId);
  let muteNote = "";
  if (session && session.state === "recording") {
    try {
      session.setSelfMute(!on);
      muteNote = on ? " (mic เปิด)" : " (mic mute)";
    } catch (e: any) {
      muteNote = ` (mute toggle failed: ${e?.message ?? e})`;
    }
  } else {
    muteNote = " (ยังไม่ join voice — จะ apply ตอน /codey join)";
  }
  await interaction.reply({
    content: on
      ? `🌀 Speak mode = **ON** — โคดี้จะตอบเมื่อมีคนพูด 'โคดี้ตอบหน่อย' ค่ะ${muteNote}`
      : `🌀 Speak mode = **OFF** — โคดี้ฟังอย่างเดียว ไม่ตอบ${muteNote}`,
    flags: MessageFlags.Ephemeral,
  });
  console.log(`[codey-voice] speak-${on ? "on" : "off"} via slash (guild=${guildId})`);
}

// === Polish: auto-leave when alone ===
async function performAutoLeave(
  session: VoiceSession,
  reason: string,
): Promise<void> {
  console.log(
    `[codey-voice] auto-leaving ${session.channelName} (${reason})`,
  );
  let filepath = "";
  let segmentCount = 0;
  const channelName = session.channelName ?? "voice";
  const channelId = session.channelId;
  const guildId = session.guildId;
  // Capture before disconnect() resets meta.
  const joinedAt = session.startedAt ?? Date.now();
  const participants = session.getParticipants();
  const costReport = session.getCostReport();
  try {
    const flushed = await session.flush();
    filepath = flushed.filepath;
    segmentCount = flushed.segments;
  } catch (e) {
    console.warn("[codey-voice] auto-leave flush failed:", e);
  }
  const { chunks, durationMs } = await session.disconnect();
  if (filepath) {
    const replyChannelId = session.replyChannelId;
    handoff(filepath, {
      channelName,
      chunkCount: chunks,
      segmentCount,
      durationMs,
      participants,
      costReport,
      replyChannelId,
      voiceChannelId: channelId,
    }).catch((e) =>
      console.warn("[codey-voice] auto-leave handoff failed:", e),
    );
    // Archive to VPS. Clean + summary + Discord send handled by Claude session.
    const archivePromise = archiveSessionInBackground({
      sessionId: sessionIdFromFilepath(filepath),
      filepath,
      channelName,
      channelId,
      guildId,
      joinedAt,
      leftAt: Date.now(),
      durationMs,
      participants,
      segmentCount,
    });
    trackPendingArchive(archivePromise);
  }
  armAutoShutdown(`auto-leave: ${reason}`);
}

function startAutoLeaveWatcher() {
  if (AUTO_LEAVE_ALONE_MS <= 0) {
    console.log("[codey-voice] auto-leave-when-alone disabled");
    return;
  }
  setInterval(async () => {
    for (const [guildId, session] of sessions) {
      if (session.state !== "recording" || !session.channelId) continue;
      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;
      const channel = guild.channels.cache.get(session.channelId);
      if (!channel || !channel.isVoiceBased()) continue;
      const vc = channel as VoiceBasedChannel;
      const humans = vc.members.filter((m) => !m.user.bot);
      if (humans.size === 0) {
        // Persistent mode (/codey stay) overrides alone auto-leave —
        // user explicitly wants the bot to stay regardless of who's listening.
        if (session.isPersistent()) {
          aloneSince.delete(guildId);
          continue;
        }
        if (!aloneSince.has(guildId)) {
          aloneSince.set(guildId, Date.now());
          console.log(
            `[codey-voice] alone in ${session.channelName} (guild ${guildId}) — countdown started`,
          );
        } else if (Date.now() - aloneSince.get(guildId)! > AUTO_LEAVE_ALONE_MS) {
          aloneSince.delete(guildId);
          await performAutoLeave(session, `alone > ${AUTO_LEAVE_ALONE_MS}ms`);
        }
      } else {
        aloneSince.delete(guildId);
      }
    }
  }, 30_000);
}

// === Polish: auto-leave on silence ===
// Logs out the bot if no human has spoken in the channel for AUTO_LEAVE_SILENCE_MS,
// even if humans are still sitting in the channel (left the laptop, fell asleep,
// went AFK, etc.). Complements alone-leave which only fires when the channel
// empties of humans.
function startAutoLeaveSilenceWatcher() {
  if (AUTO_LEAVE_SILENCE_MS <= 0) {
    console.log("[codey-voice] auto-leave-on-silence disabled");
    return;
  }
  console.log(
    `[codey-voice] auto-leave-on-silence: ${Math.floor(AUTO_LEAVE_SILENCE_MS / 60_000)} min`,
  );
  setInterval(async () => {
    for (const session of sessions.values()) {
      if (session.state !== "recording") continue;
      // Persistent mode skips the silence guard — user opted in to long idle.
      if (session.isPersistent()) continue;
      const silentMs = Date.now() - session.getLastHumanSpeechAt();
      if (silentMs > AUTO_LEAVE_SILENCE_MS) {
        const mins = Math.floor(silentMs / 60_000);
        await performAutoLeave(
          session,
          `silence ${mins}min > ${Math.floor(AUTO_LEAVE_SILENCE_MS / 60_000)}min`,
        );
      }
    }
  }, 60_000); // check every 1 min — silence timeout is long, no need for finer
}

// === Polish: persistent-mode hard cap ===
// Even with /codey stay, hard-leave when persistentUntil timestamp passes.
// Prevents accidentally-forever-running sessions when the user forgets to leave.
function startPersistentCapWatcher() {
  setInterval(async () => {
    const now = Date.now();
    for (const session of sessions.values()) {
      if (session.state !== "recording") continue;
      const until = session.getPersistentUntil();
      if (until > 0 && now >= until) {
        session.clearPersistent();
        const hours = Math.floor((now - (session.startedAt ?? now)) / 3_600_000);
        await performAutoLeave(session, `stay expired (~${hours}h cap)`);
      }
    }
  }, 60_000);
}

// === Polish: memory monitor ===
function startMemoryReporter() {
  if (MEMORY_REPORT_MS <= 0) {
    console.log("[codey-voice] memory reporter disabled");
    return;
  }
  setInterval(() => {
    const m = process.memoryUsage();
    const fmt = (b: number) => `${(b / 1024 / 1024).toFixed(1)}MB`;
    console.log(
      `[codey-voice] mem rss=${fmt(m.rss)} heap=${fmt(m.heapUsed)}/${fmt(m.heapTotal)} ext=${fmt(m.external)}`,
    );
  }, MEMORY_REPORT_MS);
}

// Track participants: when a human joins the channel Codey is recording in,
// add them immediately to the session so the transcript header stays current.
client.on(
  Events.VoiceStateUpdate,
  (oldState: VoiceState, newState: VoiceState) => {
    if (newState.member?.user.bot) return;
    const guildId = newState.guild.id;
    const session = sessions.get(guildId);
    if (!session || session.state !== "recording" || !session.channelId) return;
    // User just joined (or moved into) the channel Codey is in.
    if (
      newState.channelId === session.channelId &&
      oldState.channelId !== session.channelId
    ) {
      const name =
        newState.member?.displayName ??
        newState.member?.user.globalName ??
        newState.member?.user.username ??
        `user:${newState.id}`;
      session.addParticipant(newState.id, name);
    }
  },
);

client.on(Events.Error, (e) => {
  console.error("[codey-voice] client error:", e);
});

// Graceful shutdown
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(sig, async () => {
    console.log(`[codey-voice] received ${sig}, flushing + disconnecting all sessions...`);
    for (const [gid, s] of sessions) {
      if (s.state !== "idle") {
        try {
          await s.flush();
        } catch {}
        try {
          await s.disconnect();
          console.log(`[codey-voice] disconnected guild=${gid}`);
        } catch (e) {
          console.warn(`[codey-voice] disconnect failed for guild=${gid}:`, e);
        }
      }
    }
    client.destroy();
    try {
      await stopWhisperServer();
    } catch {}
    try {
      stopUiServer();
    } catch {}
    try {
      stopRemoteControlPoller();
    } catch {}
    try {
      unlinkPidFile();
    } catch {}
    process.exit(0);
  });
}

console.log(
  `[codey-voice] starting... STT=${sttBackend} TTS=${ttsBackend()} (voice profile=${getActiveProfile()})`,
);

// Boot local whisper.cpp server before connecting to Discord, so the first
// transcribe call doesn't race the model load (~3s on M-series).
if (sttBackend === "whisper-cpp") {
  try {
    await startWhisperServer();
  } catch (e: any) {
    console.error(`[codey-voice] whisper-server failed to start: ${e?.message ?? e}`);
    console.error("[codey-voice] set STT_BACKEND=google in .env to fall back, or fix the issue and retry");
    process.exit(1);
  }
}
await client.login(token);
writePidFile();
