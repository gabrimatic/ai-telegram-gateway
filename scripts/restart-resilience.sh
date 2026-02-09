#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

APP_NAME="${TG_PM2_APP_NAME:-telegram-gateway}"

pm2_field() {
  local field="$1"
  pm2 jlist | node -e '
const fs = require("fs");
const appName = process.argv[1];
const fieldPath = process.argv[2];
const data = JSON.parse(fs.readFileSync(0, "utf8") || "[]");
const app = data.find((item) => item.name === appName);
if (!app) process.exit(2);
const value = fieldPath.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), app);
if (value == null) process.exit(3);
process.stdout.write(String(value));
' "$APP_NAME" "$field"
}

wait_for_online() {
  local timeout="${1:-60}"
  local end=$((SECONDS + timeout))
  local status=""

  while (( SECONDS < end )); do
    if status="$(pm2_field "pm2_env.status" 2>/dev/null)" && [ "$status" = "online" ]; then
      return 0
    fi
    sleep 1
  done

  echo "PM2 app '$APP_NAME' did not recover to online state within ${timeout}s." >&2
  pm2 status "$APP_NAME" || true
  return 1
}

if ! command -v pm2 >/dev/null 2>&1; then
  echo "pm2 is not installed. Install it with: npm install -g pm2" >&2
  exit 1
fi

echo "[resilience] ensuring app is running"
"$ROOT_DIR/scripts/pm2-start.sh" >/dev/null
wait_for_online 45

BEFORE_RESTARTS="$(pm2_field "pm2_env.restart_time")"
BEFORE_PID="$(pm2_field "pid")"

if ! [[ "$BEFORE_PID" =~ ^[0-9]+$ ]] || [ "$BEFORE_PID" -le 0 ]; then
  echo "Invalid app PID: $BEFORE_PID" >&2
  exit 1
fi

echo "[resilience] killing pid $BEFORE_PID to trigger PM2 restart"
kill -9 "$BEFORE_PID"

wait_for_online 60

AFTER_RESTARTS="$(pm2_field "pm2_env.restart_time")"
AFTER_PID="$(pm2_field "pid")"
STATUS="$(pm2_field "pm2_env.status")"

if ! [[ "$AFTER_RESTARTS" =~ ^[0-9]+$ ]] || ! [[ "$BEFORE_RESTARTS" =~ ^[0-9]+$ ]]; then
  echo "Could not read PM2 restart counters." >&2
  exit 1
fi

if [ "$AFTER_RESTARTS" -le "$BEFORE_RESTARTS" ]; then
  echo "Restart counter did not increase ($BEFORE_RESTARTS -> $AFTER_RESTARTS)." >&2
  exit 1
fi

echo "[resilience] status=$STATUS restarts=$BEFORE_RESTARTS->$AFTER_RESTARTS pid=$BEFORE_PID->$AFTER_PID"
echo "[resilience] ok"
