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
  local timeout="${1:-90}"
  local end=$((SECONDS + timeout))
  local status=""

  while (( SECONDS < end )); do
    if status="$(pm2_field "pm2_env.status" 2>/dev/null)" && [ "$status" = "online" ]; then
      return 0
    fi
    sleep 1
  done

  echo "PM2 app '$APP_NAME' did not reach online state within ${timeout}s." >&2
  pm2 status "$APP_NAME" || true
  return 1
}

echo "[pm2-daemon] ensure app running"
"$ROOT_DIR/scripts/pm2-start.sh" >/dev/null
wait_for_online 60

echo "[pm2-daemon] save process list"
pm2 save >/dev/null

echo "[pm2-daemon] restart PM2 daemon"
pm2 kill >/dev/null
pm2 resurrect >/dev/null

wait_for_online 90

STATUS="$(pm2_field "pm2_env.status")"
PID="$(pm2_field "pid")"
echo "[pm2-daemon] status=$STATUS pid=$PID"
echo "[pm2-daemon] ok"
