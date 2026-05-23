const UNIVERSAL_TRIGGERS = [
  "ตอบหน่อย",
];

const BOT_NAME_ALIASES: Record<string, string[]> = {
  codey: ["codey", "cody", "codie", "โคดี้", "โค้ดี้", "โคดี"],
  due: ["due", "ดูเอ"],
  uno: ["uno", "อูโน่", "อูโน"],
};

const FUZZY_TRIGGER_RE =
  /(?:ตอบ\s*(?:ห[่้]?น[่้]?[อ้า]?[ยา]?|นอย|หนอย|หน้า))/i;

export interface PendingTrigger {
  userId: string;
  text: string;
}

export type TriggerHandler = (trigger: PendingTrigger) => void | Promise<void>;

function loadEnvPhrases(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw.split(",").map((phrase) => phrase.trim()).filter(Boolean);
}

function botNameParts(): string[] {
  const botName = process.env.BOT_NAME ?? process.env.VOICE_BOT_NAME ?? "codey";
  const normalized = botName.toLowerCase().trim();
  const base = normalized.replace(/-?oracle$/, "");
  return Array.from(new Set([normalized, base].filter(Boolean)));
}

function botTriggerNames(): string[] {
  const names = new Set<string>();
  for (const part of botNameParts()) {
    names.add(part);
    for (const alias of BOT_NAME_ALIASES[part] ?? []) {
      names.add(alias);
    }
  }
  return Array.from(names);
}

function buildDefaultBotPhrases(): string[] {
  return botTriggerNames().flatMap((name) => [
    `${name}ตอบหน่อย`,
    `${name} ช่วย`,
    `${name}ช่วย`,
    name,
  ]);
}

function triggerPhrases(): string[] {
  return Array.from(
    new Set([
      ...buildDefaultBotPhrases(),
      ...UNIVERSAL_TRIGGERS,
      ...loadEnvPhrases("TRIGGER_PHRASES"),
      ...loadEnvPhrases("TRIGGER_EXTRA_PHRASES"),
    ].map((phrase) => phrase.trim()).filter(Boolean)),
  );
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildTriggerRegex(): RegExp {
  const phrases = triggerPhrases().map(escapeRegex).join("|");
  return new RegExp(`(?:${phrases})`, "i");
}

export function detectTrigger(text: string): boolean {
  return buildTriggerRegex().test(text) || FUZZY_TRIGGER_RE.test(text);
}

export class SpeakerTriggerDebouncer {
  private pending = new Map<
    string,
    { text: string; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(
    private readonly onTrigger: TriggerHandler,
    private readonly debounceMs =
      Number(process.env.TRIGGER_DEBOUNCE_MS) || 1_500,
  ) {}

  push(userId: string, text: string): void {
    const current = this.pending.get(userId);
    if (current) {
      clearTimeout(current.timer);
      current.text = `${current.text} ${text}`.trim();
      current.timer = this.schedule(userId);
      return;
    }
    this.pending.set(userId, {
      text,
      timer: this.schedule(userId),
    });
  }

  clear(): void {
    for (const { timer } of this.pending.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();
  }

  private schedule(userId: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      const trigger = this.pending.get(userId);
      if (!trigger) return;
      this.pending.delete(userId);
      void Promise.resolve(this.onTrigger({ userId, text: trigger.text })).catch((error) => {
        console.warn(`[trigger] handler failed: ${error?.message ?? error}`);
      });
    }, this.debounceMs);
  }
}
