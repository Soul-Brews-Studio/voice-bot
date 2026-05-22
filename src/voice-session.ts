/**
 * VoiceSession — per-guild voice connection state machine.
 *
 * Lifecycle:
 *   idle → connecting → recording → leaving → idle
 *
 * Phase 3: connect/disconnect + status (done).
 * Phase 4 (current): wires receiver.speaking events to per-speaker
 * audio capture pipeline. chunkCount increments per captured chunk.
 * Phase 5 will replace the default handler with Whisper transcription.
 */
import {
  joinVoiceChannel,
  VoiceConnectionStatus,
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  type VoiceConnection,
  type DiscordGatewayAdapterCreator,
} from "@discordjs/voice";
import {
  startSpeakerCapture,
  getRawRecorder,
  clearRawRecorder,
  type AudioChunk,
  type ChunkHandler,
} from "./audio-pipeline.ts";
import { transcribeAndCleanup } from "./transcriber.ts";
import {
  writeTranscriptFile,
  type TranscriptSegment,
} from "./transcript-writer.ts";
import { copyToDownloads } from "./handoff.ts";
import { synthesizeTts, deleteTtsFile } from "./tts.ts";
import { isSpeakMode, canTrigger, getTriggerMode } from "./speak-state.ts";
import { emitLiveEvent } from "./live-feed.ts";
import {
  generateOpinion,
  consumeLastGeminiUsage,
  type ContextSegment,
} from "./brain.ts";
import { requestClaudeReply, cleanupRequest } from "./think-bridge.ts";
import {
  roundSttSeconds,
  formatCost,
  type CostMetrics,
} from "./cost.ts";
import type { Guild } from "discord.js";

// Trigger = literal phrase "ตอบหน่อย" anywhere in the chunk.
// Why so narrow:
//   - Owner-only mode already filters by user ID, so false-positive risk
//     from common Thai usage of "ตอบหน่อย" is bounded to the owner's own
//     speech — in practice they rarely say "ตอบหน่อย" except to call Codey.
//   - Earlier name+verb matching was hostile to ASR mishears
//     (โคดี้→อย่าเอี๊ยะ/จอย/ออย) and required tuning per drift case.
// NAME_ONLY_RE retained for "near-miss" logging on lone name mentions.
// Extra trigger phrases can be added via TRIGGER_EXTRA_PHRASES (comma-sep).
// BUILTIN exact phrases — direct ways to call Codey.
// In owner-only trigger mode, false-positive risk from natural Thai usage is
// bounded to the owner's own speech, so we lean liberal.
const BUILTIN_TRIGGERS = [
  // Call by full name
  "โคดี้", "น้องโคดี้", "โคดี้จ๋า", "โคดี้จ้า",
  // Whisper-mishear variants (small + Groq Large V3 ถอดผิดหลายแบบ)
  "ขอดี", "โค้ดดี้", "โค้ดี้", "โคดี", "โค๊ดดี้",
  "โอดี", "โคลดี้", "คอลดี้", "โหดี", "พอดี้", "คอดี้", "โคดี",
  "ย้อย", "หย่อย", "ยอย", "ย่อย", "หยอด",
  "codey", "cody", "codie",
  // Action-style calls
  "ตอบหน่อย", "ช่วยตอบ", "ตอบที", "ตอบสิ", "ตอบให้หน่อย",
  // Question-style ("...ไหม Codey", "...ดิ Codey")
  "ว่าไง", "เอาไง",
];

// Fuzzy patterns — common Whisper mishears + loose spelling. Covers:
//   - "ตอบ + หน่อย/หน้า/นอย/หนอย" with optional space/tone
//   - "โคดี้" variants caught above by BUILTIN; this also catches
//     "ติดต่อไปแล้ว / อับน้อย / ฯลฯ" — known training-data artifacts
const FUZZY_TRIGGER_RE =
  /(?:ตอบ\s*(?:ห[่้]?น[่้]?[อ้า]?[ยา]?|นอย|หนอย|หน้า)|ช่วย\s*(?:ตอบ|ฟัง|บอก)|ต[่ิ]?[ดอ]?[ไป่]?ปแล้ว|ติดต่อไปแล้ว|อับน้?อย|อบน้?อย)/i;

