# Claude Channel Voice Bot v2

Discord voice bots for Claude Code oracles. A bot joins voice, transcribes
speakers, writes Markdown transcripts, publishes optional MQTT segments, and
routes explicit trigger requests to a Claude brain running in the oracle repo.

The v2 path is designed for zero per-run environment variables. Put bot config
in `~/.maw/discord.json`, store Discord tokens in `pass`, then use `maw discord
server` and `maw discord wake`.

## Prerequisites

Install these once on the host that runs the Discord bots.

### macOS

```bash
brew install ghq pass gnupg tmux ffmpeg mosquitto
curl -fsSL https://bun.sh/install | bash
pipx install edge-tts
bun install -g maw-js
npm install -g @anthropic-ai/claude-code pm2
```

### Linux

```bash
curl -fsSL https://bun.sh/install | bash
sudo apt-get update
sudo apt-get install -y git pass gnupg tmux ffmpeg mosquitto-clients python3-pip pipx
go install github.com/x-motemen/ghq@latest
pipx install edge-tts
bun install -g maw-js
npm install -g @anthropic-ai/claude-code pm2
```

Required tools:

- `bun`: runs `maw-js` and `voice-bot`.
- `ghq`: keeps repos in predictable paths.
- `pass` + `gpg`: stores Discord bot tokens.
- `tmux`: used by `maw` and optional Claude channel bridging.
- `ffmpeg`: converts captured audio for STT.
- `edge-tts`: free Thai TTS voice output.
- `maw-js`: Discord fleet CLI and slash-command server.
- `claude`: Claude Code CLI for oracle brain replies.
- `pm2`: optional process manager.
- `mosquitto`: optional MQTT client tooling for debugging.

## Quick Start

### 1. Clone repos

```bash
ghq get github.com/Soul-Brews-Studio/voice-bot
ghq get github.com/Soul-Brews-Studio/maw-js
cd "$(ghq list -p github.com/Soul-Brews-Studio/voice-bot)"
bun install
```

### 2. Symlink the Discord plugin during local development

If `maw-js` is installed globally from npm, skip this. For local development,
make sure your shell runs the local checkout:

```bash
cd "$(ghq list -p github.com/Soul-Brews-Studio/maw-js)"
bun install
bun link
bun link maw-js
```

Check:

```bash
maw discord version
```

### 3. Create Discord applications

In the Discord Developer Portal:

1. Create an application per bot.
2. Add a bot user.
3. Enable these bot intents:
   - Server Members Intent
   - Message Content Intent
   - Presence Intent is optional.
4. Copy the bot token once.
5. Copy the application ID.
6. Invite the bot to your Discord server with bot and application command
   scopes.

Minimum bot permissions:

- View Channels
- Send Messages
- Read Message History
- Add Reactions
- Connect
- Speak
- Use Voice Activity

### 4. Store Discord tokens in pass

Initialize `pass` first if needed:

```bash
gpg --full-generate-key
pass init "<your gpg key id or email>"
```

Store each bot token:

```bash
pass insert discord/<bot-name>
```

Examples:

```bash
pass insert discord/codey-oracle
pass insert discord/uno-oracle
pass insert discord/due-oracle
```

### 5. Create `~/.maw/discord.json`

```bash
mkdir -p ~/.maw
chmod 700 ~/.maw
$EDITOR ~/.maw/discord.json
chmod 600 ~/.maw/discord.json
```

Template:

```json
{
  "discord": {
    "bots": {
      "codey": {
        "appId": "DISCORD_APPLICATION_ID",
        "tokenName": "codey-oracle"
      },
      "uno-oracle": {
        "appId": "DISCORD_APPLICATION_ID"
      },
      "due-oracle": {}
    },
    "defaults": {
      "ownerIds": "YOUR_DISCORD_USER_ID",
      "typhoonApiKey": "TYPHOON_API_KEY",
      "groqApiKey": "GROQ_API_KEY",
      "mqttUrl": "mqtt://localhost:1883",
      "mqttUser": "optional",
      "mqttPass": "optional",
      "claudeModel": "sonnet",
      "voiceProfile": "premwadee"
    }
  }
}
```

Notes:

- `tokenName` maps to `pass show discord/<tokenName>`.
- If `tokenName` is omitted, the bot name is used.
- `appId` is required for the slash-command gateway bot.
- Defaults are passed automatically by `maw discord wake`.

### 6. Get API keys

Recommended:

- Typhoon ASR: https://opentyphoon.ai
- Groq fallback STT: https://console.groq.com

Put the keys in `~/.maw/discord.json`. You do not need to export them.

### 7. Start the Discord slash-command server

```bash
maw discord server codey
```

