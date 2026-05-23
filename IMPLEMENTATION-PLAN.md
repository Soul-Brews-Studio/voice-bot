# Voice Bot v2 — Implementation Plan

## Context

Voice bot v1 (Soul-Brews-Studio/voice-bot) เป็น single-bot voice transcriber ที่ทำงานได้ดีแต่มีข้อจำกัด:
- Single bot only, hardcode "codey"
- Brain ใช้ file IPC (think-bridge.ts → maw hey → Claude session) ซับซ้อน
- Commands เป็น slash commands 16 aliases (cj, cl, cs...) ไม่ scalable
- ไม่มี follow mode, ไม่มี multi-bot server

v2 จะรวม voice + text + Discord plugin เป็นตัวเดียวใน maw discord plugin โดยใช้ Claude Code session เป็นสมองตรงๆ รองรับ 5-7 bots พร้อมกัน

**2 repos, 2 branches:**
- `Soul-Brews-Studio/voice-bot` branch `v2` — voice bot core (STT, TTS, audio, voice session, bot process)
- `Soul-Brews-Studio/maw-js` branch `voice-bot-v2` (จาก `vendor-discord-plugin`) — discord plugin extension (server, slash commands, CLI, follow)

---

## What to Keep from v1 (proven, reuse)

| File (v1) | Purpose | Changes for v2 |
|-----------|---------|----------------|
| `audio-pipeline.ts` | opus → PCM → WAV chunks, silence detection | Minimal — extract config, remove hardcoded paths |
| `voice-session.ts` | Discord voice connection + recording | Refactor — remove brain/trigger coupling, extract to pure voice module |
| `transcript-writer.ts` | Markdown transcript output | Keep as-is |
| `speak-state.ts` | Mute/unmute logic | Keep — add per-bot state |
| `stt/groq.ts` | Groq Whisper STT | Keep as-is |
| `stt/whisperCpp.ts` | whisper.cpp local STT | Keep as-is |
| `stt/hallucinations.ts` | Known false positive filter | Keep as-is |
| `tts.ts` (Edge TTS part) | Edge TTS | Extract to `tts/edge.ts` |
| `auto-shutdown.ts` | Graceful shutdown | Keep as-is |
| `cost.ts` | Token/cost tracking | Keep — rename gemini → groq |
| `session-archive.ts` | Session archiving | Keep as-is |

## What to Delete from v1

| File | Why |
|------|-----|
| `brain.ts` | Brain = Claude session, ไม่ต้อง Groq LLM แยก |
| `think-bridge.ts` | ไม่ต้อง file IPC, Claude bridge ตรงๆ |
| `command-watcher.ts` | Server HTTP แทน file polling |
| `remote-control-poller.ts` | Server HTTP แทน |
| `commands.ts` | `/bot-*` slash commands อยู่ใน maw-js server |
| `register-commands.ts` | Slash command registration อยู่ใน server |
| `handoff.ts` | Claude session จัดการเอง |
| `live-feed.ts` | UI server อยู่ใน maw-js server |
| `ui-server.ts` | UI อยู่ใน maw-js server |
| `pid-file.ts` | Server registry แทน PID file |
| `discord-transcript.ts` | รวมใน transcript-writer |
| `transcript-cleaner.ts` | Claude session ทำเอง |

## What's New

| Feature | Where | Detail |
|---------|-------|--------|
| **maw discord server** | maw-js | Always-running process, bot registry, `/bot-*` slash commands, autocomplete, follow manager |
| **Claude bridge** | voice-bot | Forward messages ↔ Claude Code session ตรงๆ (ไม่ผ่าน file IPC) |
| **Follow mode** | maw-js server | Bot ตามคนไปทุก voice channel, VoiceStateUpdate listener |
| **Multi-bot** | ทั้งสอง | 5-7 bots per machine, per-bot config, server registry |
| **Typhoon ASR** | voice-bot | New STT backend, Thai-native, streaming |
| **Pairing system** | maw-js | 6-char code pairing flow (จาก discord plugin pattern) |
| **Server-Bot HTTP** | ทั้งสอง | Register/heartbeat/command protocol |

---

## v2 File Structure (voice-bot repo)

