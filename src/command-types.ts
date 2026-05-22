/**
 * Shared types for voice command file-watch IPC.
 *
 * Producers (poller-tg.ts, poller-dc.ts at repo root, or AI in session via
 * Write tool) drop JSON command files into VOICE_CMD_DIR. The voice-bot
 * watcher reads + executes + deletes them.
 *
 * Consumers of VoiceResult: src/voice-result-watcher.ts (repo root) tails
 * VOICE_RESULT_DIR and forwards each result back to its origin platform via
 * the `replyTo` field (e.g. Telegram sendMessage).
 */
import { homedir } from "node:os";
import { join } from "node:path";

export const VOICE_CMD_DIR = join(
  homedir(),
  ".claude",
  "channels",
  "codey",
  "voice-commands",
);

export const VOICE_RESULT_DIR = join(
  homedir(),
  ".claude",
  "channels",
  "codey",
  "voice-results",
);

export type VoiceAction =
  | "join"
  | "leave"
  | "save"
  | "status"
  | "note"
  | "speak-on"
  | "speak-off"
  | "voice"
  | "trigger"
  | "say"
  | "think"
  | "stay"
  | "unstay";

export type VoiceSource = "session" | "tg" | "dc" | "manual";

export interface ReplyTo {
  /** Where the original message came from — result-watcher dispatches accordingly. */
  platform: "tg" | "dc";
  /** Telegram chat_id (number stringified) or Discord channel/DM id. */
  chatId: string;
  /** Optional original message id for threaded reply. */
  messageId?: number | string;
}

export interface VoiceCommand {
  action: VoiceAction;

  /** For "join": specify EITHER channelId (precise) OR channelName (resolved
   *  by case-insensitive name lookup across bot's guilds). */
  channelId?: string;
  channelName?: string;

  /** For "voice": one of VoiceProfile (kanya | kanya-compact | narisa | leda). */
  profile?: string;

  /** For "trigger": one of
   *    "anyone" | "owner-only" | "selected" | "list" | "add" | "remove" */
  triggerMode?: string;
  /** For "trigger" with action="add"|"remove": target Discord user id. */
  triggerUserId?: string;

  /** For "note" | "say" | "think": the text payload. */
  text?: string;

  /** For "stay": persistent duration in hours (default 24, max 24). */
  stayHours?: number;

  /** For "leave": summary depth requested in the handoff prompt.
   *    "short" (default) — quick bullet summary, ≤5 lines
   *    "long" — detailed sections (topics in depth, decisions, actions,
   *             quotes, speaker contributions, open questions, no length cap) */
  summaryMode?: "short" | "long";

  /** Optional hint; resolved from channelId via Discord API if absent. */
  guildId?: string;

  source: VoiceSource;
  issuedAt: string;
  requestId: string;
  /** Who sent it (for log + audit) — user_id or "ai-session". */
  requester?: string;

  /** If set, result-watcher forwards the VoiceResult back to this channel. */
  replyTo?: ReplyTo;
}

export interface VoiceResult {
  requestId: string;
  ok: boolean;
  message: string;
  guildId?: string;
  channelId?: string;
  channelName?: string;
  chunkCount?: number;
  durationMs?: number;
  completedAt: string;

  /** Echoed from VoiceCommand.replyTo so external watchers know where to deliver. */
  replyTo?: ReplyTo;
}
