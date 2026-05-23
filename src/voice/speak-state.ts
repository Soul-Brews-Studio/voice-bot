/**
 * Per-guild speak-mode toggle + per-guild trigger access control.
 *
 * Speak mode:
 *   /codey speak-on  → enables TTS reply on trigger phrase
 *   /codey speak-off → disables (Yoi just transcribes, no spoken reply)
 *
 * Trigger access:
 *   anyone      — anyone in voice can trigger Codey
 *   owner-only  — only users in DC_OWNER_IDS env (default if TRIGGER_OWNER_ONLY=true)
 *   selected    — only users in the runtime-managed allow-list (per-guild)
 */

const speakModes = new Map<string, boolean>();

export function setSpeakMode(guildId: string, on: boolean): void {
  speakModes.set(guildId, on);
  console.log(`[speak-state] speak guild=${guildId} → ${on ? "ON" : "OFF"}`);
}

export function setMute(guildId: string, muted: boolean): void {
  setSpeakMode(guildId, !muted);
}

export function isSpeakMode(guildId: string): boolean {
  return speakModes.get(guildId) ?? false;
}

export function allSpeakModes(): Record<string, boolean> {
  return Object.fromEntries(speakModes);
}

// ── Trigger access ──────────────────────────────────────────────────────────

export type TriggerMode = "anyone" | "owner-only" | "selected";

const triggerModes = new Map<string, TriggerMode>();
/** Per-guild allow-list used when mode = "selected". */
const allowedUsers = new Map<string, Set<string>>();

const defaultMode: TriggerMode =
  process.env.TRIGGER_OWNER_ONLY === "true" ? "owner-only" : "anyone";

/** Owner IDs parsed once from env. */
export const TRIGGER_OWNER_IDS = new Set(
  (process.env.DC_OWNER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

export function setTriggerMode(guildId: string, mode: TriggerMode): void {
  triggerModes.set(guildId, mode);
  console.log(`[speak-state] trigger-mode guild=${guildId} → ${mode}`);
}

export function getTriggerMode(guildId: string): TriggerMode {
  return triggerModes.get(guildId) ?? defaultMode;
}

function ensureSet(guildId: string): Set<string> {
  let s = allowedUsers.get(guildId);
  if (!s) {
    s = new Set();
    allowedUsers.set(guildId, s);
  }
  return s;
}

/** Add a user to the trigger allow-list for a guild. */
export function addAllowedTriggerUser(guildId: string, userId: string): void {
  ensureSet(guildId).add(userId);
  console.log(`[speak-state] trigger allow-list guild=${guildId} +${userId}`);
}

/** Remove a user from the allow-list. */
export function removeAllowedTriggerUser(guildId: string, userId: string): boolean {
  const removed = ensureSet(guildId).delete(userId);
  if (removed) {
    console.log(`[speak-state] trigger allow-list guild=${guildId} -${userId}`);
  }
  return removed;
}

/** Read-only snapshot of the allow-list for a guild. */
export function getAllowedTriggerUsers(guildId: string): readonly string[] {
  return Array.from(allowedUsers.get(guildId) ?? []);
}

/**
 * Authoritative trigger gate. Combines mode + allow-list + owner IDs.
 * Returns true if `userId` is allowed to trigger Codey in `guildId`.
 */
export function canTrigger(guildId: string, userId: string): boolean {
  const mode = getTriggerMode(guildId);
  switch (mode) {
    case "anyone":
      return true;
    case "owner-only":
      return TRIGGER_OWNER_IDS.has(userId);
    case "selected": {
      const list = allowedUsers.get(guildId);
      // Always include owners in selected mode (safety net).
      return TRIGGER_OWNER_IDS.has(userId) || (list?.has(userId) ?? false);
    }
  }
}
