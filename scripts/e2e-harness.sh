#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

APP_NAME="${TG_PM2_APP_NAME:-telegram-gateway}"
HEALTH_FILE="${TG_HEALTH_FILE:-$HOME/.claude/gateway/health.json}"

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
  local timeout="${1:-45}"
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

echo "[e2e] build + typecheck"
"$ROOT_DIR/scripts/build-typecheck.sh"

echo "[e2e] message flow (/stats -> processed -> expected output)"
node "$ROOT_DIR/scripts/e2e-message-flow.cjs"

echo "[e2e] pm2 start"
"$ROOT_DIR/scripts/pm2-start.sh"

echo "[e2e] waiting for online state"
wait_for_online 45

STATUS="$(pm2_field "pm2_env.status")"
PID="$(pm2_field "pid" || true)"
RESTARTS="$(pm2_field "pm2_env.restart_time" || true)"

echo "[e2e] status=$STATUS pid=${PID:-unknown} restarts=${RESTARTS:-unknown}"

if [ -f "$HEALTH_FILE" ]; then
  echo "[e2e] health file present: $HEALTH_FILE"
else
  echo "[e2e] health file not present yet: $HEALTH_FILE"
fi

echo "[e2e] tail logs"
pm2 logs "$APP_NAME" --lines 40 --nostream >/dev/null

echo "[e2e] done"
