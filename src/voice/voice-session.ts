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
  type AudioChunk,
  type ChunkHandler,
} from "./audio-pipeline.ts";
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

export interface ConnectArgs {
  channelId: string;
  guildId: string;
  channelName: string;
  adapterCreator: DiscordGatewayAdapterCreator;
  guild?: Guild;
  onChunk?: ChunkHandler;
  silenceThresholdMs?: number;
  maxChunkMs?: number;
  minFinalChunkMs?: number;
}

export class VoiceSession {
  private _state: SessionState = "idle";
  private _connection: VoiceConnection | null = null;
  private _activeSpeakers = new Set<string>();
  private _segments: TranscriptSegment[] = [];
  private _participants = new Map<string, string>();
  private _guild?: Guild;

  channelId?: string;
  guildId?: string;
  channelName?: string;
  startedAt?: number;
  chunkCount = 0;

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
    this._segments = [];
    this._participants.clear();
    this._activeSpeakers.clear();

    const connection = joinVoiceChannel({
      channelId: args.channelId,
      guildId: args.guildId,
      adapterCreator: args.adapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    this._connection = connection;

    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    this._state = "recording";
    this.startRecording(args);
  }

  async leave(options: { saveTranscript?: boolean } = {}): Promise<string | null> {
    if (this._state === "idle") return null;

    this._state = "leaving";
    const transcriptPath =
      options.saveTranscript === false ? null : await this.saveTranscript();

    this._connection?.destroy();
    this._connection = null;
    this._activeSpeakers.clear();
    this._state = "idle";
    return transcriptPath;
  }

  async saveTranscript(): Promise<string> {
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
    this._segments.push({
      speaker: authorName,
      speakerId: authorId,
      startedAt: now,
      endedAt: now,
      text,
      isNote: true,
      noteAuthor: authorName,
    });
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
    if (!result.text) return;

    const speaker = await this.resolveSpeakerName(chunk.userId);
    this._participants.set(chunk.userId, speaker);
    this._segments.push({
      speaker,
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
