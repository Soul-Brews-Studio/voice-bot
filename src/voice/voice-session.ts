/**
 * VoiceSession is the v2 voice-only Discord connection boundary.
 *
 * It owns joining/leaving voice, speaker capture, STT, transcript segments,
 * and transcript persistence. Claude routing, Discord command handling, and
 * TTS playback are wired in later phases through bot/text/tool modules.
 */
import {
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
  type DiscordGatewayAdapterCreator,
  type VoiceConnection,
} from "@discordjs/voice";
import type { Guild } from "discord.js";
import {
  startSpeakerCapture,
  clearRawRecorder,
  getRawRecorder,
  type AudioChunk,
  type ChunkHandler,
} from "./audio-pipeline.ts";
import {
  detectTrigger,
  SpeakerTriggerDebouncer,
} from "./trigger.ts";
import { transcribeAndCleanup } from "../stt/index.ts";
import {
  writeTranscriptFile,
  type TranscriptSegment,
} from "../transcript-writer.ts";

export type SessionState = "idle" | "connecting" | "recording" | "leaving";

export interface SessionStatus {
  state: SessionState;
  channelId?: string;
  guildId?: string;
  channelName?: string;
  startedAt?: number;
  chunkCount: number;
  segmentCount: number;
}

export interface VoiceSessionCallbacks {
  onTranscript?: (segment: TranscriptSegment) => Promise<void> | void;
  onTrigger?: (text: string, userId: string) => Promise<void> | void;
}

export interface AddSegmentArgs {
  speakerId: string;
  startedAt: number;
  endedAt: number;
  text: string;
  language?: string;
}

export interface ConnectArgs {
  channelId: string;
  guildId: string;
  channelName: string;
  adapterCreator: DiscordGatewayAdapterCreator;
  guild?: Guild;
  onChunk?: ChunkHandler;
  onTranscript?: VoiceSessionCallbacks["onTranscript"];
  onTrigger?: VoiceSessionCallbacks["onTrigger"];
  silenceThresholdMs?: number;
  maxChunkMs?: number;
  minFinalChunkMs?: number;
  chunkFlushMs?: number;
  autoFlushMs?: number;
  selfMute?: boolean;
}

export class VoiceSession {
  private _state: SessionState = "idle";
  private _connection: VoiceConnection | null = null;
  private _activeSpeakers = new Set<string>();
  private _segments: TranscriptSegment[] = [];
  private _participants = new Map<string, string>();
  private _guild?: Guild;
  private _autoFlushTimer?: ReturnType<typeof setInterval>;
  private _callbacks: VoiceSessionCallbacks;
  private readonly _triggerDebouncer: SpeakerTriggerDebouncer;

  channelId?: string;
  guildId?: string;
  channelName?: string;
  startedAt?: number;
  chunkCount = 0;

  constructor(callbacks: VoiceSessionCallbacks = {}) {
    this._callbacks = callbacks;
    this._triggerDebouncer = new SpeakerTriggerDebouncer(({ text, userId }) =>
      this._callbacks.onTrigger?.(text, userId),
    );
  }

  get state(): SessionState {
    return this._state;
  }

  get connection(): VoiceConnection | null {
    return this._connection;
  }

  get segments(): readonly TranscriptSegment[] {
    return this._segments;
  }

  status(): SessionStatus {
    return {
      state: this._state,
      channelId: this.channelId,
      guildId: this.guildId,
      channelName: this.channelName,
      startedAt: this.startedAt,
      chunkCount: this.chunkCount,
      segmentCount: this._segments.length,
    };
  }

  async connect(args: ConnectArgs): Promise<void> {
    if (this._state !== "idle") {
      throw new Error(`cannot connect: session is ${this._state}`);
    }

    this._state = "connecting";
    this.channelId = args.channelId;
    this.guildId = args.guildId;
    this.channelName = args.channelName;
    this.startedAt = Date.now();
    this.chunkCount = 0;
    this._guild = args.guild;
    this._callbacks = {
      onTranscript: args.onTranscript ?? this._callbacks.onTranscript,
      onTrigger: args.onTrigger ?? this._callbacks.onTrigger,
    };
    this._segments = [];
    this._participants.clear();
    this._activeSpeakers.clear();

    const connection = joinVoiceChannel({
      channelId: args.channelId,
      guildId: args.guildId,
      adapterCreator: args.adapterCreator,
      selfDeaf: false,
      selfMute: args.selfMute ?? true,
    });
    this._connection = connection;

    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    this._state = "recording";
    this.startRecording(args);
    this.startAutoFlush(args.autoFlushMs);
  }

