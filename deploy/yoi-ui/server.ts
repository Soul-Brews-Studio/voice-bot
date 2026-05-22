/**
 * Yoi UI — VPS service.
 *
 * Listens on YOI_UI_PORT (default 3540). Can be exposed via reverse proxy
 * or Cloudflare tunnel.
 *
 * Routes:
 *   GET  /          — login page or feed page (session cookie gate)
 *   POST /login     — validate YOI_UI_PASSWORD, set HMAC-signed cookie
 *   POST /logout    — clear cookie
 *   GET  /feed      — SSE stream (replays last N events + live tail)
 *   POST /api/ingest — bearer-auth ingest from Mac voice-bot; appends event
 *                     to in-memory ring buffer + broadcasts to SSE clients
 *
 * No file system dependency — pure in-memory ring. Survives restarts only
 * for new events, not history (acceptable for live monitor use case).
 *
 * Env:
 *   YOI_UI_PORT             (default 3540)
 *   YOI_UI_PASSWORD         (default "changeme")
 *   YOI_UI_INGEST_TOKEN     (REQUIRED — shared secret with Mac)
 *   YOI_UI_RING_SIZE        (default 500)
 *   YOI_UI_SESSION_SECRET   (random if unset; cookies invalidate on restart)
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.YOI_UI_PORT) || 3540;
const PASSWORD = process.env.YOI_UI_PASSWORD || "changeme";
const INGEST_TOKEN = process.env.YOI_UI_INGEST_TOKEN || "";
const SESSION_SECRET = process.env.YOI_UI_SESSION_SECRET || randomBytes(32).toString("hex");
const RING_SIZE = Number(process.env.YOI_UI_RING_SIZE) || 500;
const SESSIONS_DIR = process.env.YOI_UI_SESSIONS_DIR || join(__dirname, "sessions");
const COOKIE_NAME = "yoi-session";
const COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 7;

if (!INGEST_TOKEN) {
  console.warn("[yoi-ui] ⚠️ YOI_UI_INGEST_TOKEN not set — ingest endpoint will reject all writes");
}

// ─── Ring buffer ────────────────────────────────────────────────────────────

interface RingEvent {
  _id: number;
  ts: number;
  type: string;
  [k: string]: unknown;
}

let nextEventId = 1;
const ring: RingEvent[] = [];
function pushEvent(raw: { ts: number; type: string; [k: string]: unknown }): void {
  const ev: RingEvent = { ...raw, _id: nextEventId++ };
  ring.push(ev);
  if (ring.length > RING_SIZE) ring.shift();
  // Broadcast to all live SSE clients with id so reconnect can resume.
  const frame = `id: ${ev._id}\ndata: ${JSON.stringify(ev)}\n\n`;
  for (const client of sseClients) {
    try { client.write(frame); } catch {}
  }
}

interface SseClient {
  write: (s: string) => void;
}
const sseClients = new Set<SseClient>();

// ─── Control command queue (UI → Mac voice-bot) ─────────────────────────────
// UI POSTs control commands via session cookie. Commands sit in an in-memory
// FIFO queue until the Mac voice-bot drains them via /api/control/pending
// (bearer auth). Lost on VPS restart (acceptable — controls are best-effort).

interface ControlCommand {
  id: string;
  ts: number;
  action: string;
  arg?: string;
  by?: string; // future: track which UI user issued it (single-user for now)
}
const controlQueue: ControlCommand[] = [];
const ALLOWED_CONTROL_ACTIONS = new Set([
  "join", "leave", "leave-long", "save", "status", "note",
  "speak-on", "speak-off", "say", "think", "voice",
  "stay", "unstay",
]);

// ─── Session archive (meeting recordings) ───────────────────────────────────
// Each completed voice session lands as one JSON file in SESSIONS_DIR.
// In-memory index lets the list endpoint avoid scanning the dir on every call.
// File is the source of truth — index is rebuilt at boot from disk.

interface SessionRecord {
  id: string;
  channelName: string;
  channelId?: string;
  guildId?: string;
  joinedAt: number;
  leftAt: number;
  durationMs: number;
  participants: string[];
  segmentCount: number;
  summary: string;
  transcriptMd: string;
  receivedAt: number;
}

interface SessionListEntry {
  id: string;
  channelName: string;
  joinedAt: number;
  leftAt: number;
  durationMs: number;
  participants: string[];
  segmentCount: number;
  summaryPreview: string;
}

const sessionsIndex = new Map<string, SessionListEntry>();

function sessionFilePath(id: string): string {
  // Defense in depth — path traversal protection. id should be filename-safe
  // anyway (writer uses ymd_hm_slug pattern) but never trust input.
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
  return join(SESSIONS_DIR, `${safe}.json`);
}

function summaryFirstLine(s: string): string {
  // Prefer a content line (bullet or paragraph) over a header. Strip leading
  // markdown chars so the preview reads cleanly.
  const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
  // First pass: skip headers, find content
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) continue; // skip header
    const cleaned = line.replace(/^[>\-*]+\s*/, "").trim();
    if (cleaned && !/^_+\(/.test(cleaned)) return cleaned.slice(0, 160);
  }
  // Fallback: take first header text (strip all leading #s)
  for (const line of lines) {
    const cleaned = line.replace(/^[#>\-*]+\s*/, "").trim();
    if (cleaned) return cleaned.slice(0, 160);
  }
  return s.slice(0, 160);
}

function toListEntry(rec: SessionRecord): SessionListEntry {
  return {
    id: rec.id,
    channelName: rec.channelName,
    joinedAt: rec.joinedAt,
    leftAt: rec.leftAt,
    durationMs: rec.durationMs,
    participants: rec.participants ?? [],
    segmentCount: rec.segmentCount ?? 0,
    summaryPreview: summaryFirstLine(rec.summary ?? ""),
  };
}

function bootSessionsIndex(): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  let loaded = 0;
  for (const f of readdirSync(SESSIONS_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = readFileSync(join(SESSIONS_DIR, f), "utf8");
      const rec = JSON.parse(raw) as SessionRecord;
      if (rec?.id) {
        sessionsIndex.set(rec.id, toListEntry(rec));
        loaded++;
      }
    } catch (e: any) {
      console.warn(`[yoi-ui] bad session file ${f}: ${e?.message ?? e}`);
    }
  }
  console.log(`[yoi-ui] sessions index: ${loaded} loaded from ${SESSIONS_DIR}`);
}

