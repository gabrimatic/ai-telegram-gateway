#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$ROOT_DIR/.env"
ENV_TEMPLATE="$ROOT_DIR/.env.example"
GATEWAY_CONFIG="$ROOT_DIR/config/gateway.json"
APP_NAME="${TG_PM2_APP_NAME:-telegram-gateway}"

NON_INTERACTIVE="${SETUP_NONINTERACTIVE:-0}"
ALLOW_EMPTY_ADMIN_ID=0
SKIP_PM2_START=0

usage() {
  cat <<'USAGE'
Usage: ./setup.sh [options]

Options:
  --non-interactive   Run without prompts (requires env vars for required values)
  --allow-pairing     Do not require admin Telegram ID during setup
  --no-pm2-start      Complete setup but do not start/restart PM2 app
  -h, --help          Show this help

Required inputs:
  TELEGRAM_BOT_TOKEN  Bot token from BotFather

Optional non-interactive inputs:
  SETUP_ADMIN_TELEGRAM_ID  Admin Telegram user ID (numeric)
  OPENAI_API_KEY           Needed only for TTS
  SETUP_AI_PROVIDER        claude-cli or codex-cli
USAGE
}

log() {
  printf '[setup] %s\n' "$*"
}

warn() {
  printf '[setup][warn] %s\n' "$*" >&2
}

