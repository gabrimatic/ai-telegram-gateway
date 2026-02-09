#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${TG_PM2_APP_NAME:-telegram-gateway}"

if ! command -v pm2 >/dev/null 2>&1; then
  echo "pm2 is not installed. Install it with: npm install -g pm2" >&2
  exit 1
fi

pm2 status "$APP_NAME"