  async disconnect(options: { saveTranscript?: boolean } = {}): Promise<string | null> {
    if (this._state === "idle") return null;

    this._state = "leaving";
    this.stopAutoFlush();
    this._triggerDebouncer.clear();
    const transcriptPath =
      options.saveTranscript === false ? null : await this.flush();

    const guildId = this.guildId;
    if (guildId) {
      await getRawRecorder(guildId)
        .save(this.channelName ?? "voice")
        .catch((error) => {
          console.warn(`[voice-session] raw audio save failed: ${error.message}`);
          return null;
        })
        .finally(() => clearRawRecorder(guildId));
    }

    this._connection?.destroy();
    this._connection = null;
    this._activeSpeakers.clear();
    this._state = "idle";
    return transcriptPath;
  }

  leave(options: { saveTranscript?: boolean } = {}): Promise<string | null> {
    return this.disconnect(options);
  }

  async saveTranscript(): Promise<string> {
    return this.flush();
  }

  async flush(): Promise<string> {
    if (!this.startedAt || !this.channelName) {
      throw new Error("cannot save transcript before session starts");
    }

    return writeTranscriptFile(
      {
        channelName: this.channelName,
        sessionStart: this.startedAt,
        sessionEnd: Date.now(),
        participants: Array.from(this._participants.values()),
      },
      this._segments,
    );
  }

  addNote(authorId: string, authorName: string, text: string): void {
    const now = Date.now();
    this._participants.set(authorId, authorName);
    const segment: TranscriptSegment = {
      speaker: authorName,
      speakerId: authorId,
      startedAt: now,
      endedAt: now,
      text,
      isNote: true,
      noteAuthor: authorName,
    };
    this._segments.push(segment);
    void this._callbacks.onTranscript?.(segment);
  }

  async addSegment(args: AddSegmentArgs): Promise<TranscriptSegment | null> {
    const text = args.text.trim();
    if (!text) return null;

    const speaker = await this.resolveSpeakerName(args.speakerId);
    this._participants.set(args.speakerId, speaker);
    const segment: TranscriptSegment = {
      speaker,
      speakerId: args.speakerId,
      startedAt: args.startedAt,
      endedAt: args.endedAt,
      text,
      language: args.language,
    };
    this._segments.push(segment);
    await this._callbacks.onTranscript?.(segment);

    if (detectTrigger(text)) {
      this._triggerDebouncer.push(args.speakerId, text);
    }

    return segment;
  }

  private startRecording(args: ConnectArgs): void {
    const connection = this._connection;
    if (!connection) return;

    connection.receiver.speaking.on("start", (userId: string) => {
      if (this._activeSpeakers.has(userId)) return;
      this._activeSpeakers.add(userId);

      startSpeakerCapture(
        connection,
        userId,
        {
          guildId: args.guildId,
          silenceThresholdMs: args.silenceThresholdMs ?? 1_500,
          maxChunkMs: args.maxChunkMs ?? 30_000,
          chunkFlushMs: args.chunkFlushMs,
          minFinalChunkMs: args.minFinalChunkMs ?? 1_500,
        },
        async (chunk) => {
          this.chunkCount++;
          if (args.onChunk) {
            await args.onChunk(chunk);
            return;
          }
          await this.defaultChunkHandler(chunk);
        },
        () => {
          this._activeSpeakers.delete(userId);
        },
      );
    });
  }

  private async defaultChunkHandler(chunk: AudioChunk): Promise<void> {
    const result = await transcribeAndCleanup(chunk.wavPath);
    await this.addSegment({
      speakerId: chunk.userId,
      startedAt: chunk.startedAt,
      endedAt: chunk.endedAt,
      text: result.text,
      language: result.language,
    });
  }

  private async resolveSpeakerName(userId: string): Promise<string> {
    const cached = this._participants.get(userId);
    if (cached) return cached;
    const member = await this._guild?.members.fetch(userId).catch(() => null);
    return member?.displayName ?? userId;
  }

  private startAutoFlush(autoFlushMs = Number(process.env.AUTO_FLUSH_MS) || 15 * 60 * 1000): void {
    this.stopAutoFlush();
    if (autoFlushMs <= 0) return;
    this._autoFlushTimer = setInterval(() => {
      if (this._state !== "recording" || this._segments.length === 0) return;
      this.flush().catch((error) => {
        console.warn(`[voice-session] auto-flush failed: ${error.message}`);
      });
    }, autoFlushMs);
    this._autoFlushTimer.unref?.();
  }

  private stopAutoFlush(): void {
    if (!this._autoFlushTimer) return;
    clearInterval(this._autoFlushTimer);
    this._autoFlushTimer = undefined;
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