function saveSession(payload: Partial<SessionRecord>): SessionRecord | null {
  if (!payload?.id || typeof payload.id !== "string") return null;
  const rec: SessionRecord = {
    id: payload.id,
    channelName: payload.channelName ?? "voice",
    channelId: payload.channelId,
    guildId: payload.guildId,
    joinedAt: Number(payload.joinedAt) || Date.now(),
    leftAt: Number(payload.leftAt) || Date.now(),
    durationMs: Number(payload.durationMs) || 0,
    participants: Array.isArray(payload.participants) ? payload.participants : [],
    segmentCount: Number(payload.segmentCount) || 0,
    summary: typeof payload.summary === "string" ? payload.summary : "",
    transcriptMd: typeof payload.transcriptMd === "string" ? payload.transcriptMd : "",
    receivedAt: Date.now(),
  };
  writeFileSync(sessionFilePath(rec.id), JSON.stringify(rec, null, 2), "utf8");
  sessionsIndex.set(rec.id, toListEntry(rec));
  return rec;
}

function loadSession(id: string): SessionRecord | null {
  const p = sessionFilePath(id);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as SessionRecord;
  } catch {
    return null;
  }
}

function deleteSession(id: string): boolean {
  const p = sessionFilePath(id);
  if (!existsSync(p)) return false;
  try {
    unlinkSync(p);
    sessionsIndex.delete(id);
    return true;
  } catch {
    return false;
  }
}

