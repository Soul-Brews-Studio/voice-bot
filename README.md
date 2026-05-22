# Codey Voice Bot

> Discord voice channel transcriber + AI secretary

Codey joins your Discord voice channel, transcribes everything everyone says in real-time, and can respond with AI-generated answers via text-to-speech.

## Features

- **Real-time transcription** — per-speaker, timestamped
- **AI replies** — say "Codey answer" and get a spoken response
- **Multiple TTS voices** — macOS Kanya, Edge TTS (Niwat/Premwadee), Google Chirp
- **Transcript export** — Markdown files with speaker names + timestamps
- **Raw audio recording** — full session WAV saved on leave
- **Auto-leave** — exits when alone (5min) or silent (15min)
- **Cost tracking** — per-session STT/TTS/LLM cost breakdown
- **Web UI** — live transcript view at localhost:8080

## Stack

| Component | Tool | Cost |
|-----------|------|------|
| Runtime | Bun + TypeScript | Free |
| STT | Groq Whisper Large V3 | Free tier |
| Brain | Groq Llama 3.3 70B | Free tier |
| TTS | macOS say / Edge TTS | Free |
| TTS Premium | Google Chirp3-HD | ~$30/1M chars |

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) v1.0+
- macOS (for mac-say TTS) or Linux
- A Discord bot token ([create one](https://discord.com/developers/applications))
- A Groq API key ([get one free](https://console.groq.com))

### Setup

```bash
git clone https://github.com/Soul-Brews-Studio/voice-bot.git
cd voice-bot
bun install
cp .env.example .env
# Edit .env with your tokens
```

### Run

```bash
bun src/index.ts
```

### Register Discord Commands

```bash
bun src/register-commands.ts
```

## Commands

| Command | Description |
|---------|-------------|
| `/codey join` | Join your voice channel |
| `/codey leave` | Leave + save transcript + audio |
| `/codey save` | Snapshot transcript mid-session |
| `/codey note <text>` | Add manual note to transcript |
| `/codey speak-on` | Enable AI voice replies |
| `/codey speak-off` | Mute, listen only |
| `/codey say <text>` | Speak text via TTS |
| `/codey think <msg>` | Deep AI reply |
| `/codey voice <name>` | Switch voice profile |
| `/codey trigger <action>` | Manage trigger permissions |
| `/codey stay [hours]` | Stay in channel (max 24h) |
| `/codey status` | Show session info + cost |

## Voice Profiles

| Command | Voice | Type |
|---------|-------|------|
| `/codey voice kanya-compact` | Kanya | macOS Thai (free) |
| `/codey voice niwat` | Niwat | Edge TTS male (free) |
| `/codey voice premwadee` | Premwadee | Edge TTS female (free) |
| `/codey voice leda` | Leda | Google Chirp (paid) |

## Output

After `/codey leave`, you get:
- **Transcript** (.md) — timestamped, per-speaker
- **Raw audio** (.wav) — full session recording
- Both saved to `~/Downloads/codey-discord-voice/`

## Configuration

See `.env.example` for all options.

## License

MIT