function loadExtraTriggers(): string[] {
  const raw = process.env.TRIGGER_EXTRA_PHRASES;
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const TRIGGER_RE = new RegExp(
  `(?:${[...BUILTIN_TRIGGERS, ...loadExtraTriggers()].map(escapeRegex).join("|")})`,
  "i",
);
const NAME_ONLY_RE = /(?:โคดี้|ขอดี|codey|cody)/i; // for near-miss logging only

function isTriggered(text: string): boolean {
  return TRIGGER_RE.test(text) || FUZZY_TRIGGER_RE.test(text);
}
const CANNED_REPLY = process.env.CANNED_REPLY || "ค่ะ โคดี้ฟังอยู่ค่ะ";
const USE_BRAIN = process.env.USE_BRAIN !== "false";
// "claude-session" (default — Opus 4.7 via maw hey bridge) | "gemini" (fallback)
const BRAIN_MODE = (process.env.BRAIN_MODE || "claude-session").toLowerCase();

export type SessionState = "idle" | "connecting" | "recording" | "leaving";

export interface SessionStatus {
  state: SessionState;
  channelId?: string;
  guildId?: string;
  channelName?: string;
  startedAt?: number;
  chunkCount: number;
}

export interface ConnectArgs {
  channelId: string;
  guildId: string;
  channelName: string;
  adapterCreator: DiscordGatewayAdapterCreator;
  /** Guild reference (for resolving display names of speakers). */
  guild?: Guild;
  /** Per-chunk callback (Phase 5+: defaults to Whisper transcribe). */
  onChunk?: ChunkHandler;
  /** Silence ms before chunk auto-ends (default 1500). */
  silenceThresholdMs?: number;
  /** Max chunk ms before forced cut (default 30000). */
  maxChunkMs?: number;
  /** Final chunks shorter than this are dropped (default 1500). */
  minFinalChunkMs?: number;
  /** Auto-flush transcript to disk every N ms (default 15 min = 900000).
   *  Set 0 to disable. */
  autoFlushMs?: number;
}

export class VoiceSession {
  private _state: SessionState = "idle";
  private _connection: VoiceConnection | null = null;
  private _activeSpeakers = new Set<string>();
  private _guild?: Guild;
  private _segments: TranscriptSegment[] = [];
  private _participants = new Map<string, string>();
  private _saveCounter = 0;
  // Timestamp of the most recent human-speech chunk that produced real text
  // (excludes silence/hallucination/Codey-TTS/manual notes). Used by the silence
  // auto-leave watcher in index.ts. Initialized to startedAt on connect so a
  // fresh join doesn't immediately count as "silent for hours".
  private _lastHumanSpeechAt = 0;
  /**
   * Persistent mode — when set to a future timestamp, auto-leave watchers
   * (alone + silence) skip this session. The session still auto-leaves when
   * this timestamp passes (hard cap, default 24h via /codey stay).
   * 0 = not persistent.
   */
  private _persistentUntil = 0;
  private _autoFlushTimer?: ReturnType<typeof setInterval>;
  // Reply queue: triggers fire FIFO, one at a time, full TTS playback awaited
  // between items so audio doesn't overlap — wait for the first trigger
  // reply to finish before answering the next one.
  private _replyQueue: Array<{ triggerText: string; queuedAt: number }> = [];
  private _replyWorkerRunning = false;
  private static MAX_REPLY_QUEUE = Number(process.env.MAX_REPLY_QUEUE) || 5;
  private static STALE_REPLY_MS =
    Number(process.env.STALE_REPLY_MS) || 60_000;
  // Window for "close together" triggers — drain + merge into 1 reply.
  // Default 20s: typical brain+TTS cycle ≈10-25s, so triggers queued during
  // an active reply get merged into the NEXT reply.
  private static MERGE_WINDOW_MS =
    Number(process.env.MERGE_WINDOW_MS) || 20_000;
  // Debounce: after trigger phrase detected, wait this long for SAME speaker
  // to keep talking before firing. Lets pi-นัท say "โคดี้ ตอบ ... <pause> ...
  // เรื่อง X" without firing prematurely on the first chunk.
  private static TRIGGER_DEBOUNCE_MS =
    Number(process.env.TRIGGER_DEBOUNCE_MS) || 1_500;
  // Per-speaker pending trigger — accumulates subsequent chunks until the
  // speaker is silent for TRIGGER_DEBOUNCE_MS, then enqueues the combined text.
  private _pendingTriggers = new Map<
    string,
    { text: string; timer: ReturnType<typeof setTimeout>; startedAt: number }
  >();
  // Cost tracking (reset on connect, reported at leave)
  private _cost: CostMetrics = {
    sttBilledSec: 0,
    sttCallCount: 0,
    ttsBilledChars: 0,
    ttsCallCount: 0,
    geminiInputTokens: 0,
    geminiOutputTokens: 0,
    geminiCallCount: 0,
    claudeReplyCount: 0,
  };
  channelId?: string;
  guildId?: string;
  channelName?: string;
  startedAt?: number;
  chunkCount = 0;
  /** Discord text channel to send transcript after leave. Set on /yj via slash command. */
  replyChannelId?: string;

  get state(): SessionState {
    return this._state;
  }

  get connection(): VoiceConnection | null {
    return this._connection;
  }

  async connect(args: ConnectArgs): Promise<void> {
    if (this._state !== "idle") {
      throw new Error(`cannot connect: session is ${this._state}`);
    }
    this._state = "connecting";
    this.channelId = args.channelId;
    this.guildId = args.guildId;
    this.channelName = args.channelName;
    this._guild = args.guild;
    this.startedAt = Date.now();
    this._lastHumanSpeechAt = this.startedAt;
    this.chunkCount = 0;
    this._activeSpeakers.clear();
    this._segments = [];
    this._participants.clear();
    this._saveCounter = 0;
    this._cost = {
      sttBilledSec: 0,
      sttCallCount: 0,
      ttsBilledChars: 0,
      ttsCallCount: 0,
      geminiInputTokens: 0,
      geminiOutputTokens: 0,
      geminiCallCount: 0,
      claudeReplyCount: 0,
    };

    // Default-mute on join when speak mode is OFF for this guild
    // (so the Discord client visibly shows Codey as muted until /speak-on).
    const startMuted = !isSpeakMode(args.guildId);
    const conn = joinVoiceChannel({
      channelId: args.channelId,
      guildId: args.guildId,
      adapterCreator: args.adapterCreator,
      selfDeaf: false,
      selfMute: startMuted,
    });
    this._connection = conn;

    // Debug: trace state transitions
    conn.on("stateChange", (oldS: any, newS: any) => {
      console.log(
        `[voice-debug] state ${oldS.status} → ${newS.status}` +
          (newS.reason ? ` (reason=${newS.reason})` : "") +
          (newS.closeCode ? ` (closeCode=${newS.closeCode})` : ""),
      );
    });
    conn.on("error" as any, (err: Error) => {
      console.warn("[voice-debug] connection error:", err.message);
    });

    try {
      await entersState(conn, VoiceConnectionStatus.Ready, 15_000);
      this._state = "recording";
      emitLiveEvent({
        type: "session",
        action: "join",
        channelName: args.channelName,
        guildId: args.guildId,
      });
    } catch (e) {
      try {
        conn.destroy();
      } catch {}
      this._connection = null;
      this._resetMeta();
      this._state = "idle";
      emitLiveEvent({
        type: "error",
        source: "connect",
        message: (e as Error).message,
      });
      throw new Error(
        `failed to enter voice channel within 15s: ${(e as Error).message}`,
      );
    }

    // Wire per-speaker capture
    const cfg = {
      guildId: args.guildId,
      silenceThresholdMs: args.silenceThresholdMs ?? 1500,
      maxChunkMs: args.maxChunkMs ?? 30_000,
      chunkFlushMs:
        Number(process.env.CHUNK_FLUSH_MS) || 8_000,
      minFinalChunkMs:
        args.minFinalChunkMs ?? (Number(process.env.MIN_FINAL_CHUNK_MS) || 1_500),
    };
    const whisperHandler: ChunkHandler = async (chunk: AudioChunk) => {
      try {
        const speakerName = await this._resolveSpeakerName(chunk.userId);
        // Track STT billing — Cloud STT charges per 15-sec increment regardless
        // of whether speech was detected, so bill on every call.
        this._cost.sttCallCount++;
        this._cost.sttBilledSec += roundSttSeconds(chunk.durationMs / 1000);
        const { text, language } = await transcribeAndCleanup(chunk.wavPath);
        if (text) {
          this._segments.push({
            speaker: speakerName,
            speakerId: chunk.userId,
            startedAt: chunk.startedAt,
            endedAt: chunk.endedAt,
            text,
            language,
          });
          this._participants.set(chunk.userId, speakerName);
          this._lastHumanSpeechAt = chunk.endedAt;
          emitLiveEvent({
            type: "transcript",
            speaker: speakerName,
            speakerId: chunk.userId,
            text,
            language,
            durationMs: chunk.endedAt - chunk.startedAt,
          });
          console.log(
            `[voice-session] transcribed user=${chunk.userId} (${speakerName}) lang=${language ?? "?"} chars=${text.length}: "${text}"`,
          );
          // LIVE: incremental flush to .md after each successful segment
          // (so transcript appears in file in near-real-time, not just on /voice-out)
          try {
            await this.flush();
          } catch (e) {
            console.warn("[voice-session] live flush failed:", e);
          }

          // TTS reply on trigger phrase (only when speak mode is ON).
          // Uses TRIGGER_DEBOUNCE_MS so the speaker can keep talking past the
          // trigger word without the reply pipeline firing mid-sentence.
          const matched = isTriggered(text);
          const hasPending = this._pendingTriggers.has(chunk.userId);
          const speakOn = this.guildId && isSpeakMode(this.guildId);
          if (matched && speakOn && canTrigger(this.guildId!, chunk.userId)) {
            const mode = getTriggerMode(this.guildId!);
            console.log(
              `[voice-session] trigger MATCH text="${text.slice(0, 80)}" user=${chunk.userId} mode=${mode} — accumulating`,
            );
            this._accumulateTrigger(chunk.userId, text);
          } else if (matched && speakOn) {
            console.log(
              `[voice-session] trigger blocked (mode=${getTriggerMode(this.guildId!)}) user=${chunk.userId} text="${text.slice(0, 60)}"`,
            );
          } else if (matched && this.guildId) {
            console.log(
              `[voice-session] trigger matched but speak-mode OFF — skip reply`,
            );
          } else if (hasPending && speakOn) {
            // Same speaker continuing after trigger — extend pending so the
            // post-trigger phrase (context for the reply) gets included.
            console.log(
              `[voice-session] extending pending trigger user=${chunk.userId} with non-trigger chunk`,
            );
            this._accumulateTrigger(chunk.userId, text);
          } else if (NAME_ONLY_RE.test(text)) {
            console.log(
              `[voice-session] near-miss (name detected but no trigger verb) text="${text.slice(0, 80)}"`,
            );
          }
        } else {
          console.log(
            `[voice-session] empty transcript user=${chunk.userId} (silence/noise) — skipped`,
          );
        }
      } catch (e: any) {
        console.warn(
          `[voice-session] transcribe failed user=${chunk.userId}:`,
          e?.message ?? e,
        );
      }
    };
    const userHandler: ChunkHandler = async (chunk) => {
      this.chunkCount++;
      if (args.onChunk) await args.onChunk(chunk);
      else await whisperHandler(chunk);
    };

    conn.receiver.speaking.on("start", (userId: string) => {
      if (this._activeSpeakers.has(userId)) return;
      this._activeSpeakers.add(userId);
      // Eagerly add to participants when they start speaking — even if STT
      // fails later, the transcript header should show they were here.
      this._resolveSpeakerName(userId)
        .then((name) => this._participants.set(userId, name))
        .catch(() => {});
      try {
        startSpeakerCapture(
          conn,
          userId,
          cfg,
          async (chunk) => {
            // Sub-chunks (isPartial=true) arrive while user keeps talking;
            // the final non-partial chunk arrives when silence is reached.
            await userHandler(chunk);
          },
          () => {
            // Only delete after the underlying opus stream truly ends,
            // so periodic flushes during one utterance don't drop tracking.
            this._activeSpeakers.delete(userId);
          },
        );
      } catch (e) {
        this._activeSpeakers.delete(userId);
        console.warn(
          `[voice-session] startSpeakerCapture failed user=${userId}:`,
          e,
        );
      }
    });

    // Create the empty .md immediately at join — path is available right away
    // ไม่ต้องรอ segment แรก. Each subsequent transcription overwrites with
    // updated content (live update pattern).
    try {
      const { filepath } = await this.flush();
      console.log(`[voice-session] transcript file ready at join → ${filepath}`);
    } catch (e) {
      console.warn("[voice-session] initial empty flush failed:", e);
    }

    // Auto-flush every N ms (15-min default) — periodic checkpoint so long
    // sessions never lose work + you can read partial transcript anytime
    const autoFlushMs = args.autoFlushMs ?? 15 * 60 * 1000;
    if (autoFlushMs > 0) {
      this._autoFlushTimer = setInterval(async () => {
        if (this._segments.length === 0) return;
        try {
          const { filepath, segments } = await this.flush();
          console.log(
            `[voice-session] auto-flush: ${segments} segments → ${filepath}`,
          );
        } catch (e) {
          console.warn("[voice-session] auto-flush failed:", e);
        }
      }, autoFlushMs);
    }
  }

  async disconnect(): Promise<{
    chunks: number;
    durationMs: number;
    channelName?: string;
  }> {
    if (this._state === "idle") {
      return { chunks: 0, durationMs: 0 };
    }
    this._state = "leaving";
    const chunks = this.chunkCount;
    const durationMs = this.startedAt ? Date.now() - this.startedAt : 0;
    const channelName = this.channelName;
    emitLiveEvent({
      type: "session",
      action: "leave",
      channelName,
      guildId: this.guildId,
    });

    // Stop auto-flush timer
    if (this._autoFlushTimer) {
      clearInterval(this._autoFlushTimer);
      this._autoFlushTimer = undefined;
    }
    // Drop any in-flight trigger debounce timers — no point firing into a
    // disconnected session.
    this._clearAllPendingTriggers();

    // Save raw audio recording as one WAV file before destroying connection
    const gid = this.guildId;
    if (gid) {
      getRawRecorder(gid)
        .save(channelName ?? "voice")
        .then((p) => { if (p) console.log(`[voice-session] raw audio → ${p}`); })
        .catch((e) => console.warn(`[voice-session] raw audio save failed:`, e))
        .finally(() => clearRawRecorder(gid));
    }

    try {
      this._connection?.destroy();
    } catch (e) {
      console.warn("[voice-session] destroy error (ignored):", e);
    }
    this._connection = null;
    this._activeSpeakers.clear();
    this._resetMeta();
    this._state = "idle";

    return { chunks, durationMs, channelName };
  }

  getStatus(): SessionStatus {
    return {
      state: this._state,
      channelId: this.channelId,
      guildId: this.guildId,
      channelName: this.channelName,
      startedAt: this.startedAt,
      chunkCount: this.chunkCount,
    };
  }

  /**
   * Toggle self-mute on the active voice connection. Uses rejoin() to
   * resend the voice state op with new selfMute flag — visible in Discord
   * client as the mic icon turning red/normal.
   */
  setSelfMute(mute: boolean): void {
    if (this._state !== "recording" || !this._connection || !this.channelId) {
      throw new Error(`setSelfMute needs recording state (current=${this._state})`);
    }
    const ok = this._connection.rejoin({
      channelId: this.channelId,
      selfDeaf: false,
      selfMute: mute,
    });
    console.log(`[voice-session] setSelfMute(${mute}) rejoin=${ok}`);
  }

  /**
   * Accumulate a trigger chunk for one speaker, debouncing the actual enqueue
   * by TRIGGER_DEBOUNCE_MS. Resets the timer each new chunk arrives so the
   * speaker can continue speaking past the trigger word without firing
   * mid-sentence. The chunk pipeline already waits SILENCE_THRESHOLD_MS
   * before delivering a chunk, so consecutive chunks naturally represent
   * "phrase breaks" — the debounce catches breaks shorter than a full pause.
   */
  private _accumulateTrigger(userId: string, chunkText: string): void {
    const existing = this._pendingTriggers.get(userId);
    if (existing) {
      clearTimeout(existing.timer);
      existing.text = `${existing.text} ${chunkText}`.trim();
      existing.timer = setTimeout(
        () => this._flushPendingTrigger(userId),
        VoiceSession.TRIGGER_DEBOUNCE_MS,
      );
      console.log(
        `[voice-session] trigger pending extended user=${userId} len=${existing.text.length}`,
      );
      return;
    }
    const timer = setTimeout(
      () => this._flushPendingTrigger(userId),
      VoiceSession.TRIGGER_DEBOUNCE_MS,
    );
    this._pendingTriggers.set(userId, {
      text: chunkText,
      timer,
      startedAt: Date.now(),
    });
    console.log(
      `[voice-session] trigger pending user=${userId} (debounce ${VoiceSession.TRIGGER_DEBOUNCE_MS}ms silence)`,
    );
  }

  private _flushPendingTrigger(userId: string): void {
    const pending = this._pendingTriggers.get(userId);
    if (!pending) return;
    this._pendingTriggers.delete(userId);
    console.log(
      `[voice-session] trigger flushed user=${userId} ageMs=${Date.now() - pending.startedAt} text="${pending.text.slice(0, 80)}"`,
    );
    this._enqueueReply(pending.text);
  }

  private _clearAllPendingTriggers(): void {
    for (const { timer } of this._pendingTriggers.values()) {
      clearTimeout(timer);
    }
    this._pendingTriggers.clear();
  }

  private _enqueueReply(triggerText: string): void {
    if (this._replyQueue.length >= VoiceSession.MAX_REPLY_QUEUE) {
      console.warn(
        `[voice-session] reply queue full (${VoiceSession.MAX_REPLY_QUEUE}) — dropping trigger`,
      );
      return;
    }
    this._replyQueue.push({ triggerText, queuedAt: Date.now() });
    console.log(
      `[voice-session] queue depth=${this._replyQueue.length} workerRunning=${this._replyWorkerRunning}`,
    );
    if (!this._replyWorkerRunning) {
      this._runReplyWorker().catch((e) =>
        console.warn(
          `[voice-session] reply worker crashed: ${e?.message ?? e}`,
        ),
      );
    }
  }

  private async _runReplyWorker(): Promise<void> {
    this._replyWorkerRunning = true;
    try {
      while (this._replyQueue.length > 0 && this._state === "recording") {
        const first = this._replyQueue.shift()!;
        const merged: typeof this._replyQueue = [first];

        // Drain adjacent items if queued within MERGE_WINDOW_MS of the
        // last merged item — they'll share one combined reply instead of
        // each getting its own TTS playback (avoids spammy back-to-back
        // responses when user triggers rapidly).
        while (
          this._replyQueue.length > 0 &&
          this._replyQueue[0]!.queuedAt -
            merged[merged.length - 1]!.queuedAt <
            VoiceSession.MERGE_WINDOW_MS
        ) {
          merged.push(this._replyQueue.shift()!);
        }

        // Drop if ALL merged items are stale (first reached limit first
        // because they're ordered by queuedAt ascending)
        const oldestAge = Date.now() - first.queuedAt;
        if (oldestAge > VoiceSession.STALE_REPLY_MS) {
          console.log(
            `[voice-session] dropping ${merged.length} stale trigger(s) (oldest age=${Math.floor(oldestAge / 1000)}s)`,
          );
          continue;
        }

        let combinedTrigger: string;
        if (merged.length === 1) {
          combinedTrigger = first.triggerText;
        } else {
          combinedTrigger =
            `มีคนเรียกโคดี้ติดกัน ${merged.length} ครั้ง ` +
            `(ภายใน ${Math.floor((merged[merged.length - 1]!.queuedAt - first.queuedAt) / 1000)}s) ` +
            `— กรุณาตอบรวมเป็นคำตอบเดียวค่ะ:\n` +
            merged
              .map((m, i) => `[${i + 1}] "${m.triggerText}"`)
              .join("\n");
          console.log(
            `[voice-session] merged ${merged.length} triggers into 1 reply`,
          );
        }

        try {
          await this._handleTriggerReply(combinedTrigger);
        } catch (e: any) {
          console.warn(
            `[voice-session] reply pipeline failed: ${e?.message ?? e}`,
          );
        }
      }
    } finally {
      this._replyWorkerRunning = false;
    }
  }

  /**
   * Opinion-mode reply pipeline:
   *   1. Take last 50 transcript segments PER SPEAKER (not last 50 globally —
   *      so quiet speakers still contribute context vs. dominant talkers).
   *   2. Merge + sort chronologically → context.
   *   3. Send to Gemini brain with "give opinion" prompt.
   *   4. TTS playback.
   * Falls back to CANNED_REPLY if brain disabled or fails.
   */
  private async _handleTriggerReply(triggerText: string): Promise<void> {
    let replyText = CANNED_REPLY;
    if (USE_BRAIN) {
      try {
        const { ctx, speakerCount } = this._buildPerSpeakerContext();
        console.log(
          `[voice-session] brain-mode=${BRAIN_MODE} ctx=${ctx.length}seg/${speakerCount}spk`,
        );

        let generated = "";
        if (BRAIN_MODE === "claude-session") {
          const { reply, requestId } = await requestClaudeReply({
            triggerText,
            channelName: this.channelName ?? "voice",
            context: ctx,
            speakerCount,
          });
          if (reply) {
            generated = reply;
            this._cost.claudeReplyCount++;
            cleanupRequest(requestId).catch(() => {});
          }
        } else {
          const { generateReply } = await import("./brain.ts");
          generated = await generateReply(triggerText, ctx);
          const usage = consumeLastGeminiUsage();
          this._cost.geminiCallCount++;
          this._cost.geminiInputTokens += usage.inputTokens;
          this._cost.geminiOutputTokens += usage.outputTokens;
        }

        if (generated) {
          replyText = generated;
          console.log(
            `[voice-session] brain reply (${replyText.length} chars): "${replyText.slice(0, 120)}"`,
          );
        } else {
          console.log(
            `[voice-session] brain returned empty/timeout — using canned`,
          );
        }
      } catch (e: any) {
        console.warn(
          `[voice-session] brain failed → using canned: ${e?.message ?? e}`,
        );
      }
    }
    await this.speakReply(replyText);
  }

  private _buildPerSpeakerContext(): {
    ctx: ContextSegment[];
    speakerCount: number;
  } {
    const real = this._segments.filter((s) => !s.isNote && s.text.trim());
    const bySpeaker = new Map<string, typeof real>();
    for (const s of real) {
      const arr = bySpeaker.get(s.speakerId) ?? [];
      arr.push(s);
      bySpeaker.set(s.speakerId, arr);
    }
    const perSpeakerLast50: typeof real = [];
    for (const [, segs] of bySpeaker) {
      perSpeakerLast50.push(...segs.slice(-50));
    }
    perSpeakerLast50.sort((a, b) => a.startedAt - b.startedAt);
    const ctx: ContextSegment[] = perSpeakerLast50.map((s) => ({
      speaker: s.speaker,
      text: s.text,
      startedAt: s.startedAt,
    }));
    return { ctx, speakerCount: bySpeaker.size };
  }

  /**
   * Play a TTS reply through the voice channel. Requires active recording state.
   * Acquires AudioPlayer, subscribes to connection, plays mp3, cleans up.
   */
  async speakReply(text: string): Promise<void> {
    if (this._state !== "recording" || !this._connection) {
      throw new Error(`speakReply needs recording state (current=${this._state})`);
    }
    // Track TTS billing (Cloud TTS bills per character of input text)
    this._cost.ttsCallCount++;
    this._cost.ttsBilledChars += text.length;
    // Track which TTS profile was active at this call — accurately reflects
    // mid-session voice swaps (/yv kanya → /yv leda etc.) in the final report.
    const vcfg = await import("./voice-config.ts");
    if (!this._cost.ttsProfilesUsed) this._cost.ttsProfilesUsed = new Set();
    this._cost.ttsProfilesUsed.add(vcfg.getActiveProfile());
    const startedAt = Date.now();
    const ttsPath = await synthesizeTts(text);
    console.log(`[voice-session] tts file ${ttsPath} (${text.length} chars)`);
    const player = createAudioPlayer();
    const subscription = this._connection.subscribe(player);
    try {
      const resource = createAudioResource(ttsPath);
      player.play(resource);
      await entersState(player, AudioPlayerStatus.Playing, 5_000);
      await entersState(player, AudioPlayerStatus.Idle, 60_000);
      console.log(`[voice-session] tts playback complete`);
    } finally {
      try {
        subscription?.unsubscribe();
      } catch {}
      try {
        player.stop(true);
      } catch {}
      deleteTtsFile(ttsPath);
      // Record Codey's spoken reply into transcript as a regular speaker segment
      // (so retros / re-reads include both sides of the conversation).
      this._segments.push({
        speaker: "🌀 Codey",
        speakerId: "codey-tts",
        startedAt,
        endedAt: Date.now(),
        text,
      });
      this._participants.set("codey-tts", "🌀 Codey");
      const vc = await import("./voice-config.ts");
      emitLiveEvent({
        type: "codey-reply",
        text,
        profile: vc.getActiveProfile(),
        voice: vc.getActiveVoice().voice,
      });
      try {
        await this.flush();
      } catch (e) {
        console.warn("[voice-session] codey-reply flush failed:", e);
      }
    }
  }

  /** Add a participant directly (e.g. from VoiceStateUpdate join event). */
  addParticipant(userId: string, displayName: string): void {
    if (!this._participants.has(userId)) {
      this._participants.set(userId, displayName);
      console.log(
        `[voice-session] participant joined: ${displayName} (${userId})`,
      );
    }
  }

  addNote(text: string, author: string): void {
    if (this._state !== "recording") return;
    const now = Date.now();
    this._segments.push({
      speaker: author,
      speakerId: "note",
      startedAt: now,
      endedAt: now,
      text,
      isNote: true,
      noteAuthor: author,
    });
    emitLiveEvent({ type: "note", author, text });
    console.log(`[voice-session] note added by ${author} (${text.length} chars)`);
  }

  /**
   * Write current buffer to a .md file. Continues recording (use disconnect to stop).
   * Returns the filepath written.
   *
   * Guard against orphan files: if there's no channelName (failed connect /
   * race) AND no real segments, skip writing entirely. This prevents the
   * `<ymd>_<hm>_voice.md` placeholder files that appeared when a failed join
   * left a partial session that still accepted audio packets.
   */
  async flush(): Promise<{ filepath: string; segments: number }> {
    // Orphan guard: skip flush if there's no channelName. This happens when
    // a failed connect leaves a partial session that still accepts audio
    // packets — without this guard, we get `<ymd>_<hm>_voice.md` files with
    // raw user IDs as participants. The few in-flight segments are lost,
    // which is acceptable: the legit session would re-capture them anyway.
    if (!this.channelName) {
      console.warn(
        `[voice-session] flush skipped — no channelName (orphan guard, ${this._segments.length} segments dropped)`,
      );
      return { filepath: "", segments: 0 };
    }
    this._saveCounter++;
    const filepath = await writeTranscriptFile(
      {
        channelName: this.channelName ?? "voice",
        sessionStart: this.startedAt ?? Date.now(),
        sessionEnd: Date.now(),
        participants: Array.from(this._participants.values()),
      },
      this._segments,
    );
    console.log(
      `[voice-session] flush ${this._saveCounter}: ${this._segments.length} segments → ${filepath}`,
    );
    // Mirror to ~/Downloads/codey-discord-voice/ on every flush (incl. the
    // empty initial flush at join) — fire-and-forget, best-effort.
    copyToDownloads(filepath).catch(() => {});
    return { filepath, segments: this._segments.length };
  }

  getSegmentCount(): number {
    return this._segments.length;
  }

  getSegments(): readonly TranscriptSegment[] {
    return this._segments;
  }

  /**
   * Wall-clock ms of the most recent successful human-speech transcription.
   * Falls back to session startedAt if nobody has spoken since join.
   * Used by the silence auto-leave watcher.
   */
  getLastHumanSpeechAt(): number {
    return this._lastHumanSpeechAt || this.startedAt || Date.now();
  }

  // ─── Persistent mode (skip auto-leave watchers) ──────────────────────────
  /** Return true if persistent mode is active AND not yet expired. */
  isPersistent(): boolean {
    return this._persistentUntil > 0 && Date.now() < this._persistentUntil;
  }
  /** Persistent expiry timestamp (0 if off). Used by 24h hard-cap watcher. */
  getPersistentUntil(): number {
    return this._persistentUntil;
  }
  /** Enable persistent mode for the given duration (ms). Auto-leaves at expiry. */
  setPersistent(ms: number): void {
    this._persistentUntil = Date.now() + Math.max(0, ms);
  }
  /** Disable persistent mode immediately. Watchers resume normal behaviour. */
  clearPersistent(): void {
    this._persistentUntil = 0;
  }

  getParticipants(): string[] {
    return Array.from(this._participants.values());
  }

  getCost(): CostMetrics {
    return { ...this._cost };
  }

  getCostReport(): string {
    return formatCost(this._cost);
  }

  private async _resolveSpeakerName(userId: string): Promise<string> {
    if (!this._guild) return `user:${userId}`;
    try {
      const member = await this._guild.members.fetch(userId);
      return member.displayName || member.user.globalName || member.user.username;
    } catch {
      return `user:${userId}`;
    }
  }

  private _resetMeta() {
    this.channelId = undefined;
    this.guildId = undefined;
    this.channelName = undefined;
    this.startedAt = undefined;
    this.chunkCount = 0;
    this._guild = undefined;
    this._segments = [];
    this._participants.clear();
    this._saveCounter = 0;
    this._persistentUntil = 0;
    this.replyChannelId = undefined;
  }
}

export function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
