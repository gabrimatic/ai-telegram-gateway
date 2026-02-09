#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

APP_NAME="${TG_PM2_APP_NAME:-telegram-gateway}"
LOG_DIR="${TG_LOG_DIR:-$HOME/.claude/logs/telegram-gateway}"

if ! command -v pm2 >/dev/null 2>&1; then
  echo "pm2 is not installed. Install it with: npm install -g pm2" >&2
  exit 1
fi

token_from_env_file=""
if [ -f ".env" ]; then
  token_from_env_file="$(awk -F= '/^TELEGRAM_BOT_TOKEN=/{gsub(/\r/, "", $2); print $2; exit}' .env)"
fi

if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] && [ -z "$token_from_env_file" ]; then
  echo "TELEGRAM_BOT_TOKEN is not set in the environment or .env file." >&2
  exit 1
fi

mkdir -p "$LOG_DIR"

if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  pm2 restart "$APP_NAME" --update-env
else
  pm2 start ecosystem.config.cjs --only "$APP_NAME" --update-env
fi

pm2 status "$APP_NAME"