function listSessions(limit: number): SessionListEntry[] {
  // Newest first by joinedAt.
  return Array.from(sessionsIndex.values())
    .sort((a, b) => b.joinedAt - a.joinedAt)
    .slice(0, limit);
}

// ─── Session helpers ────────────────────────────────────────────────────────

function sign(payload: string): string {
  return createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
}
function makeSessionCookie(): string {
  const payload = `ok.${Date.now()}`;
  const value = `${payload}.${sign(payload)}`;
  return `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE_SEC}; Secure`;
}
function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Secure`;
}
function isAuthed(req: Request): boolean {
  const cookieHeader = req.headers.get("cookie") ?? "";
  const cookie = cookieHeader
    .split(";")
    .map((c) => c.trim().split("="))
    .find(([k]) => k === COOKIE_NAME);
  if (!cookie) return false;
  const value = cookie[1] ?? "";
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  const [okWord, ts, sig] = parts;
  if (okWord !== "ok") return false;
  const expected = sign(`${okWord}.${ts}`);
  try {
    const a = Buffer.from(sig!, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ─── HTML rendering ─────────────────────────────────────────────────────────

const INDEX_HTML_PATH = join(__dirname, "index.html");
let indexCache: string | null = null;

const LOGIN_BLOCK = `
<div class="login">
  <h2>🌀 Yoi live</h2>
  <form method="POST" action="/login" id="loginForm">
    <input type="password" name="password" placeholder="password" autofocus autocomplete="current-password" />
    <button type="submit" class="primary">Sign in</button>
    <div class="err" id="err" style="display:none">wrong password</div>
  </form>
</div>
<script>
  document.getElementById("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const res = await fetch("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: fd.get("password") }),
    });
    if (res.ok) location.href = "/";
    else document.getElementById("err").style.display = "block";
  });
</script>
`;

const FEED_BLOCK = `
<header>
  <h1>🌀 Yoi live</h1>
  <span class="status" id="status"><span class="dot"></span><span class="label">connecting…</span></span>
  <div class="tabs">
    <button class="tab" id="tab-chat">💬 Chat <span class="badge hidden" id="badge-chat"></span></button>
    <button class="tab" id="tab-events">🪵 Events <span class="badge hidden" id="badge-events"></span></button>
    <button class="tab" id="tab-sessions">📚 Sessions</button>
  </div>
  <div class="controls">
    <button data-control="speak-on">🎤 speak-on</button>
    <button data-control="speak-off">🔇 speak-off</button>
    <button data-control="save">💾 save</button>
    <button data-control="leave" class="danger" title="ออก + summary สั้น">🚪 leave</button>
    <button data-control="leave-long" class="danger" title="ออก + summary แบบละเอียด (หัวข้อ/decision/action/quotes/speakers/open Q)">🚪 leave-long</button>
    <button id="logout">Log out</button>
  </div>
</header>
<div class="tts-bar">
  <select id="tts-voice" title="TTS voice profile">
    <option value="kanya">🇹🇭 Kanya</option>
    <option value="kanya-compact">🇹🇭 Kanya-compact</option>
    <option value="narisa">🇹🇭 Narisa</option>
    <option value="leda">🌐 Leda (multilingual)</option>
  </select>
  <input type="text" id="tts-text" placeholder="พิมพ์ข้อความให้หยอยพูด… (Enter = Say)" autocomplete="off" />
  <button id="tts-say" class="primary" title="พูดข้อความตรง ๆ (TTS)">🔊 Say</button>
  <button id="tts-think" title="ส่งให้ Claude คิดแล้วพูด">💭 Think</button>
</div>
<main>
  <div id="chat-panel" class="panel"></div>
  <div id="events-panel" class="panel"></div>
  <div id="sessions-panel" class="panel"></div>