fail() {
  printf '[setup][error] %s\n' "$*" >&2
  exit 1
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

expand_home_path() {
  local value="$1"
  if [[ "$value" == "~" ]]; then
    printf '%s' "$HOME"
    return
  fi
  if [[ "$value" == ~/* ]]; then
    printf '%s' "${HOME}${value:1}"
    return
  fi
  printf '%s' "$value"
}

parse_bool() {
  local value="${1:-}"
  case "${value,,}" in
    1|true|yes|on) echo "true" ;;
    0|false|no|off) echo "false" ;;
    *) echo "" ;;
  esac
}

prompt_value() {
  local __target="$1"
  local prompt_text="$2"
  local required="$3"
  local default_value="${4:-}"
  local secret="${5:-0}"
  local current_value="${!__target:-}"

  if [[ -n "$current_value" ]]; then
    return
  fi

  if [[ "$NON_INTERACTIVE" == "1" ]]; then
    if [[ "$required" == "1" && -z "$default_value" ]]; then
      fail "Missing required value for ${__target} in non-interactive mode."
    fi
    printf -v "$__target" '%s' "$default_value"
    return
  fi

  local input=""
  while true; do
    if [[ "$secret" == "1" ]]; then
      if [[ -n "$default_value" ]]; then
        read -r -s -p "$prompt_text [$default_value]: " input
      else
        read -r -s -p "$prompt_text: " input
      fi
      printf '\n'
    else
      if [[ -n "$default_value" ]]; then
        read -r -p "$prompt_text [$default_value]: " input
      else
        read -r -p "$prompt_text: " input
      fi
    fi

    if [[ -z "$input" ]]; then
      input="$default_value"
    fi

    if [[ "$required" == "1" && -z "$input" ]]; then
      warn "This value is required."
      continue
    fi

    printf -v "$__target" '%s' "$input"
    return
  done
}

prompt_yes_no() {
  local __target="$1"
  local prompt_text="$2"
  local default_bool="$3" # true|false
  local current_value="${!__target:-}"
  local normalized_current
  normalized_current="$(parse_bool "$current_value")"

  if [[ -n "$normalized_current" ]]; then
    printf -v "$__target" '%s' "$normalized_current"
    return
  fi

  if [[ "$NON_INTERACTIVE" == "1" ]]; then
    printf -v "$__target" '%s' "$default_bool"
    return
  fi

  local default_hint="y/N"
  if [[ "$default_bool" == "true" ]]; then
    default_hint="Y/n"
  fi

  local input=""
  while true; do
    read -r -p "$prompt_text [$default_hint]: " input
    input="${input,,}"
    if [[ -z "$input" ]]; then
      printf -v "$__target" '%s' "$default_bool"
      return
    fi
    case "$input" in
      y|yes) printf -v "$__target" '%s' "true"; return ;;
      n|no) printf -v "$__target" '%s' "false"; return ;;
      *) warn "Please answer yes or no." ;;
    esac
  done
}

load_existing_env() {
  if [[ -f "$ENV_FILE" ]]; then
    log "Loading existing .env values"
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
  fi
}

escape_env_value() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

set_env_key() {
  local key="$1"
  local value="$2"
  local escaped
  local quoted
  escaped="$(escape_env_value "$value")"
  quoted="\"$escaped\""

  touch "$ENV_FILE"
  chmod 600 "$ENV_FILE"

  if grep -qE "^${key}=" "$ENV_FILE"; then
    local tmp_file
    tmp_file="$(mktemp)"
    awk -v key="$key" -v val="$quoted" '
      BEGIN { updated = 0 }
      $0 ~ ("^" key "=") {
        if (!updated) {
          print key "=" val
          updated = 1
        }
        next
      }
      { print }
      END {
        if (!updated) {
          print key "=" val
        }
      }
    ' "$ENV_FILE" > "$tmp_file"
    mv "$tmp_file" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$quoted" >> "$ENV_FILE"
  fi
}

unset_env_key() {
  local key="$1"
  if [[ ! -f "$ENV_FILE" ]]; then
    return
  fi
  local tmp_file
  tmp_file="$(mktemp)"
  awk -v key="$key" '$0 !~ ("^" key "=")' "$ENV_FILE" > "$tmp_file"
  mv "$tmp_file" "$ENV_FILE"
}

require_macos() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    fail "This setup script currently supports macOS only."
  fi
}

load_brew_shellenv() {
  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
}

ensure_homebrew() {
  if command_exists brew; then
    return
  fi

  if ! command_exists curl; then
    fail "curl is required to install Homebrew."
  fi

  log "Installing Homebrew"
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  load_brew_shellenv

  if ! command_exists brew; then
    fail "Homebrew installation failed."
  fi
}

ensure_brew_formula() {
  local formula="$1"
  if brew list --formula "$formula" >/dev/null 2>&1; then
    log "Homebrew formula already installed: $formula"
  else
    log "Installing Homebrew formula: $formula"
    brew install "$formula"
  fi
}

node_major_version() {
  node -v | sed -E 's/^v([0-9]+).*/\1/'
}

ensure_node_and_npm() {
  local major=""
  if command_exists node; then
    major="$(node_major_version || true)"
  fi

  if [[ -z "$major" || "$major" -lt 18 ]]; then
    log "Installing Node.js 20 via Homebrew"
    ensure_brew_formula "node@20"
    local node20_bin
    node20_bin="$(brew --prefix node@20)/bin"
    export PATH="$node20_bin:$PATH"
    hash -r
  fi

  if ! command_exists node; then
    fail "Node.js is still not available after installation."
  fi

  major="$(node_major_version)"
  if [[ "$major" -lt 18 ]]; then
    fail "Node.js >= 18 is required. Found: $(node -v)"
  fi

  if ! command_exists npm; then
    fail "npm is required but not available."
  fi

  log "Using Node.js $(node -v)"
  log "Using npm $(npm -v)"
}

ensure_pm2() {
  if command_exists pm2; then
    log "PM2 already installed"
    return
  fi

  log "Installing PM2 globally"
  npm install -g pm2
  hash -r

  if ! command_exists pm2; then
    fail "PM2 installation failed."
  fi
}

ensure_voice_dependencies() {
  ensure_brew_formula "ffmpeg"
  if brew list --formula whisperkit-cli >/dev/null 2>&1; then
    log "WhisperKit CLI already installed"
    return
  fi

  log "Installing WhisperKit CLI"
  if ! brew install whisperkit-cli; then
    warn "Could not install whisperkit-cli automatically. Voice transcription will be unavailable until it is installed."
  fi
}

detect_provider_binaries() {
  CLAUDE_PATH=""
  CODEX_PATH=""
  if command_exists claude; then
    CLAUDE_PATH="$(command -v claude)"
  fi
  if command_exists codex; then
    CODEX_PATH="$(command -v codex)"
  fi
}

ensure_ai_cli() {
  detect_provider_binaries
  if [[ -n "$CLAUDE_PATH" || -n "$CODEX_PATH" ]]; then
    return
  fi

  log "No AI CLI detected, installing Claude CLI"
  npm install -g @anthropic-ai/claude-code
  detect_provider_binaries

  if [[ -z "$CLAUDE_PATH" && -z "$CODEX_PATH" ]]; then
    fail "No supported AI CLI is available after installation attempt."
  fi
}

choose_provider() {
  local requested="${SETUP_AI_PROVIDER:-}"

  if [[ -n "$requested" ]]; then
    case "$requested" in
      claude-cli|codex-cli) SELECTED_PROVIDER="$requested" ;;
      *) fail "SETUP_AI_PROVIDER must be claude-cli or codex-cli." ;;
    esac
  fi

  if [[ -z "${SELECTED_PROVIDER:-}" ]]; then
    if [[ -n "$CLAUDE_PATH" && -n "$CODEX_PATH" ]]; then
      if [[ "$NON_INTERACTIVE" == "1" ]]; then
        SELECTED_PROVIDER="claude-cli"
      else
        local pick=""
        prompt_value pick "Select AI provider (claude-cli or codex-cli)" 1 "claude-cli" 0
        case "$pick" in
          claude-cli|codex-cli) SELECTED_PROVIDER="$pick" ;;
          *) fail "Invalid provider choice: $pick" ;;
        esac
      fi
    elif [[ -n "$CLAUDE_PATH" ]]; then
      SELECTED_PROVIDER="claude-cli"
    elif [[ -n "$CODEX_PATH" ]]; then
      SELECTED_PROVIDER="codex-cli"
    else
      fail "No AI provider binary detected."
    fi
  fi

  if [[ "$SELECTED_PROVIDER" == "claude-cli" && -z "$CLAUDE_PATH" ]]; then
    fail "claude-cli selected but Claude binary is not available."
  fi
  if [[ "$SELECTED_PROVIDER" == "codex-cli" && -z "$CODEX_PATH" ]]; then
    fail "codex-cli selected but Codex binary is not available."
  fi
}

