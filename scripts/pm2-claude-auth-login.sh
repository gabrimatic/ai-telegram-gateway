#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${TG_PM2_APP_NAME:-telegram-gateway}"

if ! command -v pm2 >/dev/null 2>&1; then
  echo "pm2 is not installed. Install it with: npm install -g pm2" >&2
  exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "claude CLI is not installed or not on PATH." >&2
  exit 1
fi

if ! pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  echo "PM2 app '$APP_NAME' was not found. Run: npm run pm2:start" >&2
  exit 1
fi

pm2_id="$(
  pm2 jlist | node -e '
    const fs = require("fs");
    const appName = process.argv[1];
    const list = JSON.parse(fs.readFileSync(0, "utf8"));
    const app = list.find((p) => p.name === appName);
    if (!app || app.pm_id === undefined || app.pm_id === null) process.exit(1);
    process.stdout.write(String(app.pm_id));
  ' "$APP_NAME"
)" || {
  echo "Could not resolve PM2 id for app '$APP_NAME'." >&2
  exit 1
}

pm2_home="$(pm2 env "$pm2_id" | awk -F': ' '$1=="HOME"{print $2; exit}')"
pm2_user="$(pm2 env "$pm2_id" | awk -F': ' '$1=="USER"{print $2; exit}')"
pm2_path="$(pm2 env "$pm2_id" | awk -F': ' '$1=="PATH"{print $2; exit}')"

clean_pm2_value() {
  # Strip ANSI escape sequences and surrounding whitespace.
  printf "%s" "$1" | perl -pe 's/\e\[[0-9;]*[A-Za-z]//g' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

pm2_home="$(clean_pm2_value "$pm2_home")"
pm2_user="$(clean_pm2_value "$pm2_user")"
pm2_path="$(clean_pm2_value "$pm2_path")"

if [ -z "$pm2_home" ] || [ -z "$pm2_path" ]; then
  echo "Could not resolve PM2 runtime HOME/PATH for '$APP_NAME'." >&2
  exit 1
fi

echo "Opening Claude login in PM2 context"
echo "app=$APP_NAME pm2_id=$pm2_id user=${pm2_user:-unknown} home=$pm2_home"

HOME="$pm2_home" USER="${pm2_user:-${USER:-}}" LOGNAME="${pm2_user:-${LOGNAME:-}}" PATH="$pm2_path" \
  claude auth login
