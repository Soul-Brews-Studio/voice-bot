#!/usr/bin/env bash
set -euo pipefail

VOICE_BOT_REPO="github.com/Soul-Brews-Studio/voice-bot"
MAW_JS_REPO="github.com/Soul-Brews-Studio/maw-js"
GHQ_ROOT="${GHQ_ROOT:-$HOME/ghq}"
DISCORD_CONFIG="$HOME/.maw/discord.json"

log() {
  printf '%s\n' "$*"
}

have() {
  command -v "$1" >/dev/null 2>&1
}

run_if_missing() {
  local bin="$1"
  shift
  if have "$bin"; then
    log "ok: $bin"
  else
    log "install: $*"
    "$@"
  fi
}

install_bun() {
  if have bun; then
    log "ok: bun"
    return
  fi
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
}

install_macos() {
  if ! have brew; then
    log "Homebrew is required on macOS: https://brew.sh"
    exit 1
  fi
  brew install ghq pass gnupg tmux ffmpeg mosquitto pipx
}

install_linux() {
  if have apt-get; then
    sudo apt-get update
    sudo apt-get install -y git curl pass gnupg tmux ffmpeg mosquitto-clients python3-pip pipx
  else
    log "Install these packages with your distro package manager: git curl pass gnupg tmux ffmpeg mosquitto-clients python3-pip pipx"
  fi

  if ! have ghq; then
    if have go; then
      go install github.com/x-motemen/ghq@latest
      export PATH="$HOME/go/bin:$PATH"
    else
      log "ghq is missing. Install Go, then run: go install github.com/x-motemen/ghq@latest"
      exit 1
    fi
  fi
}

install_prerequisites() {
  install_bun
  case "$(uname -s)" in
    Darwin) install_macos ;;
    Linux) install_linux ;;
    *)
      log "Unsupported OS: $(uname -s)"
      exit 1
      ;;
  esac

  run_if_missing edge-tts pipx install edge-tts
  run_if_missing claude npm install -g @anthropic-ai/claude-code
  run_if_missing pm2 npm install -g pm2
  run_if_missing maw bun install -g maw-js
}

repo_path() {
  local repo="$1"
  if have ghq; then
    ghq list -p "$repo" 2>/dev/null | head -1
  else
    printf '%s/%s\n' "$GHQ_ROOT" "$repo"
  fi
}

clone_repo() {
  local repo="$1"
  local path
  path="$(repo_path "$repo")"
  if [[ -n "$path" && -d "$path/.git" ]]; then
    log "ok: $repo at $path"
    return
  fi

  if have ghq; then
    ghq get "$repo"
  else
    path="$GHQ_ROOT/$repo"
    mkdir -p "$(dirname "$path")"
    git clone "https://$repo.git" "$path"
  fi
}

install_repos() {
  clone_repo "$VOICE_BOT_REPO"
  clone_repo "$MAW_JS_REPO"

  local voice_bot
  local maw_js
  voice_bot="$(repo_path "$VOICE_BOT_REPO")"
  maw_js="$(repo_path "$MAW_JS_REPO")"

  log "install deps: $voice_bot"
  (cd "$voice_bot" && bun install)

  log "install deps: $maw_js"
  (cd "$maw_js" && bun install)

  log "link local maw-js"
  (cd "$maw_js" && bun link)
}

create_config_template() {
  if [[ -f "$DISCORD_CONFIG" ]]; then
    log "ok: $DISCORD_CONFIG already exists"
    return
  fi

  install -d -m 700 "$HOME/.maw"
  umask 077
  cat > "$DISCORD_CONFIG" <<'JSON'
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
      "mqttUser": "",
      "mqttPass": "",
      "claudeModel": "sonnet",
      "voiceProfile": "premwadee"
    }
  }
}
JSON
  chmod 600 "$DISCORD_CONFIG"
  log "created: $DISCORD_CONFIG"
}

print_next_steps() {
  cat <<'TEXT'

Next steps:
1. Create Discord applications and bot tokens in the Discord Developer Portal.
2. Store each token: pass insert discord/<bot-name>
3. Edit ~/.maw/discord.json with app IDs, owner IDs, and API keys.
4. Start the gateway: maw discord server codey
5. Wake a bot: maw discord wake <bot>

Useful checks:
  maw discord tokens check
  maw discord status
  bun run typecheck
TEXT
}

main() {
  install_prerequisites
  install_repos
  create_config_template
  print_next_steps
}

main "$@"
