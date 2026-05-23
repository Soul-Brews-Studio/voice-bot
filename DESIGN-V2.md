# Voice Bot v2 — Design Document

> Draft: 2026-05-22 | Updated: 2026-05-23 | Status: Discussion / Not yet implemented

## 1. Vision

Voice Bot v2 รวม **voice + text + Discord plugin** เป็นตัวเดียว
ใช้ **Claude Code session** เป็นสมอง (ท่าเดียวกับ claude-plugins-official แต่เขียนเอง)
ทุกอย่างอยู่ใน **maw discord plugin ตัวเดียว** (text + voice + server)
ไม่พึ่ง `@claude-plugins-official` — ควบคุมเองทั้งหมด

## 2. Architecture Overview

```
┌──────────────────────────────────────────────────┐
│          maw discord server                       │
│          (แยก process, always running)            │
│                                                   │
│  • รับ /bot-* slash commands                     │
│  • bot registry (ใคร online)                     │
│  • autocomplete (real-time)                      │
│  • follow manager                                │
│  • forward commands ไปหา bot                     │
└────┬──────────┬──────────┬───────────────────────┘
     │ register │ register │ register
     ▼          ▼          ▼
┌─────────┐ ┌─────────┐ ┌─────────┐
│ codey   │ │ pulse   │ │ neo     │  ... (5-7 per machine)
│         │ │         │ │         │
│ Claude  │ │ Claude  │ │ Claude  │  ← สมอง
│ session │ │ session │ │ session │
│    +    │ │    +    │ │    +    │
│ voice   │ │ voice   │ │ voice   │  ← text + voice
│ bot     │ │ bot     │ │ bot     │
└────┬────┘ └────┬────┘ └────┬────┘
     │           │           │
     ▼           ▼           ▼
  Discord Voice Gateway (direct, per bot)
```

### 2.1 ทุกอย่างอยู่ใน maw discord plugin ตัวเดียว

```
maw discord plugin
├── server   (maw discord server — process แยก, always running)
├── text     (มีอยู่แล้ว — wake, bind, status, access)
└── voice    (เพิ่มใหม่ — STT, TTS, voice session, audio pipeline)
```

ไม่แยก plugin — text, voice, server อยู่ด้วยกันหมด

### 2.2 maw discord server (แยก process)

- **Always running** — แม้ไม่มี bot online ก็ต้องรับ slash commands ได้
- รับ `/bot-*` commands จาก Discord
- track ว่า bot ตัวไหน online/offline
- จัดการ autocomplete (real-time จาก Discord API)
- จัดการ follow state
- ไม่แตะ audio — แค่ command + status + forward

### 2.3 Bot Process (แต่ละตัว)

- **1 process = Claude Code session + voice bot รวมกัน**
- Claude session = สมอง (tools, Oracle, memory, files)
- voice bot = Discord connection (text + voice)
- ต่อ Discord voice gateway ตรง (audio ไม่ผ่าน server)
- มี STT/TTS pipeline ของตัวเอง
- register กับ maw discord server เมื่อ start

### 2.4 Lifecycle

```
maw discord server
  → start server process (always running)
  → พร้อมรับ slash commands + bot registrations

maw discord wake codey
  → start 1 process: Claude session + voice bot
  → bot login Discord (online, text + voice)
  → register กับ maw discord server
  → autocomplete เริ่มเห็น "codey"

maw discord sleep codey
  → bot logout Discord (offline)
  → deregister จาก server
  → autocomplete ไม่เห็น "codey" แล้ว
  → process ปิด

maw discord status
  → แสดงว่าใคร online, อยู่ห้องไหน, follow ใคร
```

## 3. Commands

### 3.1 Slash Commands (Discord)

ทุก command ใช้ **autocomplete** — ดึง real-time จาก Discord API
ไม่ hardcode, ไม่ cache — channel เปลี่ยนชื่อ/ถูกลบ เห็นทันที
Bot offline ไม่โชว์ใน list

| Command | Params | Description |
|---------|--------|-------------|
| `/bot-join` | `[bot] [channel]` | สั่ง bot เข้า voice channel |
| `/bot-leave` | `[bot]` | สั่ง bot ออก + save transcript |
| `/bot-mute` | `[bot]` | ปิด mic (ฟังอย่างเดียว) |
| `/bot-unmute` | `[bot]` | เปิด mic + TTS reply |
| `/bot-status` | `[bot?]` | ดูสถานะ bot (ไม่ใส่ = ทุกตัว) |
| `/bot-follow` | `[bot] [user]` | bot ตามคนไปทุกห้อง |
| `/bot-unfollow` | `[bot]` | หยุดตาม |
| `/bot-say` | `[bot] [text]` | สั่ง bot พูดข้อความ (TTS) |
| `/bot-think` | `[bot] [message]` | ส่งข้อความเข้า Claude → TTS ตอบ |