```
src/
├── voice/
│   ├── voice-session.ts    (from src/voice-session.ts, refactored)
│   ├── audio-pipeline.ts   (from src/audio-pipeline.ts)
│   ├── speak-state.ts      (from src/speak-state.ts)
│   └── trigger.ts          (new — trigger phrase detection extracted)
├── stt/
│   ├── index.ts            (router: typhoon → groq → whisper)
│   ├── typhoon.ts          (NEW)
│   ├── groq.ts             (from src/stt/groq.ts)
│   ├── whisper-cpp.ts      (from src/stt/whisperCpp.ts)
│   ├── hallucinations.ts   (from src/stt/hallucinations.ts)
│   └── types.ts            (from src/stt/types.ts)
├── tts/
│   ├── index.ts            (router)
│   └── edge.ts             (extracted from src/tts.ts)
├── bot/
│   ├── index.ts            (bot entry — Discord login + register)
│   ├── discord-client.ts   (Discord.js client + events)
│   ├── claude-bridge.ts    (NEW — forward ↔ Claude session)
│   └── register.ts         (NEW — register/heartbeat with server)
├── text/
│   ├── message-handler.ts  (NEW — @mention → Claude)
│   └── chunker.ts          (NEW — auto-chunk >2000 chars)
├── tools/
│   ├── reply.ts            (NEW — Discord tools for Claude)
│   ├── react.ts
│   ├── voice-join.ts
│   ├── voice-leave.ts
│   └── voice-say.ts
├── transcript-writer.ts    (keep)
├── auto-shutdown.ts        (keep)
├── cost.ts                 (keep, rename gemini → groq)
├── session-archive.ts      (keep)
└── voice-config.ts         (keep)
```

## maw-js Discord Plugin Extension

```
src/vendor/mpr-plugins/discord/
├── (existing: index.ts, lib.ts, tokens.ts, status.ts, bind.ts, access.ts, inventory.ts)
│
├── server/                        (NEW — maw discord server)
│   ├── index.ts                   (Bun.serve HTTP server)
│   ├── registry.ts                (bot register/deregister/heartbeat, 90s offline)
│   ├── slash-commands.ts          (/bot-join, /bot-leave, /bot-mute, etc.)
│   ├── autocomplete.ts            (real-time bot + channel + member suggestions)
│   ├── command-router.ts          (forward commands → bot processes via HTTP)
│   └── follow-manager.ts          (FollowState tracking, VoiceStateUpdate, auto-move)
```

---

## Implementation Phases

### Phase 0: Setup + Typhoon ASR Eval
**Repo: voice-bot branch `v2`**

1. สร้าง branch `v2` จาก `main`
2. ลบไฟล์ที่ไม่ต้องการ (brain.ts, think-bridge.ts, command-watcher.ts, remote-control-poller.ts, commands.ts, register-commands.ts, handoff.ts, live-feed.ts, ui-server.ts, pid-file.ts, discord-transcript.ts, transcript-cleaner.ts)
3. Restructure directory ตาม file structure ด้านบน
4. ติดตั้ง Typhoon ASR, เขียน `stt/typhoon.ts`
5. Benchmark: Typhoon vs Groq vs whisper.cpp (latency, Thai quality)
6. ตัดสินใจ STT primary

**Deliverable:** Clean v2 structure + Typhoon ASR evaluation results

---

### Phase 1: maw discord server
**Repo: maw-js branch `voice-bot-v2` (จาก `vendor-discord-plugin`)**

1. สร้าง branch `voice-bot-v2` จาก `vendor-discord-plugin`
2. สร้าง `server/` directory ตาม structure ด้านบน
3. Implement:
   - `index.ts` — Bun.serve HTTP server
   - `registry.ts` — bot register/deregister/heartbeat, mark offline หลัง 90s
   - `slash-commands.ts` — register `/bot-join`, `/bot-leave`, `/bot-mute`, `/bot-unmute`, `/bot-status`, `/bot-follow`, `/bot-unfollow`, `/bot-say`, `/bot-think`
   - `autocomplete.ts` — bot list (online only + channel), voice channels (real-time), guild members
   - `command-router.ts` — forward command → bot process via HTTP POST
   - `follow-manager.ts` — FollowState, VoiceStateUpdate listener, auto-move
