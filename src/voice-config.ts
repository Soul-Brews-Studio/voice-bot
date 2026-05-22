/**
 * Runtime-switchable TTS voice profiles.
 *
 * Slash command `/codey voice <profile>` flips this in-memory state; the TTS
 * dispatcher (src/tts/*) reads from here on every synthesizeTts() call (NOT
 * cached at module-load), so changes apply to the very next reply.
 *
 * Profiles are intentionally coarse-grained — they package up
 * (backend + voice + language) into a single named choice so the user
 * doesn't have to think in terms of low-level env vars.
 *
 * Resets to .env defaults on process restart (in-memory only — keeps
 * things simple and avoids writing back to .env which is gitignored).
 */

export type VoiceProfile =
  | "kanya"        // macOS Kanya (Enhanced if downloaded, else compact) — free, native Thai
  | "kanya-compact" // explicit macOS Kanya compact (fallback)
  | "narisa"       // macOS Narisa Thai — free alternative
  | "niwat"        // Edge TTS — Thai male, free
  | "premwadee"    // Edge TTS — Thai female, free
  | "leda";        // Google Chirp3-HD-Leda — paid, multilingual

export interface ResolvedVoice {
  backend: "mac-say" | "google" | "edge";
  voice: string;            // engine-specific voice name
  languageCode?: string;    // only used by google backend
  label: string;            // human-readable for UI
  costNote: string;
}

const PROFILES: Record<VoiceProfile, ResolvedVoice> = {
  "kanya": {
    backend: "mac-say",
    voice: "Kanya (Enhanced)",
    label: "Kanya Enhanced (macOS, Thai, free)",
    costNote: "$0 — on-device",
  },
  "kanya-compact": {
    backend: "mac-say",
    voice: "Kanya",
    label: "Kanya compact (macOS, Thai, free)",
    costNote: "$0 — on-device",
  },
  "narisa": {
    backend: "mac-say",
    voice: "Narisa",
    label: "Narisa (macOS, Thai, free)",
    costNote: "$0 — on-device",
  },
  "niwat": {
    backend: "edge",
    voice: "th-TH-NiwatNeural",
    label: "Niwat (Edge TTS, Thai male, free)",
    costNote: "$0 — cloud free",
  },
  "premwadee": {
    backend: "edge",
    voice: "th-TH-PremwadeeNeural",
    label: "Premwadee (Edge TTS, Thai female, free)",
    costNote: "$0 — cloud free",
  },
  "leda": {
    backend: "google",
    voice: "en-US-Chirp3-HD-Leda",
    languageCode: "en-US",
    label: "Leda — Google Chirp3-HD (multilingual, paid)",
    costNote: "~$30 / 1M chars",
  },
};

// Default profile inferred from .env at startup so behavior matches existing
// config out of the box.
function defaultProfile(): VoiceProfile {
  const backend = (process.env.TTS_BACKEND || "mac-say").toLowerCase();
  if (backend === "google") return "leda";
  const voice = (process.env.MAC_SAY_VOICE || "Kanya").toLowerCase();
  if (voice.includes("narisa")) return "narisa";
  if (voice.includes("enhanced")) return "kanya";
  return "kanya-compact";
}

let active: VoiceProfile = defaultProfile();

export function getActiveVoice(): ResolvedVoice {
  return PROFILES[active];
}

export function getActiveProfile(): VoiceProfile {
  return active;
}

export function setActiveVoice(profile: VoiceProfile): ResolvedVoice {
  if (!(profile in PROFILES)) {
    throw new Error(`unknown voice profile: ${profile}`);
  }
  active = profile;
  return PROFILES[profile];
}

export function listVoiceProfiles(): Array<{ id: VoiceProfile; resolved: ResolvedVoice }> {
  return (Object.keys(PROFILES) as VoiceProfile[]).map((id) => ({
    id,
    resolved: PROFILES[id],
  }));
}
