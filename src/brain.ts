/**
 * Codey's brain — Groq LLM for generating spoken replies.
 * Uses OpenAI-compatible chat API on Groq's LPU (very fast).
 * Same GROQ_API_KEY as STT.
 */

const API_KEY = process.env.GROQ_API_KEY;
const BRAIN_MODEL = process.env.BRAIN_MODEL || "llama-3.3-70b-versatile";
const API_URL = "https://api.groq.com/openai/v1/chat/completions";

const BRAIN_SYSTEM =
  process.env.BRAIN_SYSTEM ||
  `You are โคดี้ (Codey), AI secretary and voice transcriber, speaking Thai.
You are responding via voice in a Discord call to BM (your human).
Reply briefly — 1-2 short sentences — because this will be spoken aloud.
Voice characteristics: warm, professional, helpful. Use "ครับ" particles.
Never pretend to be human. If asked who you are, say "โคดี้ AI ของ BM ครับ".
Reply in Thai unless explicitly asked otherwise.

You will receive the trigger phrase (what the user just said to you) AND recent conversation context.
Decide how to respond based on intent:
- Direct question (กี่โมง, อะไร, ยังไง) → answer the question directly
- Request for opinion/summary (สรุปหน่อย, ว่าไง, เห็นด้วยไหม) → summarize or give opinion on the conversation
- Greeting (สวัสดี, ได้ยินไหม) → greet back briefly
- Other → respond naturally to what was said`;

interface GroqResponse {
  choices?: Array<{
    message?: { content?: string };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { message: string; type: string };
}

export interface BrainUsage {
  inputTokens: number;
  outputTokens: number;
}

let _lastUsage: BrainUsage = { inputTokens: 0, outputTokens: 0 };
export function consumeLastGeminiUsage(): BrainUsage {
  const u = _lastUsage;
  _lastUsage = { inputTokens: 0, outputTokens: 0 };
  return u;
}

async function callGroq(
  system: string,
  userText: string,
  maxTokens = 200,
): Promise<string> {
  if (!API_KEY) {
    throw new Error("[brain] GROQ_API_KEY missing in .env");
  }
  if (!userText.trim()) return "";

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: BRAIN_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userText },
      ],
      max_tokens: maxTokens,
      temperature: 0.7,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`[brain] Groq HTTP ${res.status}: ${errText.slice(0, 300)}`);
  }

  const json = (await res.json()) as GroqResponse;
  _lastUsage = {
    inputTokens: json.usage?.prompt_tokens ?? 0,
    outputTokens: json.usage?.completion_tokens ?? 0,
  };
  return (json.choices?.[0]?.message?.content ?? "").trim();
}

export interface ContextSegment {
  speaker: string;
  text: string;
  startedAt: number;
}

export async function generateReply(
  userText: string,
  context?: ContextSegment[],
): Promise<string> {
  let prompt = userText;
  if (context && context.length > 0) {
    const transcript = context
      .map((s) => {
        const t = new Date(s.startedAt).toISOString().slice(11, 19);
        return `[${t}] ${s.speaker}: ${s.text}`;
      })
      .join("\n");
    prompt =
      `Trigger (สิ่งที่เพิ่งพูดกับคุณ): "${userText}"\n\n` +
      `บทสนทนาล่าสุด:\n---\n${transcript}\n---`;
  }
  return callGroq(BRAIN_SYSTEM, prompt);
}

export async function generateOpinion(
  segments: ContextSegment[],
  triggerText: string,
): Promise<string> {
  if (segments.length === 0) {
    return "ยังไม่มีบทสนทนาให้โคดี้ฟังเลยครับ";
  }
  const transcript = segments
    .map((s) => {
      const t = new Date(s.startedAt).toISOString().slice(11, 19);
      return `[${t}] ${s.speaker}: ${s.text}`;
    })
    .join("\n");
  const prompt =
    `Trigger: "${triggerText}"\n\nบทสนทนาล่าสุด ${segments.length} ข้อความ:\n---\n${transcript}\n---\n\nให้ opinion สั้นๆ ครับ`;
  return callGroq(BRAIN_SYSTEM, prompt, 400);
}