This starts the HTTP registry and Discord gateway. Slash commands are registered
from the application ID configured for `codey`.

If no bot name is provided, the first bot in `~/.maw/discord.json` is used:

```bash
maw discord server
```

### 8. Wake a voice bot

```bash
maw discord wake uno-oracle
```

`maw` resolves:

- Discord token from `pass`.
- API keys and defaults from `~/.maw/discord.json`.
- `ORACLE_REPO` from `ghq`, when a matching oracle repo exists.
- Voice bot source from the `voice-bot` ghq checkout.

Then use Discord slash commands:

```text
/bot-join
/bot-unmute
/bot-say
/bot-follow
/bot-leave
```

## Commands Reference

### `maw discord server [bot]`

Starts the registry and slash-command gateway.

Useful flags:

```bash
maw discord server codey --port 7799
maw discord server codey --token codey-oracle
maw discord server --no-register
maw discord server --no-discord
```

### `maw discord wake <bot>`

Starts one bot process.

```bash
maw discord wake uno-oracle
maw discord wake due-oracle --voice-profile premwadee
maw discord wake --all
```

### `maw discord sleep <bot>`

Stops one bot process gracefully.

```bash
maw discord sleep uno-oracle
maw discord sleep --all
```

### `maw discord status`

Shows server registry state.

```bash
maw discord status
maw discord status uno-oracle
maw discord status --json
```

### Discord slash commands

- `/bot-join`: join a voice channel.
- `/bot-leave`: leave voice and flush transcript.
- `/bot-mute`: disable unsolicited TTS.
- `/bot-unmute`: enable TTS.
- `/bot-status`: show bot state.
- `/bot-follow`: follow a user between voice channels.
- `/bot-unfollow`: stop following.
- `/bot-say`: speak text in the current voice channel.
- `/bot-think`: ask Claude and return a text reply.

## Transcript Storage

Transcript files are resolved per bot:

1. `TRANSCRIPT_DIR`, if set.
2. `ORACLE_REPO/ψ/transcripts` when an oracle repo is active and has `ψ`.
3. A matching ghq oracle repo with `ψ/transcripts`.
4. `~/.claude/channels/<bot>/transcripts`.

Filenames include the bot name:

```text
YYYY-MM-DD_HHMM_<bot>_<channel>.md
YYYY-MM-DD_HHMM_<bot>_<channel>.session.json
```

The session JSON links a voice round to the Claude session ID.

## Architecture

```text
Discord client
    |
    | slash commands
    v
maw discord server
    |  registry, autocomplete, follow state
    |  POST /command
    v
voice-bot process
    |
    +-- voice session
    |      Discord opus -> PCM -> WAV chunks
    |      WAV -> Typhoon/Groq/whisper-cpp STT
    |      transcript segment -> Markdown + optional MQTT
    |
    +-- trigger detector
    |      bot name / custom phrases / "ตอบหน่อย"
    |
    +-- Claude bridge
    |      claude-p mode or maw-hey file IPC
    |
    +-- TTS
           Edge TTS WAV -> Discord voice playback
```

## Troubleshooting

### `maw discord server` starts without slash commands

Check that the selected bot has an `appId`:

```bash
jq '.discord.bots' ~/.maw/discord.json
```

Then restart:

```bash
maw discord server codey
```

### Bot does not wake

Check token storage:

```bash
pass show discord/<bot-name>
maw discord tokens check <bot-name>
```

Check repo resolution:

```bash
ghq list -p | grep voice-bot
ghq list -p | grep <bot-name>
```

### No transcription

Check dependencies:

```bash
ffmpeg -version
bun run typecheck
```

Check STT keys in `~/.maw/discord.json`. Typhoon is preferred when present,
Groq is fallback, and whisper-cpp is local fallback.

### Trigger detected but no voice reply

Explicit trigger replies should work even when the bot is muted. If the bot is
silent, check:

```bash
edge-tts --list-voices | grep th-TH
maw discord wake <bot> --voice-profile premwadee
```

### Claude replies lose context

Make sure the bot has an oracle repo:

```bash
ghq list -p | grep <bot-name>
```

`maw discord wake` passes `ORACLE_REPO` automatically when it finds a matching
repo. Claude then runs in that repo and can see `CLAUDE.md`, skills, memory, and
transcripts.

### MQTT does not publish

MQTT is disabled unless `mqttUrl` is set in `~/.maw/discord.json`. Test with:

```bash
mosquitto_sub -h mqtt.example.com -t 'sbs/acc3'
```

## Development

```bash
bun install
bun run typecheck
bun src/index.ts
```

The bot process expects `maw discord wake` in normal use. Direct `bun
src/index.ts` runs still work if you export the needed environment variables
manually.

## License

MIT