4. เพิ่ม `maw discord server` CLI subcommand
5. Update plugin.json version → 0.5.0

**Deliverable:** `maw discord server` starts, slash commands register in Discord, autocomplete works

---

### Phase 2: Bot process + Claude bridge
**Repo: voice-bot branch `v2`**

1. เขียน `bot/index.ts` — bot entry:
   - Parse config (bot name, token, voice profile)
   - Login Discord
   - Register with maw discord server (HTTP POST /register)
   - Start heartbeat (30s)
   - Start Claude Code session
2. เขียน `bot/discord-client.ts` — Discord.js client, event routing
3. เขียน `bot/claude-bridge.ts` — forward ↔ Claude session ตรงๆ (ไม่ใช้ file IPC)
4. เขียน `bot/register.ts` — HTTP register/heartbeat
5. เพิ่ม `maw discord wake <bot>` / `sleep <bot>` ใน maw-js (extend bind.ts pattern)

**Deliverable:** `maw discord wake codey` → bot online, text → Claude ตอบ

---

### Phase 3: Voice pipeline (port จาก v1)
**Repo: voice-bot branch `v2`**

1. Refactor `voice-session.ts` — remove brain/trigger coupling, accept server commands
2. Wire audio-pipeline → STT router → transcript
3. Wire trigger → Claude bridge → TTS → playback
4. Server command handling: join, leave, mute, unmute, say

**Deliverable:** `/bot-join` → voice → พูดไทย → transcript → TTS ตอบ

---

### Phase 4: Text pipeline
**Repo: voice-bot branch `v2`**

1. `text/message-handler.ts` — @mention → access check → Claude
2. `text/chunker.ts` — split >2000 chars

**Deliverable:** @codey → Claude ตอบใน text channel

---

### Phase 5: Follow mode + Access control
**Repo: maw-js branch `voice-bot-v2`**

1. Follow: `/bot-follow codey bm` → VoiceStateUpdate → auto-move
2. Access: pairing (6-char code), allowlist, channel opt-in (extend existing access.ts)

**Deliverable:** Follow mode + pairing system ทำงาน

---

### Phase 6: Discord tools for Claude
**Repo: voice-bot branch `v2`**

1. เขียน tools: reply, react, edit-message, fetch-messages, voice-join, voice-leave, voice-say
2. Register เป็น MCP tools

**Deliverable:** Claude ตัดสินใจ react/join voice เอง

---

### Phase 7: CLI integration
**Repo: maw-js branch `voice-bot-v2`**

1. `maw discord wake --all` / `sleep --all`
2. `maw discord status` fleet dashboard (extend status.ts)

**Deliverable:** Fleet management CLI

---

### Phase 8: Multi-bot testing

1. สร้าง bot tokens 5 ตัวใน Discord Developer Portal
2. Wake 5 bots, stress test concurrent STT
3. วัด RAM/CPU per bot
4. Test follow + edge cases (crash, reconnect)

**Deliverable:** 5 bots stable, performance documented

---

## Server-Bot HTTP Protocol

```
Bot → Server:
  POST /register   { botName, guildIds, status: "online" }
  POST /deregister { botName }
  POST /heartbeat  { botName, currentChannel, followTarget }

Server → Bot:
  POST /command    { action: "join", channelId }
  POST /command    { action: "leave" }
  POST /command    { action: "follow", targetUserId }
  POST /command    { action: "mute" | "unmute" }
  POST /command    { action: "say", text }
  POST /command    { action: "think", message }
```

---

## Verification (End-to-End)

1. `maw discord server` running
2. `maw discord wake codey` → bot online
3. `/bot-join codey #voice-a` → bot joins voice
4. พูดไทย → transcript → trigger "โคดี้ตอบหน่อย" → Claude thinks → TTS reply
5. @codey text → Claude replies
6. `/bot-follow codey bm` → bm ย้ายห้อง → codey ตาม
7. `maw discord wake pulse` → second bot online
8. `maw discord status` → shows both bots
9. `maw discord sleep --all` → both offline