write_gateway_provider_config() {
  if [[ ! -f "$GATEWAY_CONFIG" ]]; then
    fail "Missing config file: $GATEWAY_CONFIG"
  fi

  local selected="$1"
  node - "$GATEWAY_CONFIG" "$selected" <<'NODE'
const fs = require("fs");
const configPath = process.argv[2];
const selected = process.argv[3];
const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));

if (!cfg.security || typeof cfg.security !== "object") {
  cfg.security = {};
}
if (cfg.security.commandWarningsEnabled === undefined) {
  cfg.security.commandWarningsEnabled = true;
}
if (cfg.security.argValidationMode !== "strict" && cfg.security.argValidationMode !== "moderate") {
  cfg.security.argValidationMode = "moderate";
}

if (selected === "codex-cli") {
  cfg.aiProvider = "codex-cli";
  cfg.providerDisplayName = "Codex";
  cfg.defaultModel = "codex";
} else {
  cfg.aiProvider = "claude-cli";
  cfg.providerDisplayName = "Claude";
  if (!cfg.defaultModel || cfg.defaultModel === "codex") {
    cfg.defaultModel = "opus";
  }
}

fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n");
NODE
}

prepare_env_file() {
  if [[ ! -f "$ENV_FILE" && -f "$ENV_TEMPLATE" ]]; then
    cp "$ENV_TEMPLATE" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    log "Created .env from .env.example"
  fi

  set_env_key "TELEGRAM_BOT_TOKEN" "$BOT_TOKEN"
  set_env_key "TG_PM2_APP_NAME" "$APP_NAME"
  set_env_key "TG_PROJECT_PATH_HINT" "$ROOT_DIR"
  set_env_key "TG_HOST_LABEL" "host machine"
  set_env_key "TG_ENABLE_DANGEROUS_COMMANDS" "$ENABLE_DANGEROUS_COMMANDS"

  if [[ -n "$OPENAI_KEY" ]]; then
    set_env_key "OPENAI_API_KEY" "$OPENAI_KEY"
  else
    unset_env_key "OPENAI_API_KEY"
  fi

  if [[ -n "$CLAUDE_PATH" ]]; then
    set_env_key "CLAUDE_BIN" "$CLAUDE_PATH"
  fi
  if [[ -n "$CODEX_PATH" ]]; then
    set_env_key "CODEX_BIN" "$CODEX_PATH"
  fi
}

