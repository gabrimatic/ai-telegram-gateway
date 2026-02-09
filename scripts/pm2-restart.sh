#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${TG_PM2_APP_NAME:-telegram-gateway}"

if ! command -v pm2 >/dev/null 2>&1; then
  echo "pm2 is not installed. Install it with: npm install -g pm2" >&2
  exit 1
fi

if ! pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  echo "PM2 app '$APP_NAME' was not found. Run: npm run pm2:start" >&2
  exit 1
fi

pm2 restart "$APP_NAME" --update-env
pm2 status "$APP_NAME"
