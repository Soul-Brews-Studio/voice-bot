const BUILTIN_TRIGGERS = [
  "โคดี้",
  "น้องโคดี้",
  "โคดี้จ๋า",
  "โคดี้จ้า",
  "ขอดี",
  "โค้ดดี้",
  "โค้ดี้",
  "โคดี",
  "โค๊ดดี้",
  "โอดี",
  "โคลดี้",
  "คอลดี้",
  "โหดี",
  "พอดี้",
  "คอดี้",
  "ย้อย",
  "หย่อย",
  "ยอย",
  "ย่อย",
  "หยอด",
  "codey",
  "cody",
  "codie",
  "ตอบหน่อย",
  "ช่วยตอบ",
  "ตอบที",
  "ตอบสิ",
  "ตอบให้หน่อย",
  "ว่าไง",
  "เอาไง",
];

const FUZZY_TRIGGER_RE =
  /(?:ตอบ\s*(?:ห[่้]?น[่้]?[อ้า]?[ยา]?|นอย|หนอย|หน้า)|ช่วย\s*(?:ตอบ|ฟัง|บอก)|ต[่ิ]?[ดอ]?[ไป่]?ปแล้ว|ติดต่อไปแล้ว|อับน้?อย|อบน้?อย)/i;

export interface PendingTrigger {
  userId: string;
  text: string;
}

export type TriggerHandler = (trigger: PendingTrigger) => void | Promise<void>;

function loadExtraTriggers(): string[] {
  const raw = process.env.TRIGGER_EXTRA_PHRASES;
  if (!raw) return [];
  return raw.split(",").map((phrase) => phrase.trim()).filter(Boolean);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildTriggerRegex(): RegExp {
  return new RegExp(
    `(?:${[...BUILTIN_TRIGGERS, ...loadExtraTriggers()].map(escapeRegex).join("|")})`,
    "i",
  );
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