### 3.2 Autocomplete Behavior

**Bot param:**
- ดึงจาก server registry — เฉพาะ online ใน guild นี้
- แสดง: `codey 🟢 #general` (ชื่อ + ห้องที่อยู่ ถ้ามี)

**Channel param:**
- ดึง voice channels จาก guild real-time
- แสดง: `general` `meeting-room` `team-a`
- เฉพาะ voice channels, ไม่รวม text

**User param (for /bot-follow):**
- ดึง members ใน guild
- แสดงชื่อ display name

### 3.3 maw CLI Commands

| Command | Description |
|---------|-------------|
| `maw discord server` | Start server process (always running) |
| `maw discord wake [bot]` | Start bot (Claude + voice) + register |
| `maw discord sleep [bot]` | Stop bot + deregister |
| `maw discord status` | Fleet dashboard (ใครอยู่ไหน, follow ใคร) |
| `maw discord wake --all` | Start ทุกตัวที่ config ไว้ |
| `maw discord sleep --all` | Stop ทั้งหมด |

## 4. Follow Mode

### 4.1 Rules

- **1 bot : 1 คน** — bot ตามได้คนเดียว
- **1 คน : หลาย bot** — คนนึงมี bot ตามได้หลายตัว
- **Override = instant switch** — สั่ง follow คนใหม่ = ออกห้องเก่า เข้าห้องใหม่ทันที
- **Unfollow** — `/bot-unfollow` หรือคนที่ตาม offline

### 4.2 Scenarios

```
สถานะเริ่มต้น:
  nat อยู่ #voice-a
  bm  อยู่ #voice-b
  codey อยู่ #voice-a (ตาม nat)

Case 1: Override follow
  /bot-follow codey bm
  → codey leave #voice-a ทันที
  → codey join #voice-b ทันที
  → codey ตาม bm แล้ว

Case 2: Target ย้ายห้อง
  bm ย้ายจาก #voice-b → #voice-c
  → VoiceStateUpdate event
  → codey auto-leave #voice-b
  → codey auto-join #voice-c

Case 3: Target disconnect
  bm ออกจาก voice ทั้งหมด
  → codey ยังอยู่ห้องเดิม (ไม่ follow ออก)
  → หรือ auto-leave ตาม config (เช่น alone timeout)

Case 4: หลาย bot ตามคนเดียว
  /bot-follow codey bm
  /bot-follow pulse bm
  → bm ย้ายห้อง = codey + pulse ย้ายตามพร้อมกัน
```

### 4.3 State

```typescript
// Server เก็บ follow state
interface FollowState {
  botId: string;          // "codey"
  targetUserId: string;   // Discord user ID
  guildId: string;
}

// 1 bot มีได้แค่ 1 follow entry
// override = ลบอันเก่า ใส่อันใหม่
```

## 5. Pipelines

### 5.1 Voice Pipeline

```
เสียงจาก Discord
    ↓
Audio Pipeline (opus → PCM → WAV chunks)
    ↓ (silence detection, per-speaker)
STT (Typhoon ASR local / Groq fallback)
    ↓ (transcript text)
Trigger Detection (optional — "โคดี้ตอบหน่อย")
    ↓
Claude Code Session (brain — full tools, Oracle, memory)
    ↓ (reply text)
TTS (Edge TTS — Thai voices)
    ↓
Discord Voice (playback)
```

### 5.2 Text Pipeline

```
@mention ข้อความใน Discord text channel
    ↓
Access Control (pairing / allowlist check)
    ↓
Claude Code Session (same brain as voice)
    ↓ (reply text)
Discord Text Reply (auto-chunk if > 2000 chars)
```

### 5.3 Brain = Claude Code Session

- ไม่มี `brain.ts` แยก, ไม่มี `think-bridge.ts`
- **Claude Code session เป็นสมองเดียว** ทั้ง voice + text
- ท่าเดียวกับ claude-plugins-official (แต่เขียนเอง):
  - ข้อความเข้า → forward เข้า Claude session
  - Claude ตอบ → ส่งกลับ channel (voice หรือ text)
- Claude มี access เต็ม: tools, Oracle MCP, git, memory, files

