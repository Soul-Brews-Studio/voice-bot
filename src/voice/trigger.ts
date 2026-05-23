export interface TriggerMatch {
  matched: boolean;
  phrase?: string;
}

const DEFAULT_TRIGGER_PHRASES = ["codey", "cody"];

export function getTriggerPhrases(): string[] {
  const extra = process.env.TRIGGER_PHRASES?.split(",") ?? [];
  return [...DEFAULT_TRIGGER_PHRASES, ...extra]
    .map((phrase) => phrase.trim())
    .filter(Boolean);
}

export function detectTrigger(text: string): TriggerMatch {
  const normalized = text.toLowerCase();
  const phrase = getTriggerPhrases().find((item) =>
    normalized.includes(item.toLowerCase()),
  );
  return phrase ? { matched: true, phrase } : { matched: false };
}
