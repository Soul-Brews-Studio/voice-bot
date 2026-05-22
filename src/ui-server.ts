/**
 * Codey live UI server — Bun.serve() web app.
 *
 * Routes:
 *   GET  /            — login page if no session cookie, else live-feed page
 *   POST /login       — validate UI_PASSWORD, set session cookie
 *   POST /logout      — clear session cookie
 *   GET  /feed        — Server-Sent Events stream of live-feed.jsonl events
 *   POST /api/control — { action: "join"|"leave"|"speak-on"|"speak-off",
 *                        arg?: string } — writes to voice-commands IPC dir
 *
 * Session: simple cookie with HMAC-signed payload. No DB.
 * Disabled if UI_ENABLED=false. Defaults: port 8080, password "changeme".
 *
 * Designed to run in the same process as voice-bot (Mac) for v1. Phase 2 will
 * split the UI server out for VPS deployment with a Mac↔VPS bridge.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync, openSync, readSync, closeSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { LIVE_FEED_PATH } from "./live-feed.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.UI_PORT) || 8080;
const PASSWORD = process.env.UI_PASSWORD || "changeme";
const SESSION_SECRET = process.env.UI_SESSION_SECRET || randomBytes(32).toString("hex");
const ENABLED = process.env.UI_ENABLED !== "false";
const COOKIE_NAME = "codey-session";
const COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 7; // 7 days

const VOICE_CMD_DIR = join(
  homedir(),
  ".claude",
  "channels",
  "codey",
  "voice-commands",
);

const INDEX_HTML_PATH = join(__dirname, "ui", "index.html");

// ─── Session helpers ────────────────────────────────────────────────────────

function sign(payload: string): string {
  return createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
}

function makeSessionCookie(): string {
  const payload = `ok.${Date.now()}`;
  const sig = sign(payload);
  const value = `${payload}.${sig}`;
  return `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE_SEC}`;
}

function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
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

const LOGIN_BLOCK = `
<div class="login">
  <h2>🌀 Codey live</h2>
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
    if (res.ok) {
      location.href = "/";
    } else {
      document.getElementById("err").style.display = "block";
    }
  });
</script>
`;

const FEED_BLOCK = `
<header>
  <h1>🌀 Codey live</h1>
  <span class="status" id="status"><span class="dot"></span><span class="label">connecting…</span></span>
  <div class="tabs">
    <button class="tab" id="tab-chat">💬 Chat <span class="badge hidden" id="badge-chat"></span></button>
    <button class="tab" id="tab-events">🪵 Events <span class="badge hidden" id="badge-events"></span></button>
  </div>
  <div class="controls">
    <button data-control="speak-on">🎤 speak-on</button>
    <button data-control="speak-off">🔇 speak-off</button>
    <button data-control="save">💾 save</button>
    <button data-control="leave" class="danger" title="ออก + summary สั้น">🚪 leave</button>
    <button data-control="leave-long" class="danger" title="ออก + summary แบบละเอียด">🚪 leave-long</button>
    <button id="logout">Log out</button>
  </div>
</header>
<main>
  <div id="chat-panel" class="panel"></div>
  <div id="events-panel" class="panel"></div>
</main>
<div id="flash"></div>
`;

let indexCache: string | null = null;
function renderPage(authed: boolean): string {
  if (!indexCache) indexCache = readFileSync(INDEX_HTML_PATH, "utf8");
  return indexCache.replace("<!--AUTH_SLOT-->", authed ? FEED_BLOCK : LOGIN_BLOCK);
}

// ─── Live feed SSE: tail JSONL ───────────────────────────────────────────────

interface TailState {
  fd: number;
  pos: number;
}

function openTail(): TailState | null {
  try {
    if (!statSync(LIVE_FEED_PATH).isFile()) return null;
    const fd = openSync(LIVE_FEED_PATH, "r");
    // Start at EOF — client gets only events that occur AFTER connection.
    const size = statSync(LIVE_FEED_PATH).size;
    return { fd, pos: size };
  } catch {
    return null;
  }
}

function readNewBytes(state: TailState): string[] {
  const lines: string[] = [];
  try {
    const size = statSync(LIVE_FEED_PATH).size;
    // Handle file rotation/truncation
    if (size < state.pos) {
      closeSync(state.fd);
      state.fd = openSync(LIVE_FEED_PATH, "r");
      state.pos = 0;
    }
    if (size > state.pos) {
      const buf = Buffer.alloc(size - state.pos);
      readSync(state.fd, buf, 0, buf.length, state.pos);
      state.pos = size;
      const text = buf.toString("utf8");
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (t) lines.push(t);
      }
    }
  } catch {}
  return lines;
}

function sseStream(req: Request): Response {
  let state = openTail();
  let interval: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const send = (data: string) =>
        controller.enqueue(enc.encode(`data: ${data}\n\n`));
      // Initial hello
      send(JSON.stringify({ type: "session", action: "join", channelName: "(SSE connected)", ts: Date.now() }));
      interval = setInterval(() => {
        if (!state) {
          state = openTail();
          return;
        }
        const lines = readNewBytes(state);
        for (const line of lines) send(line);
      }, 500);
      // Keepalive comment every 30s so proxies don't close idle
      const ka = setInterval(() => controller.enqueue(enc.encode(`: keepalive\n\n`)), 30_000);
      req.signal.addEventListener("abort", () => {
        clearInterval(interval);
        clearInterval(ka);
        if (state) try { closeSync(state.fd); } catch {}
        try { controller.close(); } catch {}
      });
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

// ─── Control IPC ────────────────────────────────────────────────────────────

interface ControlBody {
  action: string;
  arg?: string;
}

async function handleControl(body: ControlBody): Promise<{ ok: boolean; message: string }> {
  let action = (body.action ?? "").toLowerCase();
  const arg = (body.arg ?? "").trim();
  // Map UI actions → VoiceCommand schema (matches voice-bot/src/command-types.ts)
  const ALLOWED = new Set([
    "join", "leave", "leave-long", "save", "status", "speak-on", "speak-off", "say", "think", "voice", "note",
    "stay", "unstay",
  ]);
  if (!ALLOWED.has(action)) {
    return { ok: false, message: `unknown action: ${action}` };
  }
  // "leave-long" is UI-only sugar — normalize to leave + summaryMode flag.
  let summaryMode: "short" | "long" | undefined;
  if (action === "leave-long") {
    action = "leave";
    summaryMode = "long";
  } else if (action === "leave") {
    summaryMode = arg.toLowerCase() === "long" ? "long" : "short";
  }
  mkdirSync(VOICE_CMD_DIR, { recursive: true });
  const requestId = `ui-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const cmd: Record<string, unknown> = {
    action,
    source: "session",
    issuedAt: new Date().toISOString(),
    requestId,
    requester: "ui",
  };
  if (summaryMode) cmd.summaryMode = summaryMode;
  if (action === "join" && arg) {
    if (/^\d{15,25}$/.test(arg)) cmd.channelId = arg;
    else cmd.channelName = arg;
  }
  if (action === "voice" && arg) cmd.profile = arg;
  if ((action === "say" || action === "think" || action === "note") && arg) cmd.text = arg;
  if (action === "stay" && arg) {
    const h = Number(arg);
    if (Number.isFinite(h) && h > 0) cmd.stayHours = h;
  }
  try {
    writeFileSync(
      join(VOICE_CMD_DIR, `${requestId}.json`),
      JSON.stringify(cmd, null, 2),
    );
    return { ok: true, message: `🌀 queued ${action}` };
  } catch (e: any) {
    return { ok: false, message: `failed: ${e?.message ?? e}` };
  }
}

// ─── HTTP routing ───────────────────────────────────────────────────────────

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // POST /login
  if (req.method === "POST" && path === "/login") {
    try {
      const body = (await req.json()) as { password?: string };
      if (body.password === PASSWORD) {
        return new Response("ok", {
          status: 200,
          headers: { "Set-Cookie": makeSessionCookie() },
        });
      }
      return new Response("wrong password", { status: 401 });
    } catch {
      return new Response("bad request", { status: 400 });
    }
  }

  // POST /logout
  if (req.method === "POST" && path === "/logout") {
    return new Response("ok", {
      status: 200,
      headers: { "Set-Cookie": clearSessionCookie() },
    });
  }

  const authed = isAuthed(req);

  // GET /  → login page or feed page
  if (req.method === "GET" && (path === "/" || path === "/index.html")) {
    return new Response(renderPage(authed), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // Authed-only endpoints below
  if (!authed) return new Response("unauthorized", { status: 401 });

  // GET /feed → SSE
  if (req.method === "GET" && path === "/feed") {
    return sseStream(req);
  }

  // POST /api/control → IPC
  if (req.method === "POST" && path === "/api/control") {
    try {
      const body = (await req.json()) as ControlBody;
      const result = await handleControl(body);
      return new Response(JSON.stringify(result), {
        status: result.ok ? 200 : 400,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e: any) {
      return new Response(
        JSON.stringify({ ok: false, message: e?.message ?? "bad request" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  return new Response("not found", { status: 404 });
}

let server: ReturnType<typeof Bun.serve> | null = null;

export function startUiServer(): void {
  if (!ENABLED) {
    console.log("[ui-server] disabled (UI_ENABLED=false)");
    return;
  }
  server = Bun.serve({
    port: PORT,
    fetch: (req) =>
      handleRequest(req).catch(
        (e) =>
          new Response(`internal: ${e?.message ?? e}`, { status: 500 }),
      ),
  });
  console.log(
    `[ui-server] 🌐 listening on http://localhost:${PORT} (password=${PASSWORD === "changeme" ? "default" : "custom"})`,
  );
}

export function stopUiServer(): void {
  server?.stop();
  server = null;
}