init_storage_files() {
  local data_dir="${TG_DATA_DIR:-$HOME/.claude}"
  local log_dir="${TG_LOG_DIR:-$HOME/.claude/logs/telegram-gateway}"
  data_dir="$(expand_home_path "$data_dir")"
  log_dir="$(expand_home_path "$log_dir")"
  local gateway_dir="$data_dir/gateway"
  local allowlist_path="${TG_ALLOWLIST_FILE:-$data_dir/telegram-allowlist.json}"
  allowlist_path="$(expand_home_path "$allowlist_path")"

  mkdir -p "$data_dir" "$gateway_dir" "$log_dir" "$ROOT_DIR/voices"

  export SETUP_ALLOWLIST_PATH="$allowlist_path"
  export SETUP_ADMIN_ID="$ADMIN_TELEGRAM_ID"
  export SETUP_ALLOW_EMPTY_ADMIN_ID="$ALLOW_EMPTY_ADMIN_ID"

  node <<'NODE'
const fs = require("fs");
const path = require("path");

function generateCode() {
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

const allowlistPath = process.env.SETUP_ALLOWLIST_PATH;
const adminId = (process.env.SETUP_ADMIN_ID || "").trim();
const allowEmpty = process.env.SETUP_ALLOW_EMPTY_ADMIN_ID === "1";

const dir = path.dirname(allowlistPath);
fs.mkdirSync(dir, { recursive: true });

let allowlist = {
  allowedUsers: [],
  pairingEnabled: true,
  pairingCode: generateCode(),
};

if (fs.existsSync(allowlistPath)) {
  try {
    allowlist = JSON.parse(fs.readFileSync(allowlistPath, "utf8"));
  } catch {
    // Replace invalid file with a valid default.
  }
}

if (!Array.isArray(allowlist.allowedUsers)) {
  allowlist.allowedUsers = [];
}

if (typeof allowlist.pairingEnabled !== "boolean") {
  allowlist.pairingEnabled = true;
}
if (typeof allowlist.pairingCode !== "string" || allowlist.pairingCode.length === 0) {
  allowlist.pairingCode = generateCode();
}

if (adminId) {
  allowlist.allowedUsers = allowlist.allowedUsers.filter((id) => id !== adminId);
  allowlist.allowedUsers.unshift(adminId);
}

if (!adminId && !allowEmpty && allowlist.allowedUsers.length === 0) {
  console.error("No admin user ID is configured and allowlist is empty.");
  process.exit(1);
}

fs.writeFileSync(allowlistPath, JSON.stringify(allowlist, null, 2) + "\n");
NODE
}

validate_required_inputs() {
  if [[ ! "$BOT_TOKEN" =~ ^[0-9]{8,}:[A-Za-z0-9_-]{20,}$ ]]; then
    fail "TELEGRAM_BOT_TOKEN format looks invalid."
  fi

  if [[ -n "$ADMIN_TELEGRAM_ID" && ! "$ADMIN_TELEGRAM_ID" =~ ^[0-9]+$ ]]; then
    fail "Admin Telegram ID must be numeric."
  fi
}

install_project_dependencies() {
  cd "$ROOT_DIR"
  if [[ -f "$ROOT_DIR/package-lock.json" ]]; then
    log "Installing npm dependencies with npm ci"
    npm ci
  else
    log "Installing npm dependencies with npm install"
    npm install
  fi
}

run_quality_checks() {
  cd "$ROOT_DIR"
  log "Running typecheck"
  npm run typecheck
  log "Building project"
  npm run build
  log "Running smoke check"
  npm run smoke
}

start_pm2_app() {
  if [[ "$SKIP_PM2_START" == "1" ]]; then
    log "Skipping PM2 start because --no-pm2-start was used"
    return
  fi

  cd "$ROOT_DIR"
  log "Starting or restarting PM2 app"
  npm run pm2:start

  if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
    pm2 save >/dev/null 2>&1 || warn "pm2 save failed. PM2 may not auto-restore after reboot."
  else
    fail "PM2 app '$APP_NAME' was not created."
  fi
}

show_summary() {
  local allowlist_path="${TG_ALLOWLIST_FILE:-${TG_DATA_DIR:-$HOME/.claude}/telegram-allowlist.json}"

  printf '\n'
  log "Setup completed successfully."
  log "App name: $APP_NAME"
  log "Provider: $SELECTED_PROVIDER"
  log "Environment file: $ENV_FILE"
  log "Allowlist file: $allowlist_path"

  if [[ "$SKIP_PM2_START" == "0" ]]; then
    log "Current PM2 status:"
    pm2 status "$APP_NAME" || true
  else
    log "To start the app later: npm run pm2:start"
  fi

  if [[ -z "$OPENAI_KEY" ]]; then
    warn "OPENAI_API_KEY is not set. TTS will stay disabled until you set it."
  fi

  if [[ -z "$ADMIN_TELEGRAM_ID" ]]; then
    warn "No admin Telegram ID was added. Pairing flow will be required on first use."
  fi
}

main() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --non-interactive)
        NON_INTERACTIVE=1
        ;;
      --allow-pairing)
        ALLOW_EMPTY_ADMIN_ID=1
        ;;
      --no-pm2-start)
        SKIP_PM2_START=1
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        fail "Unknown option: $1 (use --help)"
        ;;
    esac
    shift
  done

  log "Starting full setup"
  require_macos
  load_existing_env
  load_brew_shellenv
  ensure_homebrew
  load_brew_shellenv
  ensure_node_and_npm
  ensure_pm2
  ensure_voice_dependencies
  ensure_ai_cli
  choose_provider

  BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
  if [[ "$BOT_TOKEN" == "replace_with_bot_token" || "$BOT_TOKEN" == "your_telegram_bot_token_here" ]]; then
    BOT_TOKEN=""
  fi
  prompt_value BOT_TOKEN "Telegram bot token" 1 "" 1

  ADMIN_TELEGRAM_ID="${SETUP_ADMIN_TELEGRAM_ID:-${TG_ADMIN_TELEGRAM_ID:-}}"
  if [[ "$ALLOW_EMPTY_ADMIN_ID" == "0" ]]; then
    prompt_value ADMIN_TELEGRAM_ID "Admin Telegram user ID (numeric)" 1 "" 0
  else
    prompt_value ADMIN_TELEGRAM_ID "Admin Telegram user ID (optional, numeric)" 0 "" 0
  fi

  OPENAI_KEY="${OPENAI_API_KEY:-}"
  if [[ "$OPENAI_KEY" == "replace_with_api_key" || "$OPENAI_KEY" == "your_api_key_here" ]]; then
    OPENAI_KEY=""
  fi
  prompt_value OPENAI_KEY "OpenAI API key for TTS (optional)" 0 "$OPENAI_KEY" 1

  ENABLE_DANGEROUS_COMMANDS="$(parse_bool "${TG_ENABLE_DANGEROUS_COMMANDS:-}")"
  prompt_yes_no ENABLE_DANGEROUS_COMMANDS "Enable dangerous admin commands" "true"

  validate_required_inputs
  prepare_env_file
  install_project_dependencies
  write_gateway_provider_config "$SELECTED_PROVIDER"
  init_storage_files
  run_quality_checks
  start_pm2_app
  show_summary
}

main "$@"