**ข้อดี:**
- ฉลาดที่สุด — มี context ยาว, tools, memory
- text + voice consistent — สมองเดียวกัน
- ไม่ต้อง maintain Groq API key แยก

**ข้อจำกัด:**
- ช้ากว่า Groq (2-5s vs <1s) — ยอมรับได้สำหรับ voice reply
- 1 Claude session : 1 bot — 7 bots = 7 sessions

## 6. STT Strategy

### 6.1 Primary: Typhoon ASR (local)

- SCB 10X / OpenTyphoon
- Streaming support
- 15-19x faster than Whisper
- ไทยดีมาก (CER 0.098)
- 5-7 bots ต่อเครื่อง น่าจะไหว
- **ยังไม่ได้ลอง — ต้อง evaluate ก่อน**

### 6.2 Fallback: Groq Whisper (cloud)

- ใช้เมื่อ local ไม่ว่าง / ล่ม
- 2,000 req/day free (ไม่ต้องแชร์กับ LLM แล้วเพราะ brain เป็น Claude)
- ซื้อเพิ่มได้ ($0.04/hr)

### 6.3 Fallback: whisper.cpp (local)

- large-v3-turbo
- ใช้เมื่อ Typhoon + Groq ไม่ available
- ช้ากว่า Typhoon แต่ proven

### 6.4 Selection Logic

```
if typhoonASR.isAvailable():
    use typhoonASR          # fastest, best Thai
elif groqQuota.remaining():
    use groq                # cloud fallback
else:
    use whisperCpp          # last resort local
```

## 7. TTS Strategy

### 7.1 Primary: Edge TTS

- **ฟรีไม่จำกัด** ไม่ต้อง API key
- Thai voices: Niwat (male), Premwadee (female)
- Neural voice quality ใช้ได้ดี
- ไม่ติด rate limit — รองรับ 20 bots สบาย

### 7.2 Per-Bot Voice Config

- แต่ละ bot ตั้ง voice profile ได้
- codey อาจใช้ Premwadee, pulse ใช้ Niwat
- เปลี่ยนได้ runtime ไม่ต้อง restart

## 8. Access Control (จาก Discord Plugin Pattern)

### 8.1 Pairing System

- คนแปลกหน้า DM bot → ได้ code 6 ตัว
- Owner approve: `/bot-access pair <code>`
- ถึงจะคุยกับ bot ได้

### 8.2 Policies

| Policy | Behavior |
|--------|----------|
| `pairing` | Default — ต้อง pair ก่อน |
| `allowlist` | เฉพาะ user ที่ approve แล้ว |
| `disabled` | ปิด — ไม่รับข้อความจากใคร |
| `open` | เปิด — ทุกคนคุยได้ (สำหรับ public bots) |

### 8.3 Channel Opt-in

- Guild channels ปิด by default
- Opt-in per channel: ระบุ channel ID ที่ bot จะฟัง
- ตั้งได้ว่าต้อง @mention หรือไม่
- Regex trigger pattern ได้

### 8.4 Config Storage

```
~/.claude/channels/<bot-name>/
├── access.json        # pairing, allowlist, policies
├── channel-map.json   # channel name → ID mappings
└── .env               # bot-specific env (token, etc.)
```

## 9. Discord Tools (Claude ใช้ได้)

เหมือน claude-plugins-official แต่เขียนเอง:

| Tool | Description |
|------|-------------|
| `reply` | ส่งข้อความ + attachments (max 10 files, 25MB) |
| `react` | ใส่ emoji reaction |
| `edit_message` | แก้ข้อความของ bot |
| `fetch_messages` | ดึง history (max 100) |
| `download_attachment` | โหลดไฟล์จาก Discord |
| `voice_join` | เข้า voice channel |
| `voice_leave` | ออก voice channel |
| `voice_say` | พูดข้อความผ่าน TTS |

Tools เหล่านี้ Claude เรียกใช้เองได้ — เช่น Claude ตัดสินใจว่าจะ react, reply,
หรือพูดตอบกลับ ตาม context

## 10. Server-Bot Communication

### 10.1 Protocol

Server กับ Bot process คุยกันผ่าน **HTTP API** (lightweight):

```
Bot → Server:
  POST /register   { botName, guildIds, status: "online" }
  POST /deregister { botName }
  POST /heartbeat  { botName, currentChannel, followTarget }

Server → Bot:
  POST /command     { action: "join", channelId, channelName }
  POST /command     { action: "leave" }
  POST /command     { action: "follow", targetUserId }
  POST /command     { action: "mute" | "unmute" }
```

### 10.2 Health Check