</main>
<div id="flash"></div>
`;

function renderPage(authed: boolean): string {
  if (!indexCache) indexCache = readFileSync(INDEX_HTML_PATH, "utf8");
  return indexCache.replace("<!--AUTH_SLOT-->", authed ? FEED_BLOCK : LOGIN_BLOCK);
}

// ─── SSE handler ────────────────────────────────────────────────────────────

function sseStream(req: Request): Response {
  // Parse Last-Event-ID so reconnects only get NEW events (no spam replay).
  // EventSource sends this header automatically with the value of the last
  // `id:` field it received. We use server-side monotonic event IDs so client
  // reconnects can resume from where they left off.
  const lastIdRaw = req.headers.get("last-event-id") ?? "";
  const lastId = Number.isFinite(Number(lastIdRaw)) ? Number(lastIdRaw) : 0;

  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const write = (s: string) => {
        try { controller.enqueue(enc.encode(s)); } catch {}
      };
      const client: SseClient = { write };
      sseClients.add(client);
      // Replay ONLY events strictly newer than lastId. Fresh clients (no
      // header) get the full ring once; reconnecting clients pick up just
      // the gap — no duplicates.
      for (const ev of ring) {
        if (ev._id > lastId) write(`id: ${ev._id}\ndata: ${JSON.stringify(ev)}\n\n`);
      }
      // No noisy "(SSE connected)" hello — connection success is implied by
      // the stream being open; clients show status indicator via es.onopen.
      const ka = setInterval(() => write(`: keepalive\n\n`), 15_000);
      req.signal.addEventListener("abort", () => {
        sseClients.delete(client);
        clearInterval(ka);
        try { controller.close(); } catch {}
      });
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

// ─── Routes ─────────────────────────────────────────────────────────────────

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // POST /api/ingest — bearer-auth from Mac voice-bot
  // GET /api/control/pending — Mac voice-bot drains the queue (bearer auth).
  // Returns and CLEARS up to N commands per call. Mac executes each.
  if (req.method === "GET" && path === "/api/control/pending") {
    const auth = req.headers.get("authorization") ?? "";
    if (!INGEST_TOKEN || auth !== `Bearer ${INGEST_TOKEN}`) {
      return new Response("unauthorized", { status: 401 });
    }
    const drained = controlQueue.splice(0, 50);
    return new Response(JSON.stringify({ ok: true, commands: drained }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }

  // POST /api/sessions — bearer-auth: Mac voice-bot uploads a completed
  // meeting (transcript + summary + meta). Idempotent on id (overwrites).
  if (req.method === "POST" && path === "/api/sessions") {
    const auth = req.headers.get("authorization") ?? "";
    if (!INGEST_TOKEN || auth !== `Bearer ${INGEST_TOKEN}`) {
      return new Response("unauthorized", { status: 401 });
    }
    try {
      const body = (await req.json()) as Partial<SessionRecord>;
      const saved = saveSession(body);
      if (!saved) {
        return new Response(JSON.stringify({ ok: false, message: "missing id" }), {
          status: 400, headers: { "Content-Type": "application/json" },
        });
      }
      console.log(
        `[yoi-ui] session saved: ${saved.id} (${saved.segmentCount} seg, ${saved.transcriptMd.length} chars)`,
      );
      return new Response(JSON.stringify({ ok: true, id: saved.id }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    } catch (e: any) {
      return new Response(`bad json: ${e?.message ?? e}`, { status: 400 });
    }
  }

  if (req.method === "POST" && path === "/api/ingest") {
    const auth = req.headers.get("authorization") ?? "";
    if (!INGEST_TOKEN || auth !== `Bearer ${INGEST_TOKEN}`) {
      return new Response("unauthorized", { status: 401 });
    }
    try {
      const body = await req.json();
      // Accept either a single event or an array
      const events = Array.isArray(body) ? body : [body];
      for (const ev of events) {
        if (typeof ev === "object" && ev && "type" in ev) {
          const obj = ev as Record<string, unknown>;
          pushEvent({
            ...obj,
            ts: typeof obj.ts === "number" ? obj.ts : Date.now(),
            type: String(obj.type),
          });
        }
      }
      return new Response(JSON.stringify({ ok: true, accepted: events.length }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e: any) {
      return new Response(`bad json: ${e?.message ?? e}`, { status: 400 });
    }
  }

  if (req.method === "POST" && path === "/login") {
    try {
      const body = (await req.json()) as { password?: string };
      if (body.password === PASSWORD) {
        return new Response("ok", { status: 200, headers: { "Set-Cookie": makeSessionCookie() } });
      }
      return new Response("wrong password", { status: 401 });
    } catch {
      return new Response("bad request", { status: 400 });
    }
  }
  if (req.method === "POST" && path === "/logout") {
    return new Response("ok", { status: 200, headers: { "Set-Cookie": clearSessionCookie() } });
  }

  const authed = isAuthed(req);

  if (req.method === "GET" && (path === "/" || path === "/index.html")) {
    return new Response(renderPage(authed), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  if (req.method === "GET" && path === "/health") {
    return new Response(JSON.stringify({ ok: true, ring: ring.length, clients: sseClients.size }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!authed) return new Response("unauthorized", { status: 401 });

  if (req.method === "GET" && path === "/feed") {
    return sseStream(req);
  }

  // GET /api/sessions?limit=N — list (newest first), no transcript/summary body
  if (req.method === "GET" && path === "/api/sessions") {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
    return new Response(JSON.stringify({ ok: true, sessions: listSessions(limit) }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }

  // GET /api/sessions/:id — full record (summary + transcriptMd)
  if (req.method === "GET" && path.startsWith("/api/sessions/")) {
    const id = decodeURIComponent(path.slice("/api/sessions/".length));
    const rec = loadSession(id);
    if (!rec) return new Response(JSON.stringify({ ok: false, message: "not found" }), {
      status: 404, headers: { "Content-Type": "application/json" },
    });
    return new Response(JSON.stringify({ ok: true, session: rec }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }

  // DELETE /api/sessions/:id — remove from index + disk
  if (req.method === "DELETE" && path.startsWith("/api/sessions/")) {
    const id = decodeURIComponent(path.slice("/api/sessions/".length));
    const ok = deleteSession(id);
    return new Response(JSON.stringify({ ok }), {
      status: ok ? 200 : 404, headers: { "Content-Type": "application/json" },
    });
  }

  // POST /api/control (session-auth) — UI user pushes a command into the queue
  if (req.method === "POST" && path === "/api/control") {
    try {
      const body = (await req.json()) as { action?: string; arg?: string };
      const action = (body.action ?? "").toLowerCase();
      if (!ALLOWED_CONTROL_ACTIONS.has(action)) {
        return new Response(JSON.stringify({ ok: false, message: `unknown action: ${action}` }), {
          status: 400, headers: { "Content-Type": "application/json" },
        });
      }
      const cmd: ControlCommand = {
        id: `ui-${Date.now()}-${randomBytes(4).toString("hex")}`,
        ts: Date.now(),
        action,
        arg: body.arg?.trim() || undefined,
      };
      controlQueue.push(cmd);
      // Don't push an optimistic feed event here — Mac voice-bot will emit a
      // real session/transcript event when the command actually executes. The
      // immediate /api/control response + browser flash is enough confirmation
      // and keeps the events tab from filling with stale "(queued)" entries
      // that get replayed on every SSE reconnect.
      return new Response(JSON.stringify({ ok: true, message: `🌀 queued ${action}`, id: cmd.id }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ ok: false, message: e?.message ?? "bad request" }), {
        status: 400, headers: { "Content-Type": "application/json" },
      });
    }
  }

  return new Response("not found", { status: 404 });
}

Bun.serve({
  port: PORT,
  fetch: (req) => handleRequest(req).catch((e) =>
    new Response(`internal: ${e?.message ?? e}`, { status: 500 }),
  ),
});

bootSessionsIndex();
console.log(`[yoi-ui] 🌐 listening on http://localhost:${PORT}`);
console.log(`[yoi-ui] ring=${RING_SIZE} | sessions=${SESSIONS_DIR} | ingest=${INGEST_TOKEN ? "enabled" : "DISABLED (token missing)"}`);