- Bot ส่ง heartbeat ทุก 30s
- Server ไม่ได้ heartbeat 90s → mark offline
- Autocomplete ไม่โชว์ bot ที่ offline

## 11. Transcript & Handoff

### 11.1 Transcript

- ยังเก็บ transcript เหมือน v1
- Per-speaker, timestamped
- Auto-flush ทุก 15 นาที
- Save เป็น `.md` ไปที่ `ψ/transcripts/`

### 11.2 Handoff

- `/bot-leave` → save transcript + notify Claude session
- Claude session สรุป meeting notes ได้เลย (เพราะเป็น brain อยู่แล้ว)
- Copy ไป `~/Downloads/` สำหรับ human review

## 12. Auto Behaviors

| Behavior | Trigger | Action |
|----------|---------|--------|
| Auto-leave alone | ไม่มีคนในห้อง > 5 min | leave + save |
| Auto-leave silence | เงียบ > 15 min | leave + save |
| Auto-flush | ทุก 15 min | save snapshot |
| Stay mode | `/bot-stay [bot]` | ignore auto-leave (max 24h) |
| Follow auto-move | target ย้ายห้อง | leave + join ตาม |

## 13. Multi-Bot Scale

### 13.1 Per Machine

- 5-7 bots ต่อเครื่อง (Apple Silicon)
- STT เป็น bottleneck หลัก
- Typhoon ASR ควร handle 5-7 concurrent streams ได้

### 13.2 Resource Estimate (per bot)

| Resource | Usage |
|----------|-------|
| RAM | ~200-400 MB (Discord.js + audio buffers) |
| CPU | Low idle, spike on STT |
| Network | Discord voice stream ~64kbps per bot |
| Disk | Transcripts ~1MB/hour |

### 13.3 Multi-Machine (Future)

- maw federation รองรับอยู่แล้ว
- Server อยู่เครื่อง A, bot processes กระจายได้
- SSH relay / federation mesh

## 14. Clean Code (vs v1)

### 14.1 ลบออก

- ❌ `brain.ts` — ไม่ต้อง Groq LLM แยก (brain = Claude session)
- ❌ `think-bridge.ts` — ไม่ต้อง file IPC
- ❌ Alias commands 16 ตัว (cj, cl, cs, ...) — ใช้ `/bot-*` แทน
- ❌ `remote-control-poller.ts` — server HTTP แทน file polling
- ❌ `command-watcher.ts` (file IPC) — server HTTP แทน
- ❌ `dist/` — build artifacts ไม่ commit
- ❌ Yoi references ทั้งหมด

### 14.2 เขียนใหม่

- ✅ Commands → `/bot-*` with autocomplete
- ✅ Access control → pairing system (ท่า Discord plugin, เขียนเอง)
- ✅ Brain → Claude Code session (ผ่าน maw)
- ✅ Server → `maw discord server` (แยก process)
- ✅ Bot process → Claude session + voice bot รวม 1 process
- ✅ Follow mode → new feature
- ✅ Text + voice → combined ใน bot เดียว

### 14.3 เก็บไว้ (proven, ใช้ได้ดี)

- ✅ `audio-pipeline.ts` — opus → PCM → WAV chunks
- ✅ `voice-session.ts` — Discord voice connection management
- ✅ `transcript-writer.ts` — markdown transcript output
- ✅ `speak-state.ts` — mute/unmute logic
- ✅ `tts/edge.ts` — Edge TTS integration
- ✅ `stt/` — STT backends (เพิ่ม Typhoon ASR)
- ✅ `auto-shutdown.ts` — graceful shutdown
- ✅ `cost.ts` — token/cost tracking

## 15. File Structure (Proposed)

ทุกอย่างอยู่ใน **maw discord plugin**:

```
maw-js/src/plugins/discord/
├── plugin.json                    # Plugin metadata
├── index.ts                       # Plugin entry (CLI routing)
│
├── server/                        # maw discord server (แยก process)
│   ├── index.ts                   # Server entry point
│   ├── registry.ts                # Bot online/offline registry + heartbeat
│   ├── slash-commands.ts          # /bot-* command definitions
│   ├── autocomplete.ts            # Real-time bot + channel suggestions
│   ├── follow-manager.ts          # Follow state + VoiceStateUpdate
│   └── command-router.ts          # Forward commands → bot processes
│
├── bot/                           # Bot process (Claude + voice, 1 per bot)
│   ├── index.ts                   # Bot entry point
│   ├── discord-client.ts          # Discord login + event handlers
│   ├── claude-bridge.ts           # Forward messages ↔ Claude session
│   ├── register.ts                # Register/heartbeat กับ server
│   │
│   ├── voice/                     # Voice pipeline
│   │   ├── voice-session.ts       # Voice connection + recording (from v1)
│   │   ├── audio-pipeline.ts      # Opus → PCM → WAV (from v1)
│   │   ├── transcript-writer.ts   # Markdown output (from v1)
│   │   ├── speak-state.ts         # Mute/unmute logic (from v1)
│   │   └── trigger.ts             # Trigger phrase detection
│   │
│   ├── text/                      # Text pipeline
│   │   ├── message-handler.ts     # Inbound message → Claude
│   │   └── chunker.ts             # Auto-chunk long replies
│   │
│   └── tools/                     # Discord tools for Claude
│       ├── reply.ts               # Send text + attachments
│       ├── react.ts               # Emoji reaction
│       ├── edit-message.ts        # Edit bot message
│       ├── fetch-messages.ts      # Fetch channel history
│       ├── download-attachment.ts  # Download file
│       ├── voice-join.ts          # Join voice channel
│       ├── voice-leave.ts         # Leave voice channel
│       └── voice-say.ts           # TTS speak
│
├── access/                        # Access control (shared)
│   ├── pairing.ts                 # 6-char code pairing flow
│   ├── allowlist.ts               # User allowlist management
│   └── channel-policy.ts          # Per-channel opt-in + mention rules
│
├── stt/                           # STT backends (shared)
│   ├── index.ts                   # STT router (typhoon → groq → whisper)
│   ├── typhoon.ts                 # Typhoon ASR (primary)
│   ├── groq.ts                    # Groq Whisper (fallback)
│   └── whisper-cpp.ts             # whisper.cpp (last resort)
│
├── tts/                           # TTS backends (shared)
│   ├── index.ts                   # TTS router
│   └── edge.ts                    # Edge TTS (primary)
│
└── config/                        # Configuration
    ├── bots.json                  # Bot definitions
    └── types.ts                   # Shared types
```

## 16. Config Example

### 16.1 bots.json

```json
{
  "bots": [
    {
      "name": "codey",
      "tokenRef": "discord/codey",
      "voiceProfile": "premwadee",
      "systemPrompt": "You are โคดี้ (Codey), AI secretary...",
      "autoJoinOnWake": false
    },
    {
      "name": "pulse",
      "tokenRef": "discord/pulse",
      "voiceProfile": "niwat",
      "systemPrompt": "You are Pulse, DevOps oracle...",
      "autoJoinOnWake": false
    }
  ]
}
```

### 16.2 access.json (per bot)

```json
{
  "policy": "pairing",
  "allowedUsers": ["184695080709324800"],
  "pendingPairs": {},
  "guilds": {
    "1490507414682865674": {
      "channels": {
        "1500510701519634546": {
          "enabled": true,
          "requireMention": true
        }
      }
    }
  }
}
```

## 17. Migration Path

1. **Phase 0**: ลอง Typhoon ASR ดูว่า Thai quality + performance จริงเป็นยังไง
2. **Phase 1**: `maw discord server` — server process + bot registry + slash commands
3. **Phase 2**: Bot process — Claude session + Discord client + register กับ server
4. **Phase 3**: Voice pipeline — STT/TTS + audio pipeline (port จาก v1)
5. **Phase 4**: Text pipeline — message handler + Claude bridge
6. **Phase 5**: Follow mode + access control (pairing)
7. **Phase 6**: Discord tools (reply, react, edit, fetch)
8. **Phase 7**: `maw discord wake/sleep` integration
9. **Phase 8**: Multi-bot testing (5-7 bots พร้อมกัน)

codey v1 ยังรันได้ปกติระหว่าง migrate — ไม่แตะ

## 18. Open Questions

- [ ] Typhoon ASR ลองแล้วจริงๆ ไทยดีแค่ไหน? streaming ใช้ได้จริงไหม?
- [ ] Claude session latency ยอมรับได้สำหรับ voice reply? (2-5s)
- [ ] Bot tokens — สร้างใหม่ 7 ตัวใน Discord Developer Portal?
- [ ] Server deploy ที่ไหน — local Mac, VPS (Hetzner), หรือ oracle-world?
- [ ] Transcript format เปลี่ยนไหม? หรือใช้ v1 format เดิม?
- [ ] Cost tracking — รวมค่า Claude API ด้วยไหม?
- [ ] `maw discord server` start ยังไง — pm2, systemd, หรือ tmux?
- [ ] Bot process crash → auto-restart? หรือต้อง wake ใหม่?
